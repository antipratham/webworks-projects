import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toE164, fromMetaWaId } from '../src/domain/phone.js';
import { evaluateTransition, metaStatusToState } from '../src/messages/stateMachine.js';

describe('phone normalisation', () => {
  test('accepts every input form the spec lists', () => {
    for (const input of [
      '9876543210',
      '09876543210',
      '+91 98765 43210',
      '+919876543210',
      '919876543210',
      '98765 43210',
      '  9876543210  ',
    ]) {
      assert.equal(toE164(input), '+919876543210', `failed on ${JSON.stringify(input)}`);
    }
  });

  test('rejects an Indian mobile that does not start 6-9', () => {
    for (const bad of ['1234567890', '5876543210', '2876543210']) {
      assert.throws(() => toE164(bad), /6, 7, 8 or 9/);
    }
  });

  test('rejects wrong lengths', () => {
    assert.throws(() => toE164('98765'), /10 digits/);
    assert.throws(() => toE164('98765432100000'), /10 digits/);
    // A leading 0 is stripped first, so this is nine digits, not a bad prefix.
    assert.throws(() => toE164('0123456789'), /10 digits/);
  });

  test('round-trips Meta wa_id back to canonical form', () => {
    assert.equal(fromMetaWaId('919876543210'), '+919876543210');
  });
});

describe('message state machine', () => {
  test('advances along the happy path', () => {
    assert.equal(evaluateTransition('QUEUED', 'SENT').kind, 'apply');
    assert.equal(evaluateTransition('SENT', 'DELIVERED').kind, 'apply');
    assert.equal(evaluateTransition('DELIVERED', 'READ').kind, 'apply');
    assert.equal(evaluateTransition('READ', 'REPLIED').kind, 'apply');
  });

  test('ignores out-of-order webhooks instead of corrupting state', () => {
    // Meta regularly delivers `read` before `delivered`.
    assert.equal(evaluateTransition('READ', 'DELIVERED').kind, 'ignore');
    assert.equal(evaluateTransition('DELIVERED', 'SENT').kind, 'ignore');
  });

  test('ignores duplicate webhooks', () => {
    assert.equal(evaluateTransition('DELIVERED', 'DELIVERED').kind, 'ignore');
  });

  test('allows failure from any live state but never resurrects a failure', () => {
    for (const from of ['QUEUED', 'SENT', 'DELIVERED', 'READ'] as const) {
      assert.equal(evaluateTransition(from, 'FAILED').kind, 'apply', `from ${from}`);
    }
    assert.equal(evaluateTransition('FAILED', 'DELIVERED').kind, 'ignore');
  });

  test('a consent-blocked message can never become sent', () => {
    assert.equal(evaluateTransition('BLOCKED_BY_CONSENT', 'SENT').kind, 'illegal');
    assert.equal(evaluateTransition('SENT', 'BLOCKED_BY_CONSENT').kind, 'illegal');
    assert.equal(evaluateTransition('QUEUED', 'BLOCKED_BY_CONSENT').kind, 'apply');
  });

  test('maps Meta status strings, and only the ones that mean something', () => {
    assert.equal(metaStatusToState('sent'), 'SENT');
    assert.equal(metaStatusToState('delivered'), 'DELIVERED');
    assert.equal(metaStatusToState('read'), 'READ');
    assert.equal(metaStatusToState('failed'), 'FAILED');
    assert.equal(metaStatusToState('deleted'), undefined);
  });
});
