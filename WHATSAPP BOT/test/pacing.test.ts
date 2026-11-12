import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPlatformTimed, PLATFORM_TIMED } from '../src/policy/messageTiming.js';
import { EVENT_TYPES, TIME_CRITICAL, getTemplate, type EventType } from '../src/templates/registry.js';

/**
 * Pacing rests entirely on one classification: did the platform choose this
 * moment, or did the guest?
 *
 * Get it backwards and either a deposit link arrives too late to pay, or
 * reminders go back to landing an hour after the confirmation. So the
 * classification is pinned here rather than left to whoever next adds an event.
 *
 * Imported from src/policy/messageTiming.ts rather than src/policy/pacing.ts on
 * purpose: pacing.ts reaches for the database and the validated environment, and
 * a unit test should need neither. CI runs this job with no env at all, which is
 * what caught the import in the first place.
 */
describe('pacing classification', () => {
  test('only the four timer-driven events are paced', () => {
    // Sorted: "BOOKING_REMINDER_T2" precedes "BOOKING_REMINDER_T24" — it is a
    // prefix of it.
    assert.deepEqual([...PLATFORM_TIMED].sort(), [
      'BOOKING_REMINDER_T2',
      'BOOKING_REMINDER_T24',
      'FEEDBACK_REQUEST',
      'MARKETING_CAMPAIGN',
    ]);
  });

  test('every registered event is classified one way or the other', () => {
    for (const event of EVENT_TYPES) {
      assert.equal(typeof isPlatformTimed(event), 'boolean', event);
    }
  });

  test('a time-critical message is never paced', () => {
    // A missed-call link, a table-ready ping and a deposit link are all answers
    // to something that just happened. Holding one back defeats its purpose.
    for (const event of TIME_CRITICAL) {
      assert.equal(isPlatformTimed(event), false, `${event} must not be paced`);
    }
  });

  test('messages that answer a guest action always go', () => {
    const guestTriggered: EventType[] = [
      'BOOKING_CONFIRMED',
      'DEPOSIT_PAYMENT_REQUEST',
      'CALL_FALLBACK_BOOKING_LINK',
      'CALLBACK_ACK',
      'WAITLIST_ADDED',
      'WAITLIST_TABLE_READY',
      'LOYALTY_POINTS_POSTED',
      'EVENT_TICKET_ISSUED',
    ];
    for (const event of guestTriggered) {
      assert.equal(isPlatformTimed(event), false, `${event} should not be paced`);
    }
  });

  test('every marketing message is paced', () => {
    for (const event of EVENT_TYPES) {
      if (getTemplate(event).category !== 'MARKETING') continue;
      assert.equal(isPlatformTimed(event), true, `${event} is marketing and must be paced`);
    }
  });
});
