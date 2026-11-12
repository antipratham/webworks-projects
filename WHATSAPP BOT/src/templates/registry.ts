import { z } from 'zod';

/**
 * THE TEMPLATE REGISTRY
 *
 * Every outbound message the platform can send is declared here, once.
 *
 * Why this file exists: Meta rejects a template send with error 132000 when the
 * variable count does not match what was approved, and it does so at 9pm with a
 * real guest waiting. Declaring the variable schema next to the template name
 * turns that runtime failure into a type error in CI.
 *
 * Rules for this file:
 *  - `name` must match the template name approved in the WhatsApp Manager exactly.
 *  - `body` returns positional variables. Order IS the contract: index 0 -> {{1}}.
 *  - A template is approved per (name, language). All three languages ship together
 *    or the event cannot be sent in the missing one.
 *  - URL buttons carry only the SUFFIX. The base domain is fixed at approval time,
 *    so `urlSuffix` must produce a path/query fragment, never a whole URL.
 *  - Changing any of this means re-submitting to Meta. Treat edits as migrations.
 */

/**
 * English only, by decision.
 *
 * The plumbing stays generic — templates are approved per (name, language) and
 * every send already carries a locale — so adding Hindi or Kannada later is
 * content work and a Meta submission, not a migration. What is deliberately not
 * here is unreviewed translated copy: a machine-shaped apology to a guest who
 * just had a bad meal reads worse than no apology at all.
 */
export const localeSchema = z.enum(['en']);
export const LOCALES = localeSchema.options;
export type Locale = z.infer<typeof localeSchema>;

/** Meta language codes, keyed by our locale. */
export const META_LANGUAGE: Record<Locale, string> = {
  en: 'en',
};

export type TemplateCategory = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';

export type CorrelationType =
  | 'BOOKING'
  | 'WAITLIST'
  | 'VISIT'
  | 'TICKET'
  | 'CAMPAIGN'
  | 'CALL';

/** A quick-reply button declared on the approved template. */
interface QuickReplyButton<P> {
  kind: 'quick_reply';
  /** Position on the approved template, 0-based. */
  index: number;
  /** Payload echoed back to us on tap. Keep it short and parseable. */
  payload: (p: P) => string;
}

/** A dynamic URL button: base domain fixed at approval, suffix supplied per send. */
interface UrlButton<P> {
  kind: 'url';
  index: number;
  suffix: (p: P) => string;
}

export type ButtonSpec<P> = QuickReplyButton<P> | UrlButton<P>;

export interface TemplateDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Approved template name in WhatsApp Manager. */
  name: string;
  category: TemplateCategory;
  correlation: CorrelationType;
  /** Variables validated before the message is ever enqueued. */
  params: S;
  /** Positional body variables. Index 0 becomes {{1}}. */
  body: (p: z.infer<S>) => string[];
  buttons?: ButtonSpec<z.infer<S>>[];
  /**
   * Header variables, if the approved template has a variable header.
   * Media headers use `mediaHeader` instead.
   */
  headerText?: (p: z.infer<S>) => string;
  mediaHeader?: (p: z.infer<S>) => { type: 'image' | 'document'; link: string };
  /** Free-text note for whoever submits this template to Meta for approval. */
  approvalNote?: string;
}

/**
 * The type the rest of the codebase sees.
 *
 * `TemplateDefinition<S>` is invariant in `S` — a definition built from a
 * specific ZodObject is not assignable to one built from ZodTypeAny — so the
 * registry is erased to this shape at its boundary. Callers get a uniform type;
 * the definitions themselves keep their exact per-template checking.
 */
export interface AnyTemplateDefinition {
  name: string;
  category: TemplateCategory;
  correlation: CorrelationType;
  params: z.ZodTypeAny;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  body: (p: any) => string[];
  buttons?: ButtonSpec<any>[];
  headerText?: (p: any) => string;
  mediaHeader?: (p: any) => { type: 'image' | 'document'; link: string };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  approvalNote?: string;
}

/**
 * Identity function that pins `S` from the `params` schema, so every `body`,
 * `payload` and `suffix` callback below is typed against its own variables
 * with no annotations and no casts.
 */
const define = <S extends z.ZodTypeAny>(d: TemplateDefinition<S>): TemplateDefinition<S> => d;

// ---------------------------------------------------------------- helpers --

/** Shared across nearly every template. */
const base = {
  guestName: z.string().min(1).max(60),
  outletName: z.string().min(1).max(60),
};

// ----------------------------------------------------------------- events --

export const EVENT_TYPES = [
  'BOOKING_CONFIRMED',
  'CALL_FALLBACK_BOOKING_LINK',
  'CALLBACK_ACK',
  'DEPOSIT_PAYMENT_REQUEST',
  'BOOKING_REMINDER_T24',
  'BOOKING_REMINDER_T2',
  'WAITLIST_ADDED',
  'WAITLIST_TABLE_READY',
  'LOYALTY_POINTS_POSTED',
  'FEEDBACK_REQUEST',
  'EVENT_TICKET_ISSUED',
  'MARKETING_CAMPAIGN',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// -------------------------------------------------------------- registry --

export const TEMPLATES = {
  /**
   * Sent the instant a booking reaches CONFIRMED, from any channel:
   * phone AI, WhatsApp, web widget, Instagram, Google or a walk-in.
   */
  BOOKING_CONFIRMED: define({
    name: 'booking_confirmed_v1',
    category: 'UTILITY',
    correlation: 'BOOKING',
    params: z.object({
      ...base,
      partySize: z.number().int().min(1).max(50),
      /** Pre-formatted in the OUTLET's timezone, with the date visible. */
      dateTimeLabel: z.string().min(1).max(40),
      /** Signed, expiring token. Becomes the URL-button suffix. */
      manageToken: z.string().min(8).max(120),
    }),
    body: (p) => [p.guestName, p.outletName, String(p.partySize), p.dateTimeLabel],
    buttons: [{ kind: 'url', index: 0, suffix: (p) => p.manageToken }],
    approvalNote:
      'UTILITY. Body: 4 variables (guest, outlet, party size, date+time). ' +
      'One dynamic URL button "Manage booking" on https://g.<domain>/b/{{1}}',
  }),

  /**
   * Flow 1 exception path: the call was MISSED or ABANDONED, or the Voice AI was
   * unreachable. Must leave the queue within 30 seconds of the call record.
   */
  CALL_FALLBACK_BOOKING_LINK: define({
    name: 'call_fallback_booking_link_v1',
    category: 'UTILITY',
    correlation: 'CALL',
    params: z.object({
      outletName: z.string().min(1).max(60),
      bookingToken: z.string().min(8).max(120),
    }),
    body: (p) => [p.outletName],
    buttons: [{ kind: 'url', index: 0, suffix: (p) => p.bookingToken }],
    approvalNote:
      'UTILITY. "Sorry we missed your call" + booking link. 1 body variable, 1 URL button. ' +
      'Time-critical: dispatch SLA is 30s from the MISSED/ABANDONED call event.',
  }),

  /**
   * The AI host could not reach a person.
   *
   * Sent when a warm transfer rings the hunt group and nobody answers: the voice
   * agent raises a callback task for staff and this acknowledgement for the
   * guest, then ends the call. See docs/voice-agent-integration.md.
   *
   * Carries no guest name on purpose — a caller the platform has never seen has
   * no name to use, and "Thanks for calling, there." is worse than no greeting.
   */
  CALLBACK_ACK: define({
    name: 'callback_ack_v1',
    category: 'UTILITY',
    correlation: 'CALL',
    params: z.object({
      outletName: z.string().min(1).max(60),
      bookingToken: z.string().min(8).max(120),
    }),
    body: (p) => [p.outletName],
    buttons: [{ kind: 'url', index: 0, suffix: (p) => p.bookingToken }],
    approvalNote:
      'UTILITY. "Everyone was with guests — the team will call you back." ' +
      '1 body variable, 1 URL button. Paired with a callback task on the staff app, ' +
      'so the guest is never told someone will call unless a task actually exists.',
  }),

  /** Booking is HELD. The link expires with the hold window. */
  DEPOSIT_PAYMENT_REQUEST: define({
    name: 'deposit_payment_request_v1',
    category: 'UTILITY',
    correlation: 'BOOKING',
    params: z.object({
      ...base,
      /** Rendered from paise by the caller. Money never crosses as a float. */
      amountLabel: z.string().min(1).max(20),
      dateTimeLabel: z.string().min(1).max(40),
      holdExpiryLabel: z.string().min(1).max(40),
      payToken: z.string().min(8).max(120),
    }),
    body: (p) => [p.guestName, p.outletName, p.amountLabel, p.dateTimeLabel, p.holdExpiryLabel],
    buttons: [{ kind: 'url', index: 0, suffix: (p) => p.payToken }],
    approvalNote:
      'UTILITY. 5 body variables. URL button to the hosted Razorpay/Stripe page. ' +
      'The platform never holds funds and never stores card data — the button leaves our domain.',
  }),

  /** T-24h. One tap to confirm or cancel. */
  BOOKING_REMINDER_T24: define({
    name: 'booking_reminder_24h_v1',
    category: 'UTILITY',
    correlation: 'BOOKING',
    params: z.object({
      ...base,
      partySize: z.number().int().min(1).max(50),
      dateTimeLabel: z.string().min(1).max(40),
      bookingId: z.string().min(1).max(64),
    }),
    body: (p) => [p.guestName, p.outletName, String(p.partySize), p.dateTimeLabel],
    buttons: [
      { kind: 'quick_reply', index: 0, payload: (p) => `CONFIRM:${p.bookingId}` },
      { kind: 'quick_reply', index: 1, payload: (p) => `CANCEL:${p.bookingId}` },
    ],
    approvalNote:
      'UTILITY. 2 quick-reply buttons: "Confirm" / "Cancel". ' +
      'A tap opens the 24h service window, so the acknowledgement reply is free-form and free.',
  }),

  /** T-2h. Same shape as T-24h but a distinct approved template. */
  BOOKING_REMINDER_T2: define({
    name: 'booking_reminder_2h_v1',
    category: 'UTILITY',
    correlation: 'BOOKING',
    params: z.object({
      ...base,
      partySize: z.number().int().min(1).max(50),
      dateTimeLabel: z.string().min(1).max(40),
      bookingId: z.string().min(1).max(64),
    }),
    body: (p) => [p.guestName, p.outletName, String(p.partySize), p.dateTimeLabel],
    buttons: [
      { kind: 'quick_reply', index: 0, payload: (p) => `CONFIRM:${p.bookingId}` },
      { kind: 'quick_reply', index: 1, payload: (p) => `CANCEL:${p.bookingId}` },
    ],
  }),

  /** Party joined the waitlist: position and a quoted wait. */
  WAITLIST_ADDED: define({
    name: 'waitlist_added_v1',
    category: 'UTILITY',
    correlation: 'WAITLIST',
    params: z.object({
      ...base,
      position: z.number().int().min(1).max(99),
      waitMinutes: z.number().int().min(0).max(240),
      statusToken: z.string().min(8).max(120),
    }),
    body: (p) => [p.guestName, p.outletName, String(p.position), String(p.waitMinutes)],
    buttons: [{ kind: 'url', index: 0, suffix: (p) => p.statusToken }],
  }),

  /** A table freed up. This is the ping, and it is time-critical. */
  WAITLIST_TABLE_READY: define({
    name: 'waitlist_table_ready_v1',
    category: 'UTILITY',
    correlation: 'WAITLIST',
    params: z.object({
      ...base,
      holdMinutes: z.number().int().min(1).max(60),
    }),
    body: (p) => [p.guestName, p.outletName, String(p.holdMinutes)],
    approvalNote: 'UTILITY. Dispatch SLA is seconds, not minutes — the table is held.',
  }),

  /** Bill closed, points posted to the append-only ledger. */
  LOYALTY_POINTS_POSTED: define({
    name: 'loyalty_points_posted_v1',
    category: 'UTILITY',
    correlation: 'VISIT',
    params: z.object({
      ...base,
      pointsEarned: z.number().int().min(0),
      balance: z.number().int().min(0),
      tierName: z.string().min(1).max(30),
      walletToken: z.string().min(8).max(120),
    }),
    body: (p) => [
      p.guestName,
      String(p.pointsEarned),
      String(p.balance),
      p.tierName,
      p.outletName,
    ],
    buttons: [{ kind: 'url', index: 0, suffix: (p) => p.walletToken }],
  }),

  /**
   * The ONLY message that opens a conversation.
   *
   * Sent 12 hours after the visit completes. The guest has eaten and gone home;
   * the meal is still fresh enough to rate.
   *
   * The 1-10 rating CANNOT live in this template — a template may not carry an
   * interactive list. This message's job is to get a tap, which opens the 24h
   * service window; the rating list is then sent free-form (and free) by the
   * feedback FSM. See src/feedback/fsm.ts.
   */
  FEEDBACK_REQUEST: define({
    name: 'feedback_request_v1',
    category: 'UTILITY',
    correlation: 'VISIT',
    params: z.object({
      ...base,
      visitId: z.string().min(1).max(64),
    }),
    body: (p) => [p.guestName, p.outletName],
    buttons: [
      { kind: 'quick_reply', index: 0, payload: (p) => `FB_START:${p.visitId}` },
      { kind: 'quick_reply', index: 1, payload: (p) => `FB_DECLINE:${p.visitId}` },
    ],
    approvalNote:
      'UTILITY. 2 quick-reply buttons: "Rate my visit" / "No thanks". ' +
      'Sent T+12h from visit completion. Exactly one per visit, enforced by a unique index.',
  }),

  /** Ticket purchased: e-ticket with the QR the door scans. */
  EVENT_TICKET_ISSUED: define({
    name: 'event_ticket_issued_v1',
    category: 'UTILITY',
    correlation: 'TICKET',
    params: z.object({
      ...base,
      eventName: z.string().min(1).max(60),
      dateTimeLabel: z.string().min(1).max(40),
      tierName: z.string().min(1).max(30),
      quantity: z.number().int().min(1).max(20),
      /** Publicly reachable image of the ticket QR, served from our CDN. */
      qrImageUrl: z.string().url(),
      ticketToken: z.string().min(8).max(120),
    }),
    body: (p) => [
      p.guestName,
      p.eventName,
      p.outletName,
      p.dateTimeLabel,
      p.tierName,
      String(p.quantity),
    ],
    mediaHeader: (p) => ({ type: 'image', link: p.qrImageUrl }),
    buttons: [{ kind: 'url', index: 0, suffix: (p) => p.ticketToken }],
    approvalNote: 'UTILITY with an IMAGE header (the QR). 6 body variables, 1 URL button.',
  }),

  /**
   * Campaigns pick an approved MARKETING template at send time, so the name and
   * variables are supplied by the caller rather than fixed here. Everything else
   * — consent gate, quiet hours, throttle, attribution — still applies.
   */
  MARKETING_CAMPAIGN: define({
    name: '__dynamic__',
    category: 'MARKETING',
    correlation: 'CAMPAIGN',
    params: z.object({
      /** An approved MARKETING template name. Validated against the tenant's list. */
      templateName: z.string().min(1).max(120),
      bodyParams: z.array(z.string().max(200)).max(10).default([]),
      urlSuffix: z.string().max(120).optional(),
      campaignId: z.string().min(1).max(64),
    }),
    body: (p) => p.bodyParams,
    approvalNote:
      'MARKETING. Always billable, always consent-gated, never sent in quiet hours.',
  }),
} satisfies Record<EventType, AnyTemplateDefinition>;

export function getTemplate(event: EventType): AnyTemplateDefinition {
  const def: AnyTemplateDefinition = TEMPLATES[event];
  if (!def) throw new Error(`Unregistered event type: ${event}`);
  return def;
}

/** Events whose delivery SLA is seconds rather than minutes. */
export const TIME_CRITICAL: ReadonlySet<EventType> = new Set([
  'CALL_FALLBACK_BOOKING_LINK',
  'CALLBACK_ACK',
  'WAITLIST_TABLE_READY',
  'DEPOSIT_PAYMENT_REQUEST',
]);
