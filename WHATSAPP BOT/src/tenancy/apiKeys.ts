import crypto from 'node:crypto';
import { pool, one, query } from '../db/pool.js';
import { AppError } from '../domain/errors.js';
import { logger } from '../logging/logger.js';

/**
 * PER-TENANT API KEYS
 *
 * One shared key for every restaurant is the worst credential in a multi-tenant
 * system: it cannot be rotated without coordinating every caller at once, its
 * leak is unbounded — the holder can message every restaurant's guests — and
 * nothing in the audit trail can tell you which caller did what.
 *
 * So each tenant gets its own, and the key carries the tenant identity. Callers
 * stop sending `tenantId` in the body entirely; the key decides, which removes
 * the class of bug where a caller sends the wrong one.
 *
 * Storage: the key is never written down. We keep SHA-256 of it, plus a short
 * public prefix so a lookup is one indexed read rather than a scan-and-compare
 * over every hash in the table.
 *
 *     rok_<prefix>_<secret>
 *          12 ch    43 ch
 *
 * The secret is shown exactly once, at creation. There is no endpoint that can
 * return it again, because there is nothing to return.
 */

const PREFIX_BYTES = 9; // → 12 base64url chars
const SECRET_BYTES = 32; // → 43 base64url chars

export type KeyScope = 'INTAKE' | 'ADMIN';

export interface AuthenticatedCaller {
  keyId: string;
  tenantId: string;
  scope: KeyScope;
  name: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hash(key: string): Buffer {
  return crypto.createHash('sha256').update(key).digest();
}

export interface IssuedKey {
  /** Shown once. Never recoverable. */
  key: string;
  keyId: string;
  prefix: string;
}

export async function issueKey(input: {
  tenantId: string;
  name: string;
  scope?: KeyScope;
  createdBy: string;
  expiresAt?: Date;
}): Promise<IssuedKey> {
  const prefix = b64url(crypto.randomBytes(PREFIX_BYTES));
  const secret = b64url(crypto.randomBytes(SECRET_BYTES));
  const key = `rok_${prefix}_${secret}`;

  const row = await one<{ id: string }>(
    pool,
    `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scope, created_by, expires_at)
     VALUES ($1,$2,$3,$4,COALESCE($5,'INTAKE'),$6,$7)
     RETURNING id`,
    [
      input.tenantId,
      input.name,
      prefix,
      hash(key),
      input.scope ?? null,
      input.createdBy,
      input.expiresAt?.toISOString() ?? null,
    ],
  );

  await pool.query(
    `INSERT INTO audit_log (tenant_id, actor, action, entity, entity_id, after_state, reason)
     VALUES ($1,$2,'API_KEY_ISSUED','api_key',$3,
             jsonb_build_object('name',$4::text,'scope',COALESCE($5::text,'INTAKE'),'prefix',$6::text),
             'key issued')`,
    [input.tenantId, input.createdBy, row!.id, input.name, input.scope ?? null, prefix],
  );

  logger.info({ tenantId: input.tenantId, keyId: row!.id, prefix }, 'api key issued');

  return { key, keyId: row!.id, prefix };
}

interface KeyRow {
  id: string;
  tenant_id: string;
  key_hash: Buffer;
  scope: KeyScope;
  name: string;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * Resolves a bearer token to its tenant, or throws.
 *
 * Constant-time on the hash comparison, and constant-ish on the miss path: an
 * unknown prefix still does the digest work before failing, so response timing
 * does not tell an attacker whether a prefix exists.
 */
export async function authenticate(bearer: string | undefined): Promise<AuthenticatedCaller> {
  const token = bearer?.startsWith('Bearer ') ? bearer.slice(7).trim() : undefined;
  const parts = token?.split('_');

  if (!token || parts?.length !== 3 || parts[0] !== 'rok') {
    throw new AppError('UNAUTHORIZED', 'Invalid or missing API key.');
  }

  const presented = hash(token);
  const row = await one<KeyRow>(
    pool,
    `SELECT id, tenant_id, key_hash, scope, name, expires_at, revoked_at
       FROM api_keys WHERE key_prefix = $1`,
    [parts[1]],
  );

  // Compare against a throwaway digest when the prefix is unknown, so both
  // paths do the same work.
  const stored = row?.key_hash ?? crypto.randomBytes(32);
  const matches = stored.length === presented.length && crypto.timingSafeEqual(stored, presented);

  if (!row || !matches) {
    throw new AppError('UNAUTHORIZED', 'Invalid or missing API key.');
  }
  if (row.revoked_at) {
    throw new AppError('UNAUTHORIZED', 'This API key has been revoked.');
  }
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    throw new AppError('UNAUTHORIZED', 'This API key has expired.');
  }

  // Best-effort; a failed touch must never fail the request.
  pool
    .query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id])
    .catch(() => {});

  return { keyId: row.id, tenantId: row.tenant_id, scope: row.scope, name: row.name };
}

export async function revokeKey(keyId: string, revokedBy: string): Promise<boolean> {
  const row = await one<{ tenant_id: string }>(
    pool,
    `UPDATE api_keys SET revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING tenant_id`,
    [keyId, revokedBy],
  );
  if (!row) return false;

  await pool.query(
    `INSERT INTO audit_log (tenant_id, actor, action, entity, entity_id, reason)
     VALUES ($1,$2,'API_KEY_REVOKED','api_key',$3,'key revoked')`,
    [row.tenant_id, revokedBy, keyId],
  );
  logger.warn({ keyId, revokedBy }, 'api key revoked');
  return true;
}

export async function listKeys(tenantId: string) {
  return query(
    pool,
    `SELECT id, name, key_prefix, scope, created_by, created_at,
            last_used_at, expires_at, revoked_at
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
}

/**
 * The one key not in the database: a bootstrap secret from the environment that
 * can only mint tenant keys. It exists because the first key has to come from
 * somewhere. It cannot send messages, cannot read guests, and should live in a
 * secret manager with a short rotation.
 */
export function assertBootstrapKey(bearer: string | undefined, expected: string): void {
  const token = bearer?.startsWith('Bearer ') ? bearer.slice(7).trim() : '';
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new AppError('UNAUTHORIZED', 'Invalid bootstrap key.');
  }
}
