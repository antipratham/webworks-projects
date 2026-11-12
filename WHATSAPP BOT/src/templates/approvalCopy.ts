/**
 * TEMPLATE COPY DECK
 *
 * The exact body copy submitted to Meta for approval, sitting alongside the
 * registry that declares each template's variables.
 *
 * The registry knows variable *shapes*; the words live in Meta's approved
 * templates. This file is the bridge, and the two must stay in step: the
 * `{{n}}` positions here match `body()` in ./registry.ts exactly, in the same
 * order. test/preview.test.ts fails if they drift — which matters, because a
 * mismatch means every live send of that template is rejected with 132000.
 *
 * English only. Hindi and Kannada get written once this copy is signed off —
 * translating draft copy twice is wasted work.
 */

export interface PreviewButton {
  kind: 'url' | 'quick_reply';
  label: string;
  /** For URL buttons: the base fixed at approval time. Only {{1}} varies. */
  baseUrl?: string;
}

export interface TemplatePreview {
  /** Meta's approved body, with {{n}} placeholders. */
  body: string;
  buttons?: PreviewButton[];
  header?: { type: 'image' | 'text'; text?: string };
  footer?: string;
}

export const PREVIEWS: Record<string, TemplatePreview> = {
  booking_confirmed_v1: {
    body:
      'Hi {{1}} — your table at {{2}} is confirmed.\n\n' +
      '{{3}} guests, {{4}}.\n\n' +
      'See you then. You can change or cancel any time using the button below.',
    buttons: [{ kind: 'url', label: 'Manage booking', baseUrl: 'https://g.eatlabs.in/b/' }],
  },

  call_fallback_booking_link_v1: {
    body:
      'Sorry we missed your call to {{1}}.\n\n' +
      'You can book a table right here — it takes under a minute. ' +
      'If you would rather speak to someone, just call us back.',
    buttons: [{ kind: 'url', label: 'Book a table', baseUrl: 'https://g.eatlabs.in/b/' }],
  },

  callback_ack_v1: {
    // One variable, not two: a caller the platform has never seen has no name,
    // and "Thanks for calling The Table, there." is worse than no greeting.
    body:
      'Thanks for calling {{1}}.\n\n' +
      'All agents are busy right now, so the team has your number and will ' +
      'reach out shortly. You can also book straight away below.',
    buttons: [{ kind: 'url', label: 'Book a table', baseUrl: 'https://g.eatlabs.in/b/' }],
  },

  deposit_payment_request_v1: {
    body:
      'Hi {{1}} — your table at {{2}} is held.\n\n' +
      'A deposit of {{3}} confirms it for {{4}}.\n\n' +
      'The hold expires in {{5}}, after which the table goes back on sale.',
    buttons: [{ kind: 'url', label: 'Pay deposit', baseUrl: 'https://pay.eatlabs.in/d/' }],
    footer: 'Payment is taken on the restaurant’s own gateway.',
  },

  booking_reminder_24h_v1: {
    body:
      'Hi {{1}} — a reminder that you are booked at {{2}} tomorrow.\n\n' +
      '{{3}} guests, {{4}}.\n\n' +
      'Are you still able to make it?',
    buttons: [
      { kind: 'quick_reply', label: 'Confirm' },
      { kind: 'quick_reply', label: 'Cancel' },
    ],
  },

  booking_reminder_2h_v1: {
    body:
      'Hi {{1}} — your table at {{2}} is in about 2 hours.\n\n' +
      '{{3}} guests, {{4}}.\n\n' +
      'See you shortly?',
    buttons: [
      { kind: 'quick_reply', label: 'Confirm' },
      { kind: 'quick_reply', label: 'Cancel' },
    ],
  },

  waitlist_added_v1: {
    body:
      'Hi {{1}} — you are on the waitlist at {{2}}.\n\n' +
      'You are number {{3}} in the queue, roughly {{4}} minutes.\n\n' +
      'We will message you the moment a table frees up.',
    buttons: [{ kind: 'url', label: 'View status', baseUrl: 'https://g.eatlabs.in/w/' }],
  },

  waitlist_table_ready_v1: {
    body:
      '{{1}}, your table at {{2}} is ready.\n\n' +
      'We will hold it for {{3}} minutes — please come to the host desk.',
  },

  loyalty_points_posted_v1: {
    body:
      'Thanks for visiting, {{1}}.\n\n' +
      'You earned {{2}} points tonight. Your balance is {{3}} points, {{4}} tier.\n\n' +
      'Points can be redeemed on your next visit to {{5}}.',
    buttons: [{ kind: 'url', label: 'View wallet', baseUrl: 'https://g.eatlabs.in/v/' }],
  },

  feedback_request_v1: {
    body:
      'Hi {{1}} — thanks for dining at {{2}}.\n\n' +
      'Could we ask how it went? Four taps, about thirty seconds, and it goes ' +
      'straight to the people who cooked and served for you.',
    buttons: [
      { kind: 'quick_reply', label: 'Rate my visit' },
      { kind: 'quick_reply', label: 'No thanks' },
    ],
  },

  event_ticket_issued_v1: {
    header: { type: 'image' },
    body:
      '{{1}}, you are in.\n\n' +
      '{{2}} at {{3}}\n{{4}}\n{{5}} × {{6}}\n\n' +
      'Show the QR code above at the door.',
    buttons: [{ kind: 'url', label: 'View ticket', baseUrl: 'https://g.eatlabs.in/t/' }],
  },

  winback_60d_v1: {
    body:
      'We have not seen you at {{2}} in a while, {{1}}.\n\n' +
      'There is a new menu on this month, and your table is waiting.',
    buttons: [{ kind: 'url', label: 'Book a table', baseUrl: 'https://g.eatlabs.in/b/' }],
    footer: 'Reply STOP to opt out.',
  },
};

/** Substitutes {{1}}, {{2}} … with the positional variables actually sent. */
export function render(templateName: string, vars: string[]): TemplatePreview & { rendered: string } {
  const preview = PREVIEWS[templateName] ?? {
    body: `(no preview copy registered for "${templateName}")\n\n${vars.map((v, i) => `{{${i + 1}}} = ${v}`).join('\n')}`,
  };
  const rendered = preview.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => vars[Number(n) - 1] ?? `{{${n}}}`);
  return { ...preview, rendered };
}

/** Highest {{n}} referenced — used by the test that keeps this in step with the registry. */
export function variableCount(templateName: string): number {
  const preview = PREVIEWS[templateName];
  if (!preview) return 0;
  const matches = [...preview.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return matches.length ? Math.max(...matches) : 0;
}
