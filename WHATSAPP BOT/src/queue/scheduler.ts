import { Worker, type Job } from 'bullmq';
import { pool, one, withTransaction } from '../db/pool.js';
import { config, FEEDBACK_DELAY_HOURS } from '../config.js';
import { logger } from '../logging/logger.js';
import { connection, QUEUE_SCHEDULED, scheduledQueue, type ScheduledJob } from './queues.js';
import { enqueueNotification, type NotificationRequest } from '../notifications/service.js';
import { toE164 } from '../domain/phone.js';
import { getCredentialsByExternalId } from '../tenancy/credentials.js';
import type { EventType } from '../templates/registry.js';

/**
 * Deferred sends: the T-24h and T-2h reminders, and the T+12h feedback nudge.
 *
 * BullMQ holds the timer, but the `scheduled_notifications` table holds the
 * truth. That split matters because bookings change: when a guest moves their
 * table from 8pm to 9pm, the old reminders must die and new ones take their
 * place. Reconciling that against a Redis job id alone is how you end up sending
 * a reminder for a booking that no longer exists.
 *
 * The partial unique index on (correlation, event) WHERE state = 'PENDING'
 * enforces at most one live reminder of each kind per booking — in the database,
 * not in a code path someone can forget to call.
 */

interface ScheduleInput {
  tenantId: string;
  outletId: string;
  eventType: EventType;
  correlationType: string;
  correlationId: string;
  fireAt: Date;
  request: Omit<NotificationRequest, 'scheduledFor'>;
}

async function schedule(input: ScheduleInput): Promise<string | undefined> {
  // Nothing to do for a moment that has already passed.
  if (input.fireAt.getTime() <= Date.now()) {
    logger.debug(
      { eventType: input.eventType, correlationId: input.correlationId },
      'schedule skipped: fire time is in the past',
    );
    return undefined;
  }

  const id = await withTransaction(async (tx) => {
    // Supersede any live schedule of this kind for this booking.
    await tx.query(
      `UPDATE scheduled_notifications
          SET state = 'SUPERSEDED'
        WHERE correlation_type = $1 AND correlation_id = $2
          AND event_type = $3 AND state = 'PENDING'`,
      [input.correlationType, input.correlationId, input.eventType],
    );

    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO scheduled_notifications
         (tenant_id, outlet_id, event_type, correlation_type, correlation_id,
          fire_at, request, phone_e164)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        input.tenantId,
        input.outletId,
        input.eventType,
        input.correlationType,
        input.correlationId,
        input.fireAt.toISOString(),
        JSON.stringify(input.request),
        // Stored normalised so pacing and erasure can find it without parsing
        // the request payload.
        toE164(input.request.phone),
      ],
    );
    return row!.id;
  });

  await scheduledQueue.add(
    input.eventType,
    { scheduleId: id },
    { delay: input.fireAt.getTime() - Date.now(), jobId: `sched-${id}` },
  );

  await pool.query(`UPDATE scheduled_notifications SET job_id = $2 WHERE id = $1`, [
    id,
    `sched-${id}`,
  ]);

  return id;
}

/** T-24h and T-2h, per the spec's reminder rule. Past ones are simply skipped. */
export async function scheduleBookingReminders(input: {
  tenantId: string;
  /** The outlet id the Restaurant OS backend uses, not our internal uuid. */
  outletId: string;
  bookingId: string;
  reservationAt: Date;
  request: Omit<NotificationRequest, 'scheduledFor' | 'eventType'>;
}): Promise<void> {
  // Callers speak in external outlet ids; scheduled_notifications is keyed on
  // our own uuid. Resolving here means no caller can pass the wrong one.
  const creds = await getCredentialsByExternalId(input.tenantId, input.outletId);

  const plan: { event: EventType; at: Date }[] = [
    {
      event: 'BOOKING_REMINDER_T24',
      at: new Date(input.reservationAt.getTime() - 24 * 3600_000),
    },
    {
      event: 'BOOKING_REMINDER_T2',
      at: new Date(input.reservationAt.getTime() - 2 * 3600_000),
    },
  ];

  for (const step of plan) {
    await schedule({
      tenantId: creds.tenantId,
      outletId: creds.outletId,
      eventType: step.event,
      correlationType: 'BOOKING',
      correlationId: input.bookingId,
      fireAt: step.at,
      request: { ...input.request, eventType: step.event },
    });
  }
}

/**
 * Feedback goes out 12 hours after the visit completes — the guests have eaten
 * and gone home. Exactly one per visit; the unique index on feedback_sessions
 * is the backstop if this is ever called twice.
 */
export async function scheduleFeedbackRequest(input: {
  tenantId: string;
  /** The outlet id the Restaurant OS backend uses, not our internal uuid. */
  outletId: string;
  visitId: string;
  completedAt: Date;
  request: Omit<NotificationRequest, 'scheduledFor' | 'eventType'>;
}): Promise<void> {
  const creds = await getCredentialsByExternalId(input.tenantId, input.outletId);

  await schedule({
    tenantId: creds.tenantId,
    outletId: creds.outletId,
    eventType: 'FEEDBACK_REQUEST',
    correlationType: 'VISIT',
    correlationId: input.visitId,
    fireAt: new Date(input.completedAt.getTime() + FEEDBACK_DELAY_HOURS * 3600_000),
    request: { ...input.request, eventType: 'FEEDBACK_REQUEST' },
  });
}

/**
 * Called when a booking is cancelled, moved, seated or marked no-show. A guest
 * who already sat down does not need a "see you in 2 hours" reminder.
 */
export async function cancelScheduled(
  correlationType: string,
  correlationId: string,
  eventType?: EventType,
): Promise<number> {
  const rows = await withTransaction(async (tx) => {
    const res = await tx.query<{ id: string; job_id: string | null }>(
      `UPDATE scheduled_notifications
          SET state = 'CANCELLED'
        WHERE correlation_type = $1 AND correlation_id = $2
          AND state = 'PENDING'
          AND ($3::text IS NULL OR event_type = $3)
      RETURNING id, job_id`,
      [correlationType, correlationId, eventType ?? null],
    );
    return res.rows;
  });

  for (const row of rows) {
    if (!row.job_id) continue;
    const job = await scheduledQueue.getJob(row.job_id);
    await job?.remove().catch(() => {
      // A job mid-flight cannot be removed; the PENDING check at fire time
      // catches it instead. This is why the table, not Redis, is the truth.
    });
  }

  if (rows.length) {
    logger.info({ correlationType, correlationId, cancelled: rows.length }, 'schedules cancelled');
  }
  return rows.length;
}

export function startScheduledWorker() {
  const worker = new Worker<ScheduledJob>(
    QUEUE_SCHEDULED,
    async (job: Job<ScheduledJob>) => {
      const row = await one<{
        id: string;
        state: string;
        request: NotificationRequest;
      }>(pool, `SELECT id, state, request FROM scheduled_notifications WHERE id = $1`, [
        job.data.scheduleId,
      ]);

      if (!row) return;

      // The booking changed after the timer was set. Do nothing, quietly.
      if (row.state !== 'PENDING') {
        logger.debug({ scheduleId: row.id, state: row.state }, 'scheduled send stood down');
        return;
      }

      await pool.query(`UPDATE scheduled_notifications SET state = 'FIRED' WHERE id = $1`, [
        row.id,
      ]);

      await enqueueNotification(row.request);
    },
    { connection, concurrency: 10 },
  );

  logger.info({ feedbackDelayHours: FEEDBACK_DELAY_HOURS }, 'scheduled worker started');
  return worker;
}

void config;
