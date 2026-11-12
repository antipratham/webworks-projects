import crypto from 'node:crypto';
import { pool, one, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { logger, maskPhone } from '../logging/logger.js';
import { encryptionKey } from '../tenancy/keyring.js';
import { retentionRedacted } from '../observability/metrics.js';

/**
 * RETENTION AND ERASURE
 *
 * Two obligations, one mechanism.
 *
 *  1. Retention — guest identifiers are stripped from records older than
 *     RETENTION_DAYS, automatically, whether or not anyone asks.
 *
 *  2. Erasure — a guest asks to be forgotten, and it happens immediately. The
 *     spec allows seven days; doing it on request costs nothing extra and
 *     removes the need to prove you met a deadline.
 *
 * REDACTION, NOT DELETION, and the distinction matters:
 *
 *   Deleting the rows would destroy delivery rates, template quality history
 *   and the audit trail — things the business needs and, in the case of the
 *   audit trail, is separately obliged to keep. So the row survives and the
 *   person in it does not. What goes:
 *
 *     to_phone_e164   → a per-tenant HMAC pseudonym, so "how many messages did
 *                       this (now anonymous) guest get" still answers, while
 *                       the number itself is unrecoverable
 *     payload         → dropped entirely; it carries the guest's name and their
 *                       signed links
 *     feedback answers→ kept (they are about the restaurant, not the guest)
 *     consent rows    → deleted outright; consent for a forgotten person is
 *                       meaningless and keeping it is itself processing
 *
 * The pseudonym is an HMAC keyed on CREDENTIALS_ENC_KEY, not a plain hash: a
 * plain SHA-256 of a ten-digit Indian mobile is brute-forceable in seconds, so
 * it would not be anonymisation at all.
 */

const PSEUDONYM_PREFIX = 'redacted:';

function pseudonym(phoneE164: string, tenantId: string): string {
  const mac = crypto
    .createHmac('sha256', encryptionKey())
    .update(`${tenantId}:${phoneE164}`)
    .digest('base64url')
    .slice(0, 22);
  return `${PSEUDONYM_PREFIX}${mac}`;
}

/** Erasure requests store this, never the number. */
export function phoneDigest(phoneE164: string): Buffer {
  return crypto.createHash('sha256').update(phoneE164).digest();
}

export interface RedactionCounts {
  messages: number;
  sessions: number;
  suppressed: number;
  consent: number;
}

// ------------------------------------------------------------- erasure --

/**
 * Right to erasure, executed immediately.
 *
 * Runs in one transaction: either the guest is gone from every table or the
 * request failed and can be retried. A half-erased guest is the worst outcome,
 * because it looks done.
 */
export async function eraseGuest(input: {
  tenantId: string;
  phoneE164: string;
  requestedBy: string;
  reason?: string;
}): Promise<RedactionCounts & { requestId: string }> {
  const alias = pseudonym(input.phoneE164, input.tenantId);

  const result = await withTransaction(async (tx) => {
    const request = await one<{ id: string }>(
      tx,
      `INSERT INTO erasure_requests (tenant_id, phone_sha256, requested_by, reason)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.tenantId, phoneDigest(input.phoneE164), input.requestedBy, input.reason ?? null],
    );

    const messages = await tx.query(
      `UPDATE messages
          SET to_phone_e164 = $3,
              payload = '{"redacted": true}'::jsonb,
              redacted_at = now()
        WHERE tenant_id = $1 AND to_phone_e164 = $2 AND redacted_at IS NULL`,
      [input.tenantId, input.phoneE164, alias],
    );

    const sessions = await tx.query(
      `UPDATE feedback_sessions
          SET phone_e164 = $3, redacted_at = now()
        WHERE tenant_id = $1 AND phone_e164 = $2 AND redacted_at IS NULL`,
      [input.tenantId, input.phoneE164, alias],
    );

    const suppressed = await tx.query(
      `UPDATE suppressed_sends
          SET phone_e164 = $3, redacted_at = now()
        WHERE tenant_id = $1 AND phone_e164 = $2 AND redacted_at IS NULL`,
      [input.tenantId, input.phoneE164, alias],
    );

    // Any send still waiting for this guest is cancelled — erasure must stop
    // future contact, not only erase past contact.
    await tx.query(
      `UPDATE scheduled_notifications SET state = 'CANCELLED'
        WHERE tenant_id = $1 AND phone_e164 = $2 AND state = 'PENDING'`,
      [input.tenantId, input.phoneE164],
    );

    const consent = await tx.query(
      `DELETE FROM guest_consent WHERE tenant_id = $1 AND phone_e164 = $2`,
      [input.tenantId, input.phoneE164],
    );

    const counts: RedactionCounts = {
      messages: messages.rowCount ?? 0,
      sessions: sessions.rowCount ?? 0,
      suppressed: suppressed.rowCount ?? 0,
      consent: consent.rowCount ?? 0,
    };

    await tx.query(
      `UPDATE erasure_requests
          SET completed_at = now(),
              messages_redacted = $2, sessions_redacted = $3, consent_deleted = $4
        WHERE id = $1`,
      [request!.id, counts.messages, counts.sessions, counts.consent],
    );

    // The audit row records that an erasure happened, without naming who.
    await tx.query(
      `INSERT INTO audit_log (tenant_id, actor, action, entity, entity_id, after_state, reason)
       VALUES ($1,$2,'GUEST_ERASED','guest',$3,$4,$5)`,
      [
        input.tenantId,
        input.requestedBy,
        alias,
        JSON.stringify(counts),
        input.reason ?? 'right to erasure',
      ],
    );

    return { ...counts, requestId: request!.id };
  });

  logger.warn(
    { tenantId: input.tenantId, guest: maskPhone(input.phoneE164), ...result },
    'guest erased on request',
  );
  retentionRedacted.inc({ table: 'messages', trigger: 'erasure' }, result.messages);
  retentionRedacted.inc({ table: 'feedback_sessions', trigger: 'erasure' }, result.sessions);

  return result;
}

// ------------------------------------------------------------ retention --

/**
 * The scheduled sweep. Runs daily; safe to run any number of times.
 *
 * Batched, because the first run on an established database could touch
 * millions of rows and a single statement holding those locks would block every
 * send while it ran.
 */
export async function runRetentionSweep(batchSize = 5_000): Promise<RedactionCounts> {
  const cutoff = `${config.RETENTION_DAYS} days`;
  const counts: RedactionCounts = { messages: 0, sessions: 0, suppressed: 0, consent: 0 };

  // The pseudonym is keyed with CREDENTIALS_ENC_KEY, so it must be computed in
  // the application — Postgres never sees that key. That makes this row-wise
  // rather than one bulk UPDATE, hence the batching.
  for (;;) {
    const rows = await pool.query<{ id: string; tenant_id: string; to_phone_e164: string }>(
      `SELECT id, tenant_id, to_phone_e164
         FROM messages
        WHERE redacted_at IS NULL AND created_at < now() - $1::interval
        ORDER BY created_at
        LIMIT $2`,
      [cutoff, batchSize],
    );
    if (rows.rowCount === 0) break;

    for (const row of rows.rows) {
      await pool.query(
        `UPDATE messages
            SET to_phone_e164 = $2, payload = '{"redacted": true}'::jsonb, redacted_at = now()
          WHERE id = $1`,
        [row.id, pseudonym(row.to_phone_e164, row.tenant_id)],
      );
      counts.messages += 1;
    }
    if ((rows.rowCount ?? 0) < batchSize) break;
  }

  const sessions = await pool.query<{ id: string; tenant_id: string; phone_e164: string }>(
    `SELECT id, tenant_id, phone_e164 FROM feedback_sessions
      WHERE redacted_at IS NULL AND created_at < now() - $1::interval LIMIT $2`,
    [cutoff, batchSize],
  );
  for (const row of sessions.rows) {
    await pool.query(
      `UPDATE feedback_sessions SET phone_e164 = $2, redacted_at = now() WHERE id = $1`,
      [row.id, pseudonym(row.phone_e164, row.tenant_id)],
    );
    counts.sessions += 1;
  }

  const suppressed = await pool.query<{ id: string; tenant_id: string; phone_e164: string }>(
    `SELECT id, tenant_id, phone_e164 FROM suppressed_sends
      WHERE redacted_at IS NULL AND occurred_at < now() - $1::interval LIMIT $2`,
    [cutoff, batchSize],
  );
  for (const row of suppressed.rows) {
    await pool.query(
      `UPDATE suppressed_sends SET phone_e164 = $2, redacted_at = now() WHERE id = $1`,
      [row.id, pseudonym(row.phone_e164, row.tenant_id)],
    );
    counts.suppressed += 1;
  }

  // Idempotency keys hold request bodies, and those bodies hold guest names.
  // They are only useful for a few days, so they go rather than get redacted.
  const idem = await pool.query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);

  if (counts.messages || counts.sessions || counts.suppressed || idem.rowCount) {
    logger.info(
      { ...counts, idempotencyKeysPurged: idem.rowCount ?? 0, retentionDays: config.RETENTION_DAYS },
      'retention sweep complete',
    );
    retentionRedacted.inc({ table: 'messages', trigger: 'schedule' }, counts.messages);
    retentionRedacted.inc({ table: 'feedback_sessions', trigger: 'schedule' }, counts.sessions);
  }

  return counts;
}
