/**
 * Message lifecycle, exactly as the spec enumerates it:
 *   QUEUED · SENT · DELIVERED · READ · REPLIED · FAILED · BLOCKED_BY_CONSENT
 *
 * Two things make this less trivial than it looks:
 *
 *  1. Meta's status webhooks arrive out of order and more than once. A `read`
 *     can land before its `delivered`, and both can be redelivered days later.
 *     So progress is monotonic: a transition that would move backwards is
 *     ignored, not rejected. Ignoring is the correct behaviour, not a shortcut.
 *
 *  2. FAILED can arrive after SENT — Meta accepts the message, then gives up on
 *     it. So FAILED is reachable from every non-terminal state.
 */

export const MESSAGE_STATES = [
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'REPLIED',
  'FAILED',
  'BLOCKED_BY_CONSENT',
] as const;

export type MessageState = (typeof MESSAGE_STATES)[number];

/** Higher rank = further along. Terminal failures sit outside the ladder. */
const RANK: Record<MessageState, number> = {
  QUEUED: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  REPLIED: 4,
  FAILED: -1,
  BLOCKED_BY_CONSENT: -1,
};

export const TERMINAL_STATES: ReadonlySet<MessageState> = new Set([
  'FAILED',
  'BLOCKED_BY_CONSENT',
  'REPLIED',
]);

export type TransitionOutcome =
  | { kind: 'apply'; to: MessageState }
  | { kind: 'ignore'; reason: string }
  | { kind: 'illegal'; reason: string };

export function evaluateTransition(from: MessageState, to: MessageState): TransitionOutcome {
  if (from === to) {
    return { kind: 'ignore', reason: 'duplicate webhook' };
  }

  // Once BLOCKED_BY_CONSENT, nothing happened and nothing can.
  if (from === 'BLOCKED_BY_CONSENT') {
    return { kind: 'illegal', reason: 'message was never sent' };
  }

  // A message can fail at any point before it is finished.
  if (to === 'FAILED') {
    return from === 'FAILED' || from === 'REPLIED'
      ? { kind: 'ignore', reason: 'already terminal' }
      : { kind: 'apply', to };
  }

  if (from === 'FAILED') {
    // Meta occasionally reports a delivery for a message it also failed.
    // The failure is the record of truth; keep it.
    return { kind: 'ignore', reason: 'already failed' };
  }

  // BLOCKED_BY_CONSENT is only ever set at dispatch time, from QUEUED.
  if (to === 'BLOCKED_BY_CONSENT') {
    return from === 'QUEUED'
      ? { kind: 'apply', to }
      : { kind: 'illegal', reason: 'consent is checked before sending, not after' };
  }

  return RANK[to] > RANK[from]
    ? { kind: 'apply', to }
    : { kind: 'ignore', reason: 'out-of-order webhook' };
}

/** Maps Meta's `statuses[].status` values onto our enumeration. */
export function metaStatusToState(status: string): MessageState | undefined {
  switch (status) {
    case 'sent':
      return 'SENT';
    case 'delivered':
      return 'DELIVERED';
    case 'read':
      return 'READ';
    case 'failed':
      return 'FAILED';
    // `deleted` and `warning` carry no lifecycle meaning for us.
    default:
      return undefined;
  }
}
