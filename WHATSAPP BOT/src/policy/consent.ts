import { pool, one } from '../db/pool.js';
import { config } from '../config.js';
import type { TemplateCategory } from '../templates/registry.js';

/**
 * The policy gate. Everything queued passes through here exactly once, before
 * a single byte goes to Meta.
 *
 * The spec's rule, restated: "Before any marketing message, the sender checks
 * consent for that channel. DENIED or WITHDRAWN blocks the send and records
 * BLOCKED_BY_CONSENT. Transactional messages about a guest's own booking are
 * not marketing."
 *
 * So the gate is category-driven, not event-driven. A UTILITY message about the
 * guest's own booking goes out to someone who opted out of marketing — that is
 * correct, and it is also what WhatsApp's own policy expects.
 */

export type ConsentState = 'GRANTED' | 'DENIED' | 'WITHDRAWN' | 'UNKNOWN';

export type GateDecision =
  | { allow: true; deferUntil?: Date }
  | { allow: false; reason: string; consentState: ConsentState };

export async function getConsent(
  tenantId: string,
  phoneE164: string,
): Promise<{ state: ConsentState; locale: string }> {
  const row = await one<{ state: ConsentState; locale: string }>(
    pool,
    `SELECT state, locale FROM guest_consent
      WHERE tenant_id = $1 AND phone_e164 = $2 AND channel = 'WHATSAPP'`,
    [tenantId, phoneE164],
  );
  // Fail closed. An absent record is not permission.
  return row ?? { state: 'UNKNOWN', locale: 'en' };
}

export async function upsertConsent(input: {
  tenantId: string;
  phoneE164: string;
  state: ConsentState;
  locale?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO guest_consent (tenant_id, phone_e164, channel, state, locale, updated_at)
     VALUES ($1,$2,'WHATSAPP',$3,COALESCE($4,'en'),now())
     ON CONFLICT (tenant_id, phone_e164, channel) DO UPDATE
       SET state = EXCLUDED.state,
           locale = EXCLUDED.locale,
           updated_at = now()`,
    [input.tenantId, input.phoneE164, input.state, input.locale ?? null],
  );
}

export async function evaluateGate(input: {
  tenantId: string;
  phoneE164: string;
  category: TemplateCategory;
  timezone: string;
  now?: Date;
}): Promise<GateDecision> {
  // Transactional traffic is not marketing and is never consent-gated.
  if (input.category !== 'MARKETING') return { allow: true };

  const { state } = await getConsent(input.tenantId, input.phoneE164);
  if (state !== 'GRANTED') {
    return {
      allow: false,
      reason:
        state === 'UNKNOWN'
          ? 'no marketing consent on record for this channel'
          : `marketing consent is ${state}`,
      consentState: state,
    };
  }

  const now = input.now ?? new Date();
  const deferUntil = nextAllowedSendTime(now, input.timezone);
  return deferUntil ? { allow: true, deferUntil } : { allow: true };
}

/** The outlet-local hour, per the spec's "times are always in the outlet's timezone". */
export function localHour(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(at);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '0';
  return Number(hour) % 24;
}

function inQuietHours(hour: number): boolean {
  const start = config.QUIET_HOURS_START;
  const end = config.QUIET_HOURS_END;
  // The window wraps midnight (e.g. 21:00 -> 09:00).
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/**
 * Returns the instant a marketing message may go out, or undefined if now is
 * fine. Steps forward in 15-minute increments rather than doing offset
 * arithmetic, so a tenant in a DST timezone does not get a message at 3am.
 */
export function nextAllowedSendTime(now: Date, timezone: string): Date | undefined {
  if (!inQuietHours(localHour(now, timezone))) return undefined;

  const STEP_MS = 15 * 60 * 1000;
  for (let i = 1; i <= 96; i += 1) {
    const candidate = new Date(now.getTime() + i * STEP_MS);
    if (!inQuietHours(localHour(candidate, timezone))) return candidate;
  }
  // Unreachable unless quiet hours cover the whole day, which is a config error.
  return undefined;
}
