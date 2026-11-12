import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { toE164 } from '../../domain/phone.js';
import { pool, query } from '../../db/pool.js';
import { assertBootstrapKey, issueKey, listKeys, revokeKey } from '../../tenancy/apiKeys.js';
import { eraseGuest, phoneDigest } from '../../retention/retention.js';
import { requireKey, callerOf, tenantOf } from '../auth.js';

/**
 * Key management and the right to erasure.
 *
 * These are the two operations a restaurant's legal and security posture rests
 * on, so they are together and they are both fully audited.
 */
export async function governanceRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------- API keys --

  /**
   * Mints a tenant's first key. Authenticated by the bootstrap secret, which
   * can do this and nothing else — it cannot send a message or read a guest.
   */
  const bootstrapSchema = z.object({
    tenantId: z.string().uuid(),
    name: z.string().min(1).max(80),
    scope: z.enum(['INTAKE', 'ADMIN']).default('ADMIN'),
    createdBy: z.string().min(1).max(120),
  });

  app.post('/admin/v1/keys/bootstrap', async (req, reply) => {
    assertBootstrapKey(req.headers.authorization, config.BOOTSTRAP_ADMIN_KEY);
    const body = bootstrapSchema.parse(req.body);

    const issued = await issueKey({
      tenantId: body.tenantId,
      name: body.name,
      scope: body.scope,
      createdBy: body.createdBy,
    });

    return reply.code(201).send({
      ...issued,
      warning: 'This key is shown once and cannot be retrieved again.',
    });
  });

  /** A tenant's admin key mints its own further keys. */
  const keySchema = z.object({
    name: z.string().min(1).max(80),
    scope: z.enum(['INTAKE', 'ADMIN']).default('INTAKE'),
    expiresAt: z.string().datetime().optional(),
  });

  app.post('/admin/v1/keys', { preHandler: requireKey('ADMIN') }, async (req, reply) => {
    const body = keySchema.parse(req.body);
    const caller = callerOf(req);

    const issued = await issueKey({
      tenantId: caller.tenantId,
      name: body.name,
      scope: body.scope,
      createdBy: `key:${caller.keyId}`,
      ...(body.expiresAt ? { expiresAt: new Date(body.expiresAt) } : {}),
    });

    return reply.code(201).send({
      ...issued,
      warning: 'This key is shown once and cannot be retrieved again.',
    });
  });

  /** Prefixes and usage only — there is no stored secret to return. */
  app.get('/admin/v1/keys', { preHandler: requireKey('ADMIN') }, async (req, reply) => {
    return reply.send({ keys: await listKeys(callerOf(req).tenantId) });
  });

  app.delete('/admin/v1/keys/:keyId', { preHandler: requireKey('ADMIN') }, async (req, reply) => {
    const { keyId } = req.params as { keyId: string };
    const caller = callerOf(req);

    // Scope the revoke to the caller's own tenant.
    const owned = await query<{ id: string }>(
      pool,
      `SELECT id FROM api_keys WHERE id = $1 AND tenant_id = $2`,
      [keyId, caller.tenantId],
    );
    if (owned.length === 0) throw new AppError('FORBIDDEN', 'No such key for this tenant.');

    const revoked = await revokeKey(keyId, `key:${caller.keyId}`);
    return reply.send({ revoked });
  });

  // -------------------------------------------------------------- erasure --

  /**
   * Right to erasure, executed synchronously.
   *
   * The spec allows seven days. Doing it on request costs nothing extra and
   * means there is never a backlog to prove you cleared.
   */
  const erasureSchema = z.object({
    tenantId: z.string().uuid().optional(),
    phone: z.string().min(6).max(20),
    requestedBy: z.string().min(1).max(120),
    reason: z.string().max(500).optional(),
  });

  app.post('/v1/privacy/erasure', { preHandler: requireKey('ADMIN') }, async (req, reply) => {
    const body = erasureSchema.parse(req.body);
    const tenantId = tenantOf(req, body.tenantId);

    const result = await eraseGuest({
      tenantId,
      phoneE164: toE164(body.phone),
      requestedBy: body.requestedBy,
      ...(body.reason ? { reason: body.reason } : {}),
    });

    return reply.send({
      ...result,
      completedAt: new Date().toISOString(),
      note: 'Records are retained with guest identifiers replaced by a keyed pseudonym; scheduled sends are cancelled.',
    });
  });

  /**
   * Proof for a guest or a regulator that an erasure happened, without the
   * service holding the number to look it up by. The caller supplies the
   * number, we hash it, and match on the hash.
   */
  app.get('/v1/privacy/erasure', { preHandler: requireKey('ADMIN') }, async (req, reply) => {
    const q = req.query as { phone?: string };
    if (!q.phone) throw new AppError('PHONE_INVALID', 'phone is required.');

    const rows = await query(
      pool,
      `SELECT id, requested_by, reason, requested_at, completed_at,
              messages_redacted, sessions_redacted, consent_deleted
         FROM erasure_requests
        WHERE tenant_id = $1 AND phone_sha256 = $2
        ORDER BY requested_at DESC`,
      [tenantOf(req), phoneDigest(toE164(q.phone))],
    );
    return reply.send({ requests: rows });
  });

  // ------------------------------------------------- why a send was held --

  /** Answers "why did this guest not get their reminder?" */
  app.get('/v1/suppressed', { preHandler: requireKey() }, async (req, reply) => {
    const q = req.query as { phone?: string; rule?: string; limit?: string };
    const rows = await query(
      pool,
      `SELECT event_type, category, rule, reason, correlation_id, campaign_id, occurred_at
         FROM suppressed_sends
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR phone_e164 = $2)
          AND ($3::text IS NULL OR rule = $3)
        ORDER BY occurred_at DESC
        LIMIT LEAST($4::int, 500)`,
      [
        tenantOf(req),
        q.phone ? toE164(q.phone) : null,
        q.rule ?? null,
        Number(q.limit ?? 100),
      ],
    );
    return reply.send({ suppressed: rows });
  });
}
