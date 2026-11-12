import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_TEMPLATES,
  TEMPLATE_MAP,
  mapVoiceTemplate,
} from '../src/integrations/voiceTemplateMap.js';
import { getTemplate } from '../src/templates/registry.js';
import { AppError } from '../src/domain/errors.js';

/**
 * The adapter translates the voice platform's four template names onto our
 * event registry. If that translation produces params our own schema rejects,
 * the voice agent's call fails at run time with a guest on the phone — so the
 * mapping is checked against the real schemas here.
 */

const SAMPLE_VARS: Record<string, Record<string, string>> = {
  BOOKING_CONFIRMED: {
    guest_name: 'Asha',
    outlet_name: 'The Table',
    party_size: '4',
    slot_label: 'Sat 4 Oct, 8:00 pm',
    manage_token: 'bk_7f3a9c21d4e8',
    booking_id: 'bk_001',
  },
  PAYMENT_LINK: {
    guest_name: 'Asha',
    outlet_name: 'The Table',
    amount_label: '₹2,000',
    slot_label: 'Sat 4 Oct, 8:00 pm',
    hold_expiry_label: '30 minutes',
    pay_token: 'pay_c81f0e4a7b62',
    booking_id: 'bk_002',
  },
  CALLBACK_ACK: { outlet_name: 'The Table', booking_token: 'cb_20a4f8b17c93' },
  BOOKING_LINK: { outlet_name: 'The Table', booking_token: 'cl_20a4f8b17c93' },
};

describe('voice platform adapter', () => {
  test('covers exactly the four templates the contract defines', () => {
    assert.deepEqual([...VOICE_TEMPLATES].sort(), [
      'BOOKING_CONFIRMED',
      'BOOKING_LINK',
      'CALLBACK_ACK',
      'PAYMENT_LINK',
    ]);
    assert.equal(Object.keys(TEMPLATE_MAP).length, VOICE_TEMPLATES.length);
  });

  test('every mapping produces params our own registry accepts', () => {
    for (const template of VOICE_TEMPLATES) {
      const mapped = mapVoiceTemplate(template, SAMPLE_VARS[template]!, 'call_123');
      const def = getTemplate(mapped.eventType);

      const parsed = def.params.safeParse(mapped.params);
      assert.ok(
        parsed.success,
        `${template} → ${mapped.eventType}: ${JSON.stringify(
          parsed.success ? {} : parsed.error.flatten().fieldErrors,
        )}`,
      );
    }
  });

  test('party_size arrives as a string and becomes a number', () => {
    // The contract types every variable as a string. Our schema wants an int.
    const mapped = mapVoiceTemplate('BOOKING_CONFIRMED', SAMPLE_VARS.BOOKING_CONFIRMED!);
    assert.equal(mapped.params.partySize, 4);
    assert.equal(typeof mapped.params.partySize, 'number');
  });

  test('a missing variable is named, not swallowed', () => {
    assert.throws(
      () => mapVoiceTemplate('CALLBACK_ACK', { outlet_name: 'The Table' }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'TEMPLATE_PARAMS_INVALID');
        assert.deepEqual((err.detail as { missing: string[] }).missing, ['booking_token']);
        return true;
      },
    );
  });

  test('call-driven messages correlate to the call, booking ones to the booking', () => {
    assert.equal(
      mapVoiceTemplate('CALLBACK_ACK', SAMPLE_VARS.CALLBACK_ACK!, 'call_9').correlationId,
      'call_9',
    );
    assert.equal(
      mapVoiceTemplate('BOOKING_CONFIRMED', SAMPLE_VARS.BOOKING_CONFIRMED!, 'call_9').correlationId,
      'bk_001',
    );
  });

  test('every mapped event is UTILITY — the agent sends nothing marketing', () => {
    for (const template of VOICE_TEMPLATES) {
      const mapped = mapVoiceTemplate(template, SAMPLE_VARS[template]!, 'call_123');
      assert.equal(
        getTemplate(mapped.eventType).category,
        'UTILITY',
        `${template} must not be a marketing category`,
      );
    }
  });
});
