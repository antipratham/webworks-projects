# How the voice agent hands off to this service

Notes from reading [`vinodwebworksco/eatlabs-llm-voice`](https://github.com/vinodwebworksco/eatlabs-llm-voice)
at `main` (pushed 2026-09-25). **Nothing is wired up yet** — this is the map for
when it is.

## What the voice agent is

A LiveKit-based phone agent, all open-source models, self-hosted:

```
caller → Plivo SIP → LiveKit → agent worker → Whisper large-v3   (speech-to-text)
                                            → Qwen3-30B-A3B      (language, via vLLM)
                                            → Indic Parler-TTS   (speech)
                                            → platform API       (bookings, messages)
```

English, Hindi and Kannada — the same three languages this service sends in.

**The critical fact:** *"The agent never touches a database. Everything it does
goes through the platform API described in `contracts/platform-api.yaml`."*

So there is no direct voice-agent → WhatsApp-service link, and there should not
be one. The voice agent calls the **platform**, and the platform calls us. That
contract is already written, versioned, and has a working mock behind it.

## The handover-failure path you described

In `agent/tools.py`, `_transfer()`:

1. Releases the availability hold (so the table goes back on sale immediately).
2. Rings `transfer_targets` from the outlet's voice config — filtered to
   `available`, sorted by `order`, with `ring_timeout_seconds` (default 20).
3. **If a staff member answers** → `TRANSFERRED`, call bridged, nothing for us.
4. **If nobody answers** → the agent says its `no_staff` line, then `_callback()`
   fires two platform calls and ends the call:

```python
session.platform.callback_task({
    "outlet_id": ..., "phone": ..., "reason": "NO_STAFF_AVAILABLE",
    "note": note[:500], "call_id": ...,
}, idempotency_key)

session.platform.whatsapp({
    "phone": ..., "outlet_id": ..., "template": "CALLBACK_ACK", "call_id": ...,
}, idempotency_key)
```

That second call is our entry point. It lands on `POST /messages/whatsapp`.

## Rule R-01 and the ABANDONED case — decided

From `contracts/platform-api.yaml`, on `/callback-tasks`:

> **Never created after a caller hangs up mid-call.** Rule R-01 is absolute: a
> hang-up before the commit leaves no trace and triggers no follow-up of any kind.

And in `_transfer()`:

```python
if session.ended:
    # The caller hung up while staff were ringing: R-01 - no task, no message.
    return {"transferred": False, "call_ended": True}
```

Our FRD §3.4 says `MISSED` *and* `ABANDONED` both trigger a WhatsApp fallback
within 30 seconds. **Decision taken: they do.** A caller who rang off before
anyone picked up gets the booking link.

The two rules do not actually collide, because they describe different moments:

| Case | Who detects it | What we send |
|---|---|---|
| Nobody and no AI answered (`MISSED`, `AI_UNREACHABLE`) | telephony / backend | `CALL_FALLBACK_BOOKING_LINK` |
| Guest hung up before any pickup (`ABANDONED`) | telephony / backend | `CALL_FALLBACK_BOOKING_LINK` |
| No staff answered a warm transfer | voice agent | `CALLBACK_ACK` + a staff callback task |
| Guest hung up **mid-ring**, after talking to the AI | voice agent (R-01) | **nothing** |

Only the last row is a suppression, and it needs no work from us: the voice
agent simply never calls. Rows one and two are triggered by the telephony layer,
not the agent, so R-01 never applies to them.

One thing for whoever wires the telephony side: `ABANDONED` should be measured
from *ring start*, and a caller who hangs up inside the first second or two is
almost certainly a misdial. Worth a small floor — a second or two — before the
message fires, or some guests get a "sorry we missed you" for a call they never
meant to place.

## Contract alignment

Already matching, no work needed:

- **`MessageStatus` enum is identical** to ours — `QUEUED · SENT · DELIVERED ·
  READ · REPLIED · FAILED · BLOCKED_BY_CONSENT`.
- **Idempotency-Key is required** on every messaging call, and the mock stores
  `request_hash` + cached response — the same scheme as [src/api/idempotency.ts](../src/api/idempotency.ts).
- **Consent is enforced platform-side** and `BLOCKED_BY_CONSENT` is returned. The
  contract notes the agent only sends transactional messages, so our
  category-driven gate is the right shape.
- **Phone numbers are E.164** throughout.

### Template names — mapped, and the adapter is built

The contract's enum is `[BOOKING_CONFIRMED, PAYMENT_LINK, CALLBACK_ACK, BOOKING_LINK]`.

| Voice contract | Our event | Status |
|---|---|---|
| `BOOKING_CONFIRMED` | `BOOKING_CONFIRMED` | mapped |
| `PAYMENT_LINK` | `DEPOSIT_PAYMENT_REQUEST` | mapped |
| `BOOKING_LINK` | `CALL_FALLBACK_BOOKING_LINK` | mapped |
| `CALLBACK_ACK` | `CALLBACK_ACK` | **added to the registry** — needs Meta approval |

The translation lives in [src/integrations/voiceTemplateMap.ts](../src/integrations/voiceTemplateMap.ts)
— a pure module with no imports beyond types, so it is unit-tested against the
real schemas without a database. The HTTP surface is
[src/api/routes/voiceCompat.ts](../src/api/routes/voiceCompat.ts).

**`POST /messages/whatsapp` is live**, shaped exactly as the contract defines it,
returning a `MessageReceipt`. The backend can forward the call unchanged rather
than writing its own translation layer.

Variable keys the backend sends (the contract types them all as strings; the
adapter coerces where our schema wants a number):

| Template | Variables |
|---|---|
| `BOOKING_CONFIRMED` | `guest_name`, `outlet_name`, `party_size`, `slot_label`, `manage_token`, `booking_id` |
| `PAYMENT_LINK` | `guest_name`, `outlet_name`, `amount_label`, `slot_label`, `hold_expiry_label`, `pay_token`, `booking_id` |
| `CALLBACK_ACK` | `outlet_name`, `booking_token` |
| `BOOKING_LINK` | `outlet_name`, `booking_token` |

Tenancy needs no special handling. The contract carries no tenant because
`PLATFORM_TOKEN` identifies it — and that is exactly what a per-tenant API key
is, so the two line up directly. Issue the tenant a key, set it as
`PLATFORM_TOKEN`, and the adapter reads the tenant from it. No extra header, and
no way for one restaurant's token to reach another's guests.

### The two templates the contract routes through an outbox

From the contract:

> the booking confirmation is **not** sent through this endpoint. It is written
> to the outbox inside the `createBooking` transaction.

Its mock returns 422 for `BOOKING_CONFIRMED` and `PAYMENT_LINK` on this endpoint.
**Our adapter accepts all four anyway**, deliberately: that 422 exists to stop the
*voice agent* sending them directly, but this endpoint is what the *backend's
outbox drain* calls. Giving the drain one door instead of two is the point.

Both paths still run through `enqueueNotification`, so consent, quiet hours,
idempotency, variable validation and the audit trail apply identically. There is
no second route to Meta.

One thing to confirm with whoever builds the outbox: **each outbox row must carry
its own idempotency key**, stable across retries. Without it, a drain retry
double-messages the guest — and the drain is exactly the component most likely to
retry.

## What is left before connecting

Everything on our side is done except approval:

1. ~~Add `CALLBACK_ACK` to the registry~~ — done, with English copy. Hindi and
   Kannada still to write, and **it needs Meta approval like any other template.**
2. ~~Build the adapter~~ — done. `POST /messages/whatsapp`, contract-shaped.
3. ~~Settle the R-01 / `ABANDONED` question~~ — decided above.
4. Point the agent's `PLATFORM_URL` at the real backend. Per its README,
   *"Switching from the mock platform to the real one is only a change of
   `PLATFORM_URL` and `PLATFORM_TOKEN`."*

Try the path now, without any of the voice stack running:

```bash
npm run demo:send voice-callback   # CALLBACK_ACK through the contract endpoint
npm run demo:send voice-booking    # the outbox drain's door
```

## Useful for testing

`mock_platform/` is a working FastAPI implementation of the whole contract, and
`tests/` has 132 scripted call scenarios. When we do connect, the voice agent can
be pointed at a stub that forwards `/messages/whatsapp` into our intake API —
letting the full call → no-staff → WhatsApp path be exercised without a GPU, a
phone number, or Meta.
