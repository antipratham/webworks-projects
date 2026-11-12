import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { upsertCredentials } from '../../tenancy/credentials.js';
import { pool, one } from '../../db/pool.js';
import { requireKey, callerOf, tenantOf } from '../auth.js';

/**
 * Provisioning, called by the WebWorks Admin Console after a restaurant
 * completes Embedded Signup and on every token rotation.
 *
 * There is deliberately no GET that returns a token: once sealed, a credential
 * leaves this service only inside the dispatcher.
 */
export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireKey('ADMIN'));

  const outletSchema = z.object({
    tenantId: z.string().uuid().optional(),
    externalId: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    timezone: z.string().min(1).max(64).default('Asia/Kolkata'),
  });

  app.post('/admin/v1/outlets', async (req, reply) => {
    const body = outletSchema.parse(req.body);
    const row = await one<{ id: string }>(
      pool,
      `INSERT INTO outlets (tenant_id, external_id, name, timezone)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, external_id) DO UPDATE
         SET name = EXCLUDED.name, timezone = EXCLUDED.timezone
       RETURNING id`,
      [tenantOf(req, body.tenantId), body.externalId, body.name, body.timezone],
    );
    return reply.code(201).send({ outletId: row!.id });
  });

  const credsSchema = z.object({
    outletId: z.string().uuid(),
    wabaId: z.string().min(1),
    phoneNumberId: z.string().min(1),
    displayNumber: z.string().min(1),
    accessToken: z.string().min(20),
    messagingTier: z
      .enum(['TIER_250', 'TIER_1K', 'TIER_10K', 'TIER_100K', 'UNLIMITED'])
      .optional(),
    actor: z.string().min(1),
  });

  app.put('/admin/v1/credentials', async (req, reply) => {
    const body = credsSchema.parse(req.body);

    // The outlet must belong to the calling key's tenant.
    const owned = await one<{ id: string }>(
      pool,
      `SELECT id FROM outlets WHERE id = $1 AND tenant_id = $2`,
      [body.outletId, callerOf(req).tenantId],
    );
    if (!owned) throw new AppError('FORBIDDEN', 'That outlet belongs to another tenant.');

    await upsertCredentials({
      outletId: body.outletId,
      wabaId: body.wabaId,
      phoneNumberId: body.phoneNumberId,
      displayNumber: body.displayNumber,
      accessToken: body.accessToken,
      actor: body.actor,
      ...(body.messagingTier ? { messagingTier: body.messagingTier } : {}),
    });
    return reply.send({ ok: true });
  });

  /** Delivery view for the owner dashboard. No message bodies, no tokens. */
  app.get('/admin/v1/messages', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const rows = await pool.query(
      `SELECT id, event_type, category, state, locale, template_name,
              correlation_type, correlation_id, campaign_id,
              created_at, sent_at, terminal_at, error_code
         FROM messages
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR state = $2)
          AND ($3::text IS NULL OR correlation_id = $3)
        ORDER BY created_at DESC
        LIMIT 200`,
      [tenantOf(req, q.tenantId), q.state ?? null, q.correlationId ?? null],
    );
    return reply.send({ messages: rows.rows });
  });
}
