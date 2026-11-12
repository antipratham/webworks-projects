import { pool, one, withTransaction } from '../db/pool.js';
import { SERVICE_WINDOW_HOURS, FEEDBACK_IDLE_TIMEOUT_MINUTES } from '../config.js';
import { logger, maskPhone } from '../logging/logger.js';
import { enqueueServiceMessage } from '../notifications/serviceMessage.js';
import { buildButtonMessage, buildListMessage, buildTextMessage } from '../whatsapp/payloads.js';
import { copyFor } from './copy.js';
import * as os from '../integrations/restaurantOs.js';
import { feedbackSessions, feedbackRatings } from '../observability/metrics.js';
import type { OutletCredentials } from '../tenancy/credentials.js';
import type { Locale } from '../templates/registry.js';

/**
 * THE FEEDBACK CONVERSATION — the only two-way surface in the platform.
 *
 * Shape of it:
 *
 *   T+12h   FEEDBACK_REQUEST template  ──► guest taps "Rate my visit"
 *                                          (the tap opens a 24h service window)
 *   then    1-10 rating, as a list     ──► guest picks
 *           ≤6 alerts the manager immediately, before the survey finishes
 *   then    food / service / ambience  ──► three taps
 *   then    routed close: review link, thanks, or apology
 *
 * Two design decisions worth stating, because they are not obvious:
 *
 *  1. The RATING COMES FIRST, before the three questions, even though the spec
 *     words it as "three questions plus NPS". The rating is what routes the
 *     outcome and what triggers the five-minute manager alert. Asking it last
 *     means a guest who drops out after question two tells us nothing at all.
 *
 *  2. The scale is 1-10, not 0-10. An interactive list holds ten rows, and this
 *     rating has to be one tap. The promoter/passive/detractor thresholds are
 *     unchanged: 9-10, 7-8, 6-and-below.
 *
 * Everything in here runs inside an OPEN window, so every message it sends is
 * free-form — which is also why it does not need a template for any of it.
 */

export type FeedbackStep =
  | 'AWAITING_OPT_IN'
  | 'RATING'
  | 'Q1'
  | 'Q2'
  | 'Q3'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'DECLINED';

interface SessionRow {
  id: string;
  tenant_id: string;
  outlet_id: string;
  visit_id: string;
  phone_e164: string;
  locale: Locale;
  step: FeedbackStep;
  answers: Record<string, string>;
  rating: number | null;
  window_expires_at: string | null;
  last_prompt_at: string | null;
}

export interface InboundContext {
  creds: OutletCredentials;
  phoneE164: string;
  /** Payload from a template quick-reply button. */
  buttonPayload?: string | undefined;
  /** Row id from an interactive list, or button id from interactive replies. */
  interactiveId?: string | undefined;
  /** Whatever the guest typed, if they typed instead of tapping. */
  text?: string | undefined;
}

const QUESTION_KEYS = { Q1: 'food', Q2: 'service', Q3: 'ambience' } as const;

// ------------------------------------------------------------------ entry --

/**
 * Every inbound message lands here. If it does not belong to a feedback
 * conversation, this returns false and the caller drops it — the platform is
 * outbound-only outside this one flow, and silence is the correct response to
 * an unsolicited message, not an auto-reply.
 */
export async function handleInbound(ctx: InboundContext): Promise<boolean> {
  const payload = ctx.buttonPayload ?? ctx.interactiveId ?? '';

  if (payload.startsWith('FB_START:')) {
    await startSession(ctx, payload.slice('FB_START:'.length));
    return true;
  }
  if (payload.startsWith('FB_DECLINE:')) {
    await declineSession(ctx, payload.slice('FB_DECLINE:'.length));
    return true;
  }

  const session = await findActiveSession(ctx.creds.tenantId, ctx.phoneE164);
  if (!session) return false;

  if (isWindowClosed(session)) {
    await expire(session.id, 'service window closed');
    return true;
  }

  switch (session.step) {
    case 'RATING':
      return captureRating(ctx, session, payload);
    case 'Q1':
    case 'Q2':
    case 'Q3':
      return captureQuestion(ctx, session, payload);
    default:
      return false;
  }
}

// --------------------------------------------------------------- sessions --

async function findActiveSession(
  tenantId: string,
  phoneE164: string,
): Promise<SessionRow | undefined> {
  return one<SessionRow>(
    pool,
    `SELECT * FROM feedback_sessions
      WHERE tenant_id = $1 AND phone_e164 = $2
        AND step NOT IN ('COMPLETED','EXPIRED','DECLINED')
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, phoneE164],
  );
}

function isWindowClosed(session: SessionRow): boolean {
  if (!session.window_expires_at) return false;
  if (new Date(session.window_expires_at).getTime() < Date.now()) return true;

  // A guest who stopped replying an hour ago has moved on. Do not chase them.
  if (session.last_prompt_at) {
    const idleMs = Date.now() - new Date(session.last_prompt_at).getTime();
    if (idleMs > FEEDBACK_IDLE_TIMEOUT_MINUTES * 60_000) return true;
  }
  return false;
}

async function startSession(ctx: InboundContext, visitId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + SERVICE_WINDOW_HOURS * 3600_000);

  // The unique index on (tenant_id, visit_id) is what enforces "one nudge per
  // visit". A second tap on the same template lands on the existing row.
  const session = await withTransaction(async (tx) => {
    const row = await one<SessionRow>(
      tx,
      `INSERT INTO feedback_sessions
         (tenant_id, outlet_id, visit_id, phone_e164, locale, step,
          window_opened_at, window_expires_at, last_prompt_at)
       VALUES ($1,$2,$3,$4,$5,'RATING',now(),$6,now())
       ON CONFLICT (tenant_id, visit_id) DO UPDATE
         SET window_opened_at  = COALESCE(feedback_sessions.window_opened_at, now()),
             window_expires_at = EXCLUDED.window_expires_at,
             last_prompt_at    = now(),
             step = CASE WHEN feedback_sessions.step = 'AWAITING_OPT_IN'
                         THEN 'RATING' ELSE feedback_sessions.step END
       RETURNING *`,
      [
        ctx.creds.tenantId,
        ctx.creds.outletId,
        visitId,
        ctx.phoneE164,
        'en',
        expiresAt.toISOString(),
      ],
    );
    return row!;
  });

  if (session.step !== 'RATING') return; // already past the rating; don't re-ask

  await sendRatingPrompt(ctx, session);
  logger.info(
    { visitId, guest: maskPhone(ctx.phoneE164) },
    'feedback session opened by guest tap',
  );
}

async function declineSession(ctx: InboundContext, visitId: string): Promise<void> {
  await pool.query(
    `INSERT INTO feedback_sessions (tenant_id, outlet_id, visit_id, phone_e164, step)
     VALUES ($1,$2,$3,$4,'DECLINED')
     ON CONFLICT (tenant_id, visit_id) DO UPDATE SET step = 'DECLINED'`,
    [ctx.creds.tenantId, ctx.creds.outletId, visitId, ctx.phoneE164],
  );

  const c = copyFor('en');
  feedbackSessions.inc({ outcome: 'declined', outlet: ctx.creds.outletName });
  await send(ctx, buildTextMessage(ctx.phoneE164, c.declined), visitId);
}

async function expire(sessionId: string, reason: string): Promise<void> {
  await pool.query(`UPDATE feedback_sessions SET step = 'EXPIRED' WHERE id = $1`, [sessionId]);
  logger.info({ sessionId, reason }, 'feedback session expired');
}

// ---------------------------------------------------------------- prompts --

async function sendRatingPrompt(ctx: InboundContext, session: SessionRow): Promise<void> {
  const c = copyFor(session.locale);
  const rows = Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    const row: { id: string; title: string; description?: string } = {
      id: `RATE:${n}`,
      title: c.ratingRow(n),
    };
    if (n === 1) row.description = c.ratingLow;
    if (n === 10) row.description = c.ratingHigh;
    return row;
  });

  await send(
    ctx,
    buildListMessage(ctx.phoneE164, {
      header: c.ratingHeader,
      body: c.ratingBody(ctx.creds.outletName),
      buttonLabel: c.ratingButton,
      rows,
    }),
    session.visit_id,
  );
}

async function sendQuestion(
  ctx: InboundContext,
  session: SessionRow,
  step: 'Q1' | 'Q2' | 'Q3',
): Promise<void> {
  const c = copyFor(session.locale);
  const body = step === 'Q1' ? c.q1 : step === 'Q2' ? c.q2 : c.q3;

  await send(
    ctx,
    buildButtonMessage(ctx.phoneE164, {
      body,
      buttons: [
        { id: `${step}:GOOD`, title: c.optionGood },
        { id: `${step}:OKAY`, title: c.optionOkay },
        { id: `${step}:POOR`, title: c.optionPoor },
      ],
    }),
    session.visit_id,
  );

  await pool.query(
    `UPDATE feedback_sessions SET step = $2, last_prompt_at = now() WHERE id = $1`,
    [session.id, step],
  );
}

// ----------------------------------------------------------------- capture --

async function captureRating(
  ctx: InboundContext,
  session: SessionRow,
  payload: string,
): Promise<boolean> {
  const rating = parseRating(payload, ctx.text);

  if (rating === undefined) {
    const c = copyFor(session.locale);
    await send(ctx, buildTextMessage(ctx.phoneE164, c.notUnderstood), session.visit_id);
    await sendRatingPrompt(ctx, session);
    return true;
  }

  await pool.query(
    `UPDATE feedback_sessions SET rating = $2, last_prompt_at = now() WHERE id = $1`,
    [session.id, rating],
  );

  // Five-minute promise: fire now, not after the survey completes.
  if (rating <= 6) {
    void os.alertManager({
      tenantId: session.tenant_id,
      outletId: session.outlet_id,
      visitId: session.visit_id,
      rating,
      severity: 'DETRACTOR',
    });
  }

  await sendQuestion(ctx, { ...session, rating }, 'Q1');
  return true;
}

async function captureQuestion(
  ctx: InboundContext,
  session: SessionRow,
  payload: string,
): Promise<boolean> {
  const step = session.step as 'Q1' | 'Q2' | 'Q3';
  const match = /^(Q[123]):(GOOD|OKAY|POOR)$/.exec(payload);

  if (!match || match[1] !== step) {
    const c = copyFor(session.locale);
    await send(ctx, buildTextMessage(ctx.phoneE164, c.notUnderstood), session.visit_id);
    return true;
  }

  const answers = { ...session.answers, [QUESTION_KEYS[step]]: match[2]! };
  await pool.query(`UPDATE feedback_sessions SET answers = $2 WHERE id = $1`, [
    session.id,
    JSON.stringify(answers),
  ]);

  const next = step === 'Q1' ? 'Q2' : step === 'Q2' ? 'Q3' : undefined;
  if (next) {
    await sendQuestion(ctx, { ...session, answers }, next);
    return true;
  }

  await complete(ctx, { ...session, answers });
  return true;
}

function parseRating(payload: string, text?: string): number | undefined {
  const fromList = /^RATE:(\d{1,2})$/.exec(payload);
  const raw = fromList?.[1] ?? text?.trim().match(/^(\d{1,2})$/)?.[1];
  if (!raw) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= 10 ? n : undefined;
}

// ------------------------------------------------------------------ close --

async function complete(ctx: InboundContext, session: SessionRow): Promise<void> {
  const rating = session.rating ?? 0;
  const c = copyFor(session.locale);

  await pool.query(
    `UPDATE feedback_sessions SET step = 'COMPLETED', completed_at = now() WHERE id = $1`,
    [session.id],
  );

  void os.submitFeedback({
    tenantId: session.tenant_id,
    outletId: session.outlet_id,
    visitId: session.visit_id,
    rating,
    answers: session.answers,
    channel: 'WHATSAPP',
    completedAt: new Date().toISOString(),
  });

  // Routing, exactly as Flow 3 specifies it.
  if (rating >= 9) {
    const reviewUrl = await os.getReviewLink(session.outlet_id);
    const body = c.thanksPromoter(ctx.creds.outletName);
    await send(
      ctx,
      reviewUrl
        ? buildTextMessage(ctx.phoneE164, `${body}\n\n${c.reviewCta}: ${reviewUrl}`)
        : buildTextMessage(ctx.phoneE164, body),
      session.visit_id,
    );
  } else if (rating >= 7) {
    // Passive. Thanked, but never given a public review prompt.
    await send(
      ctx,
      buildTextMessage(ctx.phoneE164, c.thanksPassive(ctx.creds.outletName)),
      session.visit_id,
    );
  } else {
    await send(
      ctx,
      buildTextMessage(ctx.phoneE164, c.apologyDetractor(ctx.creds.outletName)),
      session.visit_id,
    );
  }

  feedbackSessions.inc({ outcome: 'completed', outlet: ctx.creds.outletName });
  feedbackRatings.observe({ outlet: ctx.creds.outletName }, rating);

  logger.info(
    { visitId: session.visit_id, rating, band: band(rating) },
    'feedback completed',
  );
}

function band(rating: number): string {
  if (rating >= 9) return 'PROMOTER';
  if (rating >= 7) return 'PASSIVE';
  return 'DETRACTOR';
}

// ----------------------------------------------------------------- plumbing --

async function send(
  ctx: InboundContext,
  payload: ReturnType<typeof buildTextMessage>,
  visitId: string,
): Promise<void> {
  await enqueueServiceMessage({
    tenantId: ctx.creds.tenantId,
    outletId: ctx.creds.outletId,
    eventType: 'FEEDBACK_DIALOGUE',
    toPhoneE164: ctx.phoneE164,
    locale: 'en',
    payload,
    correlationType: 'VISIT',
    correlationId: visitId,
  });
}

/**
 * Sweeper for sessions whose window shut without a reply. Run it every few
 * minutes; it exists so an abandoned session cannot block a later visit's
 * feedback from finding an "active session" that is really a ghost.
 */
export async function expireStaleSessions(): Promise<number> {
  const res = await pool.query(
    `UPDATE feedback_sessions
        SET step = 'EXPIRED'
      WHERE step NOT IN ('COMPLETED','EXPIRED','DECLINED')
        AND (window_expires_at < now()
             OR last_prompt_at < now() - ($1 || ' minutes')::interval)`,
    [String(FEEDBACK_IDLE_TIMEOUT_MINUTES)],
  );
  return res.rowCount ?? 0;
}
