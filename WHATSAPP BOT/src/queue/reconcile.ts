import { pool, query } from '../db/pool.js';
import { logger } from '../logging/logger.js';
import { dispatchQueue } from './queues.js';
import { TIME_CRITICAL, type EventType } from '../templates/registry.js';
import { transition } from '../messages/repository.js';
import { orphansRequeued } from '../observability/metrics.js';

/**
 * ORPHAN RECONCILER
 *
 * A message is written to Postgres and then queued in Redis. Those are two
 * systems, so there is a window between them. If the process dies in that
 * window — or the enqueue itself throws — the row sits in QUEUED forever with
 * `attempts = 0` and no job behind it. Nothing retries it, nothing alerts, and
 * the guest simply never hears from the restaurant.
 *
 * This is the classic dual-write gap, and it is not hypothetical: it is exactly
 * what happened the first time this service was run against the demo, when
 * BullMQ rejected a job id containing a colon and five bookings were silently
 * stranded.
 *
 * The fix is not to make the two writes atomic — they cannot be. It is to make
 * the database the source of truth and treat Redis as a cache of pending work,
 * then periodically reconcile the two.
 */

const ORPHAN_AGE_SECONDS = 60;
const BATCH = 500;

interface OrphanRow {
  id: string;
  outlet_id: string;
  event_type: string;
}

export async function reconcileOrphanedMessages(): Promise<number> {
  const rows = await query<OrphanRow>(
    pool,
    `SELECT id, outlet_id, event_type
       FROM messages
      WHERE state = 'QUEUED'
        AND created_at < now() - ($1 || ' seconds')::interval
      ORDER BY created_at
      LIMIT ${BATCH}`,
    [String(ORPHAN_AGE_SECONDS)],
  );

  let requeued = 0;

  for (const row of rows) {
    const jobId = `msg-${row.id}`;

    // A job that still exists — waiting, delayed, active or recently completed —
    // is not an orphan. Only a missing job means nothing will ever pick this up.
    if (await dispatchQueue.getJob(jobId)) continue;

    const urgent = TIME_CRITICAL.has(row.event_type as EventType);

    try {
      await dispatchQueue.add(
        row.event_type,
        { messageId: row.id, outletId: row.outlet_id, urgent },
        { jobId, priority: urgent ? 1 : 10 },
      );
      requeued += 1;
      orphansRequeued.inc();
      logger.warn({ messageId: row.id, eventType: row.event_type }, 'orphaned message requeued');
    } catch (err) {
      // The enqueue is rejected outright — a malformed job id, say. Retrying
      // forever would just spin, so record it as failed and make it visible.
      await transition(row.id, 'FAILED', {
        actor: 'SYSTEM',
        reason: `could not be queued: ${(err as Error).message}`,
        errorCode: 'INTERNAL',
      });
      logger.error(
        { err, messageId: row.id, eventType: row.event_type },
        'orphaned message could not be requeued — marked FAILED',
      );
    }
  }

  return requeued;
}
