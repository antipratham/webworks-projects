import type { EventType } from '../templates/registry.js';

/**
 * WHO CHOSE THE MOMENT
 *
 * The single classification that pacing rests on: did the platform decide to
 * send this, or is it answering something the guest just did?
 *
 *   A message that ANSWERS the guest always goes.
 *   A message the PLATFORM timed has to earn its place.
 *
 * Kept in its own module with no imports beyond a type, so it can be unit
 * tested without a database connection or a validated environment — the same
 * reason the voice template map is separate from its route.
 *
 * Getting this wrong is expensive in both directions. Pace a guest-triggered
 * message and a deposit link arrives after the hold expires. Fail to pace a
 * timed one and reminders go back to landing an hour after the confirmation.
 */
export const PLATFORM_TIMED: ReadonlySet<EventType> = new Set([
  'BOOKING_REMINDER_T24',
  'BOOKING_REMINDER_T2',
  'FEEDBACK_REQUEST',
  'MARKETING_CAMPAIGN',
]);

export function isPlatformTimed(event: EventType): boolean {
  return PLATFORM_TIMED.has(event);
}
