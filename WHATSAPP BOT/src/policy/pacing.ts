import { pool, one } from '../db/pool.js';
import { config } from '../config.js';
import { logger, maskPhone } from '../logging/logger.js';
import type { EventType } from '../templates/registry.js';
import { isPlatformTimed } from './messageTiming.js';

export { PLATFORM_TIMED, isPlatformTimed } from './messageTiming.js';

/**
 * PACING
 *
 * Consent decides whether a guest may be messaged at all. Pacing decides
 * whether they should be messaged *now*. They are different questions, and a
 * system that only answers the first one sends bursts.
 *
 * The principle behind every rule here:
 *
 *   A message that ANSWERS something the guest just did always goes.
 *   A message the PLATFORM decided to send on a timer has to earn its place.
 *
 * So a booking confirmation, a deposit link, a ticket, a table-ready ping and a
 * points receipt are never held back — the guest just acted and is expecting
 * them. Reminders, the feedback nudge and marketing are platform-timed, and
 * those respect a quiet gap.
 *
 * The case that motivated this: a guest books 25 hours ahead, gets a
 * confirmation immediately, and the T-24h reminder lands one hour later saying
 * almost the same thing.
 */

export type PacingDecision =
  | { send: true }
  | { send: false; rule: string; reason: string };

export interface PacingInput {
  tenantId: string;
  phoneE164: string;
  eventType: EventType;
  category: string;
  now?: Date;
}

export async function evaluatePacing(input: PacingInput): Promise<PacingDecision> {
  // A reply to the guest's own action is never paced.
  if (!isPlatformTimed(input.eventType)) return { send: true };

  const now = input.now ?? new Date();

  const gap = await checkMinimumGap(input, now);
  if (!gap.send) return gap;

  if (input.category === 'MARKETING') {
    const freq = await checkMarketingFrequency(input, now);
    if (!freq.send) return freq;

    const booked = await checkUpcomingBooking(input, now);
    if (!booked.send) return booked;
  }

  return { send: true };
}

// ------------------------------------------------------------ rule 1: gap --

/**
 * At least `MIN_MESSAGE_GAP_HOURS` between the last message a guest received
 * and the next platform-timed one.
 *
 * A suppressed reminder is not rescheduled. The point of a T-24h reminder is to
 * arrive 24 hours out; delivered at some arbitrary later hour it is just noise,
 * and the T-2h reminder is still coming.
 */
async function checkMinimumGap(input: PacingInput, now: Date): Promise<PacingDecision> {
  const hours = config.MIN_MESSAGE_GAP_HOURS;
  if (hours <= 0) return { send: true };

  const row = await one<{ last_at: string; event_type: string }>(
    pool,
    `SELECT created_at AS last_at, event_type
       FROM messages
      WHERE tenant_id = $1
        AND to_phone_e164 = $2
        AND state <> 'BLOCKED_BY_CONSENT'
        AND redacted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.tenantId, input.phoneE164],
  );
  if (!row) return { send: true };

  const elapsedHours = (now.getTime() - new Date(row.last_at).getTime()) / 3_600_000;
  if (elapsedHours >= hours) return { send: true };

  return {
    send: false,
    rule: 'MIN_GAP',
    reason:
      `last message was ${elapsedHours.toFixed(1)}h ago (${row.event_type}); ` +
      `${hours}h minimum gap applies to platform-timed messages`,
  };
}

// ---------------------------------------------------- rule 2: how often --

/** No guest hears from marketing more than once per `MARKETING_COOLDOWN_DAYS`. */
async function checkMarketingFrequency(input: PacingInput, now: Date): Promise<PacingDecision> {
  const days = config.MARKETING_COOLDOWN_DAYS;
  if (days <= 0) return { send: true };

  const row = await one<{ last_at: string }>(
    pool,
    `SELECT created_at AS last_at
       FROM messages
      WHERE tenant_id = $1
        AND to_phone_e164 = $2
        AND category = 'MARKETING'
        AND state <> 'BLOCKED_BY_CONSENT'
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.tenantId, input.phoneE164],
  );
  if (!row) return { send: true };

  const elapsedDays = (now.getTime() - new Date(row.last_at).getTime()) / 86_400_000;
  if (elapsedDays >= days) return { send: true };

  return {
    send: false,
    rule: 'MARKETING_COOLDOWN',
    reason: `last marketing message was ${elapsedDays.toFixed(1)} days ago; cooldown is ${days} days`,
  };
}

// -------------------------------------------- rule 3: they are coming in --

/**
 * A guest with a table booked in the next `CAMPAIGN_BOOKING_EXCLUSION_HOURS`
 * does not need persuading to visit. "We miss you, come back" landing the
 * morning of someone's anniversary dinner is the kind of message that gets a
 * sender reported.
 *
 * We do not hold bookings — the Restaurant OS does — but we hold the reminders
 * scheduled for them, and a PENDING reminder is proof of an upcoming booking.
 */
async function checkUpcomingBooking(input: PacingInput, now: Date): Promise<PacingDecision> {
  const hours = config.CAMPAIGN_BOOKING_EXCLUSION_HOURS;
  if (hours <= 0) return { send: true };

  const horizon = new Date(now.getTime() + hours * 3_600_000);

  const row = await one<{ fire_at: string }>(
    pool,
    `SELECT fire_at
       FROM scheduled_notifications
      WHERE tenant_id = $1
        AND phone_e164 = $2
        AND state = 'PENDING'
        AND correlation_type = 'BOOKING'
        AND fire_at <= $3
      ORDER BY fire_at
      LIMIT 1`,
    [input.tenantId, input.phoneE164, horizon.toISOString()],
  );
  if (!row) return { send: true };

  return {
    send: false,
    rule: 'UPCOMING_BOOKING',
    reason: `guest already has a booking inside the next ${hours}h`,
  };
}

/** For the log line on a suppressed send. */
export function describeSuppression(input: PacingInput, decision: PacingDecision): void {
  if (decision.send) return;
  logger.info(
    {
      eventType: input.eventType,
      rule: decision.rule,
      guest: maskPhone(input.phoneE164),
      reason: decision.reason,
    },
    'send suppressed by pacing',
  );
}
