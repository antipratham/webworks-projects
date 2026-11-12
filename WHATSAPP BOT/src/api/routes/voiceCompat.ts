import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localeSchema } from '../../templates/registry.js';
import { AppError } from '../../domain/errors.js';
import { enqueueNotification } from '../../notifications/service.js';
import { findReplay, hashRequest, storeResponse } from '../idempotency.js';
import { VOICE_TEMPLATES, mapVoiceTemplate } from '../../integrations/voiceTemplateMap.js';
import { requireKey, callerOf } from '../auth.js';

/**
 * HTTP surface for the voice platform contract. The translation itself lives in
 * src/integrations/voiceTemplateMap.ts, which imports nothing — so the mapping
 * can be unit-tested without opening a database connection.
 */

const bodySchema = z.object({
  phone: z.string().min(6).max(20),
  outlet_id: z.string().min(1).max(64),
  template: z.enum(VOICE_TEMPLATES),
  variables: z.record(z.string()).default({}),
  call_id: z.string().min(1).max(64).optional(),
  /** Not in the contract, but the backend has it and the timeline wants it. */
  language: localeSchema.optional(),
});

export async function voiceCompatRoutes(app: FastifyInstance) {
  // The contract carries no tenant because PLATFORM_TOKEN identifies it. That
  // is exactly what a per-tenant key is, so the two line up with no header
  // gymnastics: the key the voice platform holds names its tenant.
  app.addHook('preHandler', requireKey('INTAKE'));

  app.post('/messages/whatsapp', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) {
      throw new AppError(
        'IDEMPOTENCY_KEY_MISSING',
        'Send an Idempotency-Key header of at least 8 characters.',
      );
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('TEMPLATE_PARAMS_INVALID', 'Request body is not valid.', {
        fields: parsed.error.flatten().fieldErrors,
      });
    }
    const body = parsed.data;

    const tenantId = callerOf(req).tenantId;

    const requestHash = hashRequest(req.body);
    const replay = await findReplay(key, requestHash);
    if (replay) {
      reply.header('idempotent-replay', 'true');
      return reply.code(replay.code).send(replay.body);
    }

    const mapped = mapVoiceTemplate(body.template, body.variables, body.call_id);

    const result = await enqueueNotification({
      tenantId,
      outletId: body.outlet_id,
      eventType: mapped.eventType,
      phone: body.phone,
      params: mapped.params,
      ...(body.language ? { locale: body.language } : {}),
      ...(mapped.correlationId ? { correlationId: mapped.correlationId } : {}),
    });

    // Shaped as the contract's MessageReceipt, not as our own response.
    const receipt = {
      message_id: result.messageId,
      status: result.state,
      template: body.template,
    };

    await storeResponse(key, tenantId, requestHash, 202, receipt);
    return reply.code(202).send(receipt);
  });
}
