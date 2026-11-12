import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireKey, tenantOf } from '../auth.js';
import {
  attributeBooking,
  buildCampaign,
  campaignReport,
  cancelCampaign,
  pauseCampaign,
  startCampaign,
} from '../../campaigns/service.js';

/**
 * Campaigns.
 *
 * Build and send are separate calls on purpose: the build resolves the audience
 * and reports what it would cost, and nothing leaves until someone starts it.
 * An owner should never discover the size of a send from the invoice.
 */
export async function campaignRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireKey('INTAKE'));

  const buildSchema = z.object({
    tenantId: z.string().uuid().optional(),
    outletId: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    templateName: z.string().min(1).max(120),
    bodyParams: z.array(z.string().max(200)).max(10).optional(),
    urlSuffix: z.string().max(120).optional(),
    audience: z
      .array(
        z.object({
          phone: z.string().min(6).max(20),
          bodyParams: z.array(z.string().max(200)).max(10).optional(),
          urlSuffix: z.string().max(120).optional(),
        }),
      )
      .min(1)
      .max(50_000),
    sendRatePerMinute: z.number().int().min(1).max(6000).optional(),
    scheduledFor: z.string().datetime().optional(),
    createdBy: z.string().min(1).max(120),
  });

  /** Resolves the audience and returns the cost. Sends nothing. */
  app.post('/v1/campaigns', async (req, reply) => {
    const body = buildSchema.parse(req.body);
    const result = await buildCampaign({
      tenantId: tenantOf(req, body.tenantId),
      outletId: body.outletId,
      name: body.name,
      templateName: body.templateName,
      audience: body.audience,
      createdBy: body.createdBy,
      ...(body.bodyParams ? { bodyParams: body.bodyParams } : {}),
      ...(body.urlSuffix ? { urlSuffix: body.urlSuffix } : {}),
      ...(body.sendRatePerMinute ? { sendRatePerMinute: body.sendRatePerMinute } : {}),
      ...(body.scheduledFor ? { scheduledFor: new Date(body.scheduledFor) } : {}),
    });

    return reply.code(201).send({
      ...result,
      note:
        'Nothing has been sent. `messageable` is the only number to quote — ' +
        '`total` includes guests the consent gate will refuse.',
    });
  });

  app.post('/v1/campaigns/:id/start', async (req, reply) => {
    const { id } = req.params as { id: string };
    await startCampaign(id, tenantOf(req));
    return reply.send({ state: 'SENDING' });
  });

  app.post('/v1/campaigns/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send({ paused: await pauseCampaign(id, tenantOf(req)) });
  });

  app.delete('/v1/campaigns/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send({ cancelled: await cancelCampaign(id, tenantOf(req)) });
  });

  app.get('/v1/campaigns/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(await campaignReport(id, tenantOf(req)));
  });

  /**
   * Attribution, written by the Restaurant OS when a booking follows a campaign
   * message. Recorded by the system that knows a booking happened, rather than
   * guessed here from timestamps.
   */
  const attributionSchema = z.object({
    tenantId: z.string().uuid().optional(),
    campaignId: z.string().uuid(),
    phone: z.string().min(6).max(20),
    bookingId: z.string().min(1).max(64),
    /** Money is in paise, as an integer. Never a float. */
    valuePaise: z.number().int().min(0).optional(),
  });

  app.post('/v1/campaigns/attribution', async (req, reply) => {
    const body = attributionSchema.parse(req.body);
    const { toE164 } = await import('../../domain/phone.js');

    const recorded = await attributeBooking({
      tenantId: tenantOf(req, body.tenantId),
      campaignId: body.campaignId,
      phoneE164: toE164(body.phone),
      bookingId: body.bookingId,
      ...(body.valuePaise !== undefined ? { valuePaise: body.valuePaise } : {}),
    });

    // Not an error when already recorded: the backend may retry.
    return reply.send({ recorded });
  });
}
