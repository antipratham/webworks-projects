import { z } from 'zod';
import { pool, withTransaction } from '../db/pool.js';
import { AppError } from '../domain/errors.js';
import { toE164 } from '../domain/phone.js';
import { logger, maskPhone } from '../logging/logger.js';
import { createMessage } from '../messages/repository.js';
import { evaluateGate, getConsent } from '../policy/consent.js';
import { evaluatePacing, describeSuppression } from '../policy/pacing.js';
import { messagesAccepted, messagesBlocked } from '../observability/metrics.js';
import { getCredentialsByExternalId } from '../tenancy/credentials.js';
import {
  EVENT_TYPES,
  LOCALES,
  META_LANGUAGE,
  TIME_CRITICAL,
  getTemplate,
  type EventType,
  type Locale,
} from '../templates/registry.js';
import { buildTemplateMessage } from '../whatsapp/payloads.js';
import { dispatchQueue } from '../queue/queues.js';

/**
 * Intake.
 *
 * One entry point for every outbound message in the platform. The Restaurant OS
 * backend posts an EVENT here — "this booking is confirmed" — and this module
 * decides which approved template that becomes, in which language, whether it
 * is allowed to go, and when.
 *
 * The caller never names a template. That is deliberate: if callers could pick
 * templates, the template registry would stop being the single source of truth
 * within a week.
 */

export const notificationRequestSchema = z.object({
  tenantId: z.string().uuid(),
  /** The outlet id as the Restaurant OS backend knows it. */
  outletId: z.string().min(1).max(64),
  eventType: z.enum(EVENT_TYPES),
  phone: z.string().min(6).max(20),
  locale: z.enum(LOCALES).optional(),
  params: z.record(z.unknown()).default({}),
  correlationId: z.string().min(1).max(64).optional(),
  campaignId: z.string().min(1).max(64).optional(),
  /** ISO-8601. Used by reminders and the T+12h feedback nudge. */
  scheduledFor: z.string().datetime().optional(),
});

export type NotificationRequest = z.infer<typeof notificationRequestSchema>;

/**
 * What a caller actually sends. `tenantId` is optional on the wire because the
 * API key already names the tenant — the route fills it in, and rejects a body
 * value that disagrees with the key rather than picking a winner.
 */
export const notificationWireSchema = notificationRequestSchema.partial({ tenantId: true });

export interface EnqueueResult {
  /** Null when nothing was written — a pacing suppression creates no message. */
  messageId: string | null;
  state: 'QUEUED' | 'BLOCKED_BY_CONSENT' | 'SUPPRESSED';
  scheduledFor?: string;
  reason?: string;
  /** Set on SUPPRESSED: MIN_GAP | MARKETING_COOLDOWN | UPCOMING_BOOKING. */
  rule?: string;
}

export async function enqueueNotification(req: NotificationRequest): Promise<EnqueueResult> {
  const event = req.eventType as EventType;
  const def = getTemplate(event);

  // 1. Credentials + outlet context. Resolves the tenant's own WABA.
  const creds = await getCredentialsByExternalId(req.tenantId, req.outletId);

  // 2. Phone, through the one shared normaliser.
  const phoneE164 = toE164(req.phone);

  // 3. Variables, validated against the approved template's shape. This is the
  //    check that stops Meta's 132000 from ever reaching production.
  const parsed = def.params.safeParse(req.params);
  if (!parsed.success) {
    throw new AppError(
      'TEMPLATE_PARAMS_INVALID',
      `Parameters do not match template ${def.name}.`,
      { fields: parsed.error.flatten().fieldErrors },
    );
  }
  const params = parsed.data as Record<string, unknown>;

  // 4. Language: explicit request wins, else the guest's stored preference.
  const locale: Locale = req.locale ?? ((await getConsent(req.tenantId, phoneE164)).locale as Locale) ?? 'en';

  // 5. Campaigns carry their own approved template name.
  const templateName =
    event === 'MARKETING_CAMPAIGN' ? String(params.templateName) : def.name;

  const payload = buildTemplateMessage(def, params, phoneE164, locale, templateName);

  // 6. The policy gate: consent for marketing, quiet hours for marketing.
  const gate = await evaluateGate({
    tenantId: creds.tenantId,
    phoneE164,
    category: def.category,
    timezone: creds.timezone,
  });

  if (!gate.allow) {
    // A blocked send is still a recorded message. "We did not send this, and
    // here is why" is an answer the owner's dashboard has to be able to give.
    const row = await withTransaction((tx) =>
      createMessage(tx, {
        tenantId: creds.tenantId,
        outletId: creds.outletId,
        eventType: event,
        category: def.category,
        toPhoneE164: phoneE164,
        locale,
        templateName,
        templateLanguage: META_LANGUAGE[locale],
        payload,
        correlationType: def.correlation,
        correlationId: req.correlationId ?? null,
        campaignId: req.campaignId ?? null,
        initialState: 'BLOCKED_BY_CONSENT',
        blockReason: gate.reason,
      }),
    );

    logger.info(
      { messageId: row.id, eventType: event, guest: maskPhone(phoneE164), reason: gate.reason },
      'send blocked by consent',
    );
    messagesBlocked.inc({ event_type: event, reason: 'CONSENT', outlet: creds.outletName });
    return { messageId: row.id, state: 'BLOCKED_BY_CONSENT', reason: gate.reason };
  }

  // 7. Pacing. Consent says whether we may message this guest at all; pacing
  //    says whether we should do it now. A reminder an hour after the
  //    confirmation is permitted and still wrong.
  const pacing = await evaluatePacing({
    tenantId: creds.tenantId,
    phoneE164,
    eventType: event,
    category: def.category,
  });

  if (!pacing.send) {
    describeSuppression(
      { tenantId: creds.tenantId, phoneE164, eventType: event, category: def.category },
      pacing,
    );

    // Not written to `messages`: it has no wamid and no lifecycle, and inventing
    // a state for it would corrupt every delivery rate on the dashboard.
    await pool.query(
      `INSERT INTO suppressed_sends
         (tenant_id, outlet_id, phone_e164, event_type, category, rule, reason,
          correlation_id, campaign_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        creds.tenantId,
        creds.outletId,
        phoneE164,
        event,
        def.category,
        pacing.rule,
        pacing.reason,
        req.correlationId ?? null,
        req.campaignId ?? null,
      ],
    );

    messagesBlocked.inc({ event_type: event, reason: pacing.rule, outlet: creds.outletName });
    return { messageId: null, state: 'SUPPRESSED', reason: pacing.reason, rule: pacing.rule };
  }

  // 8. Persist, then queue. Order matters: a job whose message row does not
  //    exist yet is a job that fails on its first run.
  const row = await withTransaction((tx) =>
    createMessage(tx, {
      tenantId: creds.tenantId,
      outletId: creds.outletId,
      eventType: event,
      category: def.category,
      toPhoneE164: phoneE164,
      locale,
      templateName,
      templateLanguage: META_LANGUAGE[locale],
      payload,
      correlationType: def.correlation,
      correlationId: req.correlationId ?? null,
      campaignId: req.campaignId ?? null,
    }),
  );

  const requested = req.scheduledFor ? new Date(req.scheduledFor) : undefined;
  const fireAt = latest(requested, gate.deferUntil);
  const delay = fireAt ? Math.max(0, fireAt.getTime() - Date.now()) : 0;
  const urgent = TIME_CRITICAL.has(event);

  try {
    await dispatchQueue.add(
      event,
      { messageId: row.id, outletId: creds.outletId, urgent },
      {
        delay,
        // Urgent work (missed call, table ready) must not sit behind a campaign.
        priority: urgent ? 1 : 10,
        jobId: `msg-${row.id}`,
      },
    );
  } catch (err) {
    // The row is already committed. Leaving it QUEUED with no job behind it is
    // the one failure mode that is invisible — nothing retries and nothing
    // alerts. Say so now; the reconciler is the net for a crash, not for this.
    logger.error({ err, messageId: row.id, eventType: event }, 'failed to queue message');
    throw new AppError('INTERNAL', 'The message was recorded but could not be queued.', {
      messageId: row.id,
    });
  }

  messagesAccepted.inc({ event_type: event, category: def.category, outlet: creds.outletName });

  return {
    messageId: row.id,
    state: 'QUEUED',
    ...(delay > 0 && fireAt ? { scheduledFor: fireAt.toISOString() } : {}),
  };
}

function latest(a?: Date, b?: Date): Date | undefined {
  if (a && b) return a > b ? a : b;
  return a ?? b;
}
