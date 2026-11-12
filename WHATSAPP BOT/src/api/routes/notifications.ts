import type { FastifyInstance } from 'fastify';
import { AppError } from '../../domain/errors.js';
import {
  enqueueNotification,
  notificationWireSchema,
} from '../../notifications/service.js';
import {
  cancelScheduled,
  scheduleBookingReminders,
  scheduleFeedbackRequest,
} from '../../queue/scheduler.js';
import { upsertConsent } from '../../policy/consent.js';
import { findReplay, hashRequest, storeResponse } from '../idempotency.js';
import { requireKey, tenantOf } from '../auth.js';
import { toE164 } from '../../domain/phone.js';
import { z } from 'zod';
import { localeSchema } from '../../templates/registry.js';

/**
 * The intake API. The Restaurant OS backend is the only caller.
 *
 * Note what is NOT here: no endpoint lets a caller name a WhatsApp template, and
 * none lets a caller bypass the consent gate. Those are the two doors that, left
 * open, turn a compliant sender into a suspended one.
 */
export async function notificationRoutes(app: FastifyInstance) {
  // The key identifies the tenant. Handlers never trust a tenantId from a body;
  // where one is sent it is checked against the key and rejected on mismatch.
  app.addHook('preHandler', requireKey('INTAKE'));

  /** Send one message now, or at `scheduledFor`. */
  app.post('/v1/notifications', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) {
      throw new AppError(
        'IDEMPOTENCY_KEY_MISSING',
        'Send an Idempotency-Key header of at least 8 characters.',
      );
    }

    const parsed = notificationWireSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError('TEMPLATE_PARAMS_INVALID', 'Request body is not valid.', {
        fields: parsed.error.flatten().fieldErrors,
      });
    }

    const requestHash = hashRequest(req.body);
    const replay = await findReplay(key, requestHash);
    if (replay) {
      reply.header('idempotent-replay', 'true');
      return reply.code(replay.code).send(replay.body);
    }

    const tenantId = tenantOf(req, parsed.data.tenantId);
    const result = await enqueueNotification({ ...parsed.data, tenantId });
    await storeResponse(key, tenantId, requestHash, 202, result);
    return reply.code(202).send(result);
  });

  /**
   * Booking lifecycle. One call sets up both reminders; the same call on a
   * changed booking replaces them, because `schedule` supersedes in place.
   */
  const remindersSchema = z.object({
    tenantId: z.string().uuid().optional(),
    outletId: z.string().min(1),
    bookingId: z.string().min(1),
    reservationAt: z.string().datetime(),
    phone: z.string().min(6),
    locale: localeSchema.optional(),
    params: z.record(z.unknown()),
  });

  app.post('/v1/bookings/reminders', async (req, reply) => {
    const body = remindersSchema.parse(req.body);
    const tenantId = tenantOf(req, body.tenantId);
    await scheduleBookingReminders({
      tenantId,
      outletId: body.outletId,
      bookingId: body.bookingId,
      reservationAt: new Date(body.reservationAt),
      request: {
        tenantId,
        outletId: body.outletId,
        phone: body.phone,
        params: body.params,
        correlationId: body.bookingId,
        ...(body.locale ? { locale: body.locale } : {}),
      },
    });
    return reply.code(202).send({ scheduled: ['BOOKING_REMINDER_T24', 'BOOKING_REMINDER_T2'] });
  });

  /**
   * Called on CANCELLED, SEATED, NO_SHOW or COMPLETED. A guest sitting at the
   * table does not want a reminder that they have a table.
   */
  app.post('/v1/bookings/:bookingId/cancel-reminders', async (req, reply) => {
    const { bookingId } = req.params as { bookingId: string };
    const cancelled = await cancelScheduled('BOOKING', bookingId);
    return reply.send({ cancelled });
  });

  /** Visit completed. The feedback nudge fires 12 hours later. */
  const feedbackSchema = z.object({
    tenantId: z.string().uuid().optional(),
    outletId: z.string().min(1),
    visitId: z.string().min(1),
    completedAt: z.string().datetime(),
    phone: z.string().min(6),
    locale: localeSchema.optional(),
    params: z.record(z.unknown()),
  });

  app.post('/v1/visits/completed', async (req, reply) => {
    const body = feedbackSchema.parse(req.body);
    const tenantId = tenantOf(req, body.tenantId);
    await scheduleFeedbackRequest({
      tenantId,
      outletId: body.outletId,
      visitId: body.visitId,
      completedAt: new Date(body.completedAt),
      request: {
        tenantId,
        outletId: body.outletId,
        phone: body.phone,
        params: { ...body.params, visitId: body.visitId },
        correlationId: body.visitId,
        ...(body.locale ? { locale: body.locale } : {}),
      },
    });
    return reply.code(202).send({ scheduled: 'FEEDBACK_REQUEST', delayHours: 12 });
  });

  /**
   * Consent mirror. The Restaurant OS backend pushes every change here the
   * moment it happens — "immediate effect across every sender" is the spec's
   * wording, and a nightly sync would not meet it.
   */
  const consentSchema = z.object({
    tenantId: z.string().uuid().optional(),
    phone: z.string().min(6),
    state: z.enum(['GRANTED', 'DENIED', 'WITHDRAWN', 'UNKNOWN']),
    locale: localeSchema.optional(),
  });

  app.put('/v1/consent', async (req, reply) => {
    const body = consentSchema.parse(req.body);
    await upsertConsent({
      tenantId: tenantOf(req, body.tenantId),
      phoneE164: toE164(body.phone),
      state: body.state,
      ...(body.locale ? { locale: body.locale } : {}),
    });
    return reply.send({ ok: true });
  });
}
