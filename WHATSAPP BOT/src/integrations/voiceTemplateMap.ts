import { AppError } from '../domain/errors.js';
import type { EventType } from '../templates/registry.js';

/**
 * VOICE PLATFORM COMPATIBILITY ADAPTER
 *
 * Implements `POST /messages/whatsapp` exactly as `contracts/platform-api.yaml`
 * in the eatlabs-llm-voice repo defines it, so the Restaurant OS backend can
 * forward that call here unchanged instead of writing a translation layer.
 *
 * The contract names four templates; we name our events differently. This file
 * is the whole of that difference, in one place:
 *
 *     BOOKING_CONFIRMED  →  BOOKING_CONFIRMED
 *     PAYMENT_LINK       →  DEPOSIT_PAYMENT_REQUEST
 *     CALLBACK_ACK       →  CALLBACK_ACK
 *     BOOKING_LINK       →  CALL_FALLBACK_BOOKING_LINK
 *
 * A note on the two the contract says come from elsewhere: it states that
 * `BOOKING_CONFIRMED` and `PAYMENT_LINK` are written by the booking commit's
 * outbox rather than sent through this endpoint, and its mock returns 422 for
 * them. We accept all four anyway. The mock is guarding the *voice agent*
 * against sending them directly; this endpoint is what the *backend's outbox
 * drain* calls, and giving that drain one door rather than two is the whole
 * point of the adapter.
 *
 * Everything still routes through `enqueueNotification`, so consent, quiet
 * hours, idempotency, variable validation and the audit trail all apply exactly
 * as they do to our own intake API. There is no second path to Meta.
 */

/** Variable keys the backend sends. Snake_case, matching the contract's style. */
type Vars = Record<string, string | undefined>;

interface Mapping {
  event: EventType;
  /** Names the caller must supply, listed for the error message. */
  required: string[];
  params: (v: Vars) => Record<string, unknown>;
  /** What the message is about, for the guest timeline. */
  correlation: (v: Vars, callId?: string) => string | undefined;
}

export const VOICE_TEMPLATES = [
  'BOOKING_CONFIRMED',
  'PAYMENT_LINK',
  'CALLBACK_ACK',
  'BOOKING_LINK',
] as const;

export type VoiceTemplate = (typeof VOICE_TEMPLATES)[number];

export const TEMPLATE_MAP: Record<VoiceTemplate, Mapping> = {
  BOOKING_CONFIRMED: {
    event: 'BOOKING_CONFIRMED',
    required: ['guest_name', 'outlet_name', 'party_size', 'slot_label', 'manage_token'],
    params: (v) => ({
      guestName: v.guest_name,
      outletName: v.outlet_name,
      // The contract types every variable as a string; our schema wants a number.
      partySize: Number(v.party_size),
      dateTimeLabel: v.slot_label,
      manageToken: v.manage_token,
    }),
    correlation: (v) => v.booking_id,
  },

  PAYMENT_LINK: {
    event: 'DEPOSIT_PAYMENT_REQUEST',
    required: [
      'guest_name',
      'outlet_name',
      'amount_label',
      'slot_label',
      'hold_expiry_label',
      'pay_token',
    ],
    params: (v) => ({
      guestName: v.guest_name,
      outletName: v.outlet_name,
      amountLabel: v.amount_label,
      dateTimeLabel: v.slot_label,
      holdExpiryLabel: v.hold_expiry_label,
      payToken: v.pay_token,
    }),
    correlation: (v) => v.booking_id,
  },

  CALLBACK_ACK: {
    event: 'CALLBACK_ACK',
    required: ['outlet_name', 'booking_token'],
    params: (v) => ({ outletName: v.outlet_name, bookingToken: v.booking_token }),
    correlation: (_v, callId) => callId,
  },

  BOOKING_LINK: {
    event: 'CALL_FALLBACK_BOOKING_LINK',
    required: ['outlet_name', 'booking_token'],
    params: (v) => ({ outletName: v.outlet_name, bookingToken: v.booking_token }),
    correlation: (_v, callId) => callId,
  },
};

/** Pure, so the mapping is unit-testable without a database. */
export function mapVoiceTemplate(
  template: VoiceTemplate,
  variables: Vars,
  callId?: string,
): { eventType: EventType; params: Record<string, unknown>; correlationId?: string } {
  const mapping = TEMPLATE_MAP[template];

  const missing = mapping.required.filter((k) => !variables[k]);
  if (missing.length) {
    throw new AppError(
      'TEMPLATE_PARAMS_INVALID',
      `Template ${template} is missing required variables.`,
      { missing, expected: mapping.required },
    );
  }

  const correlationId = mapping.correlation(variables, callId);
  return {
    eventType: mapping.event,
    params: mapping.params(variables),
    ...(correlationId ? { correlationId } : {}),
  };
}

