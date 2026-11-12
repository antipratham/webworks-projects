import crypto from 'node:crypto';
import { pool, one } from '../db/pool.js';
import { AppError } from '../domain/errors.js';

/**
 * Cross-cutting rule: any client-initiated write that may be retried carries an
 * idempotency key; replaying it returns the ORIGINAL result rather than creating
 * a duplicate.
 *
 * This matters more here than almost anywhere else in the platform. The staff
 * app queues writes offline and replays them when the network returns; if a
 * replayed "booking confirmed" event sent a second WhatsApp message, the guest
 * would see the restaurant double-messaging them for one booking.
 */

export function hashRequest(body: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export interface StoredResponse {
  code: number;
  body: unknown;
}

export async function findReplay(
  key: string,
  requestHash: string,
): Promise<StoredResponse | undefined> {
  const row = await one<{ request_hash: string; response_body: unknown; response_code: number }>(
    pool,
    `SELECT request_hash, response_body, response_code
       FROM idempotency_keys
      WHERE key = $1 AND expires_at > now()`,
    [key],
  );
  if (!row) return undefined;

  if (row.request_hash !== requestHash) {
    // Same key, different payload. This is a caller bug, and silently accepting
    // it would send the wrong message to the wrong guest.
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used with a different request body.',
      { key },
    );
  }

  return { code: row.response_code, body: row.response_body };
}

export async function storeResponse(
  key: string,
  tenantId: string,
  requestHash: string,
  code: number,
  body: unknown,
): Promise<void> {
  await pool.query(
    `INSERT INTO idempotency_keys (key, tenant_id, request_hash, response_code, response_body)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (key) DO NOTHING`,
    [key, tenantId, requestHash, code, JSON.stringify(body)],
  );
}
