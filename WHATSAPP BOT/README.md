# Restaurant OS — WhatsApp notification service

Outbound WhatsApp for the AI-Powered Restaurant OS, on the Meta Cloud API.

This is **not a chat bot**. It is an event-driven notification service: the
Restaurant OS backend says *"this booking is confirmed"*, and this service works
out which approved template that becomes, in which language, whether policy
allows it, and when it goes. The only conversation it holds is the feedback
survey, and that one is a five-state machine, not a dialogue model.

---

## Why not Botpress / n8n / a flow builder

Roughly 95% of the requirement is business-initiated template delivery driven by
backend events. There is no conversation to model. What there *is*, per the
Functional & Technical Specification:

- a message state machine (`QUEUED · SENT · DELIVERED · READ · REPLIED · FAILED · BLOCKED_BY_CONSENT`)
- idempotency keys on every write that may be retried
- a consent gate that records `BLOCKED_BY_CONSENT` rather than silently dropping
- audit rows carrying actor, before, after, reason and IP
- no guest PII in logs
- server-side rate limits and classified retries
- delayed jobs (T-24h, T-2h, T+12h) that cancel when a booking changes
- three language variants per template
- per-tenant WhatsApp credentials

A flow builder is good at none of that, and running it alongside would create a
second source of truth for message state. The feedback conversation — the one
part a flow builder would suit — is ~200 lines in [src/feedback/fsm.ts](src/feedback/fsm.ts).

---

## Three WhatsApp constraints that shaped the design

**1. "Smart chips" are two different features with different rules.**

| | Usable when | Limit |
|---|---|---|
| Template quick-reply buttons | Any time (business-initiated) | 3 is the safe design target |
| Interactive list / reply buttons | **Only inside an open 24h service window** | 10 list rows / 3 buttons |

So the 1–10 rating cannot be the first message. The feedback template's job is to
earn a *tap*; the tap opens the window; the rating list follows free-form.

Meta has been raising total template button counts with combination rules —
verify current limits before designing anything wider than 3.

**2. The scale is 1–10, not 0–10.** A list holds ten rows and the rating has to
be one tap. Thresholds are unchanged: 9–10 promoter, 7–8 passive, ≤6 detractor.
[test/templates.test.ts](test/templates.test.ts) asserts the eleventh row throws.

**3. URL buttons carry only a suffix.** A template button is approved as
`https://g.<domain>/b/{{1}}` with the base domain fixed at approval time. Signed
tokens must fit a path/query suffix. There is a test that fails if any registry
entry tries to pass a full URL.

---

## Architecture

```
Restaurant OS backend ── Authorization: Bearer rok_… (per-tenant key)
        │  POST /v1/notifications   (Idempotency-Key required)
        ▼
  intake ─ registry ─ consent ─ pacing ─ BullMQ ─ dispatcher ─► Graph API
    │         │          │        │                                 │
    │    zod-validated  fail-   min gap ·                           │
    │    variables      closed  cooldown                            │
    ▼                                                               ▼
 messages + message_events (append-only)      Meta webhook ─► status + taps
 suppressed_sends (why we held back)                 │
 audit_log · erasure_requests                        ▼
                                              feedback FSM (2-way)
```

### Layout

| Path | What lives there |
|---|---|
| [src/templates/registry.ts](src/templates/registry.ts) | Every message the platform can send, with its zod variable schema. **Start here.** |
| [src/templates/approvalCopy.ts](src/templates/approvalCopy.ts) | The exact body copy submitted to Meta, kept in step with the registry by a test |
| [src/notifications/service.ts](src/notifications/service.ts) | Intake: validate, gate, pace, persist, queue |
| [src/policy/consent.ts](src/policy/consent.ts) | Consent gate and quiet hours |
| [src/policy/pacing.ts](src/policy/pacing.ts) | Minimum gap, marketing cooldown, upcoming-booking exclusion |
| [src/tenancy/apiKeys.ts](src/tenancy/apiKeys.ts) | Per-tenant keys: hashed at rest, never retrievable |
| [src/tenancy/secretSource.ts](src/tenancy/secretSource.ts) | Where the encryption key is read from: env, mounted file, AWS or Vault |
| [src/campaigns/service.ts](src/campaigns/service.ts) | Segment → cost estimate → throttled send → attribution |
| [src/tenancy/credentials.ts](src/tenancy/credentials.ts) | Per-outlet WABA, AES-256-GCM at rest |
| [src/queue/dispatchWorker.ts](src/queue/dispatchWorker.ts) | Throughput, retries, Meta error handling |
| [src/queue/scheduler.ts](src/queue/scheduler.ts) | T-24h, T-2h, T+12h; cancel-on-change |
| [src/queue/reconcile.ts](src/queue/reconcile.ts) | Recovers messages stranded between the Postgres commit and the Redis enqueue |
| [src/retention/retention.ts](src/retention/retention.ts) | Scheduled redaction and immediate erasure |
| [src/observability/metrics.ts](src/observability/metrics.ts) | Prometheus metrics; see [docs/alerts.md](docs/alerts.md) |
| [src/feedback/fsm.ts](src/feedback/fsm.ts) | The only two-way surface |
| [src/whatsapp/errors.ts](src/whatsapp/errors.ts) | Meta error codes → retry or don't |
| [src/messages/stateMachine.ts](src/messages/stateMachine.ts) | Lifecycle, tolerant of out-of-order webhooks |
| [src/integrations/voiceTemplateMap.ts](src/integrations/voiceTemplateMap.ts) | Voice platform's 4 template names → our events (pure, unit-tested) |
| [src/api/routes/voiceCompat.ts](src/api/routes/voiceCompat.ts) | `POST /messages/whatsapp`, shaped as the voice contract defines it |
| [migrations/](migrations/) | Schema |
| [docs/voice-agent-integration.md](docs/voice-agent-integration.md) | How the AI call agent hands off to this service |
| [docs/alerts.md](docs/alerts.md) | Prometheus alert rules and the runbook lines that go with them |

---

## Authentication

**There is no shared key.** Every caller presents a per-tenant key, and the key
decides which tenant it is acting for — so a caller cannot name a tenant it does
not hold a key for, and cross-tenant access stops being something a handler has
to remember to check.

```
Authorization: Bearer rok_<prefix>_<secret>
```

Keys are stored as SHA-256 plus a short public prefix for the lookup. The secret
is shown once at creation; no endpoint can return it again, because there is
nothing to return. Where a request body still carries `tenantId`, it is verified
against the key and rejected on mismatch rather than ignored.

The first key comes from the bootstrap secret, which can mint keys and nothing
else — it cannot send a message or read a guest:

```bash
curl -X POST $BASE/admin/v1/keys/bootstrap \
  -H "authorization: Bearer $BOOTSTRAP_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"tenantId":"<uuid>","name":"restaurant-os","scope":"ADMIN","createdBy":"you"}'
```

After that a tenant mints its own with `POST /admin/v1/keys`, lists prefixes and
usage with `GET /admin/v1/keys`, and revokes with `DELETE /admin/v1/keys/:id`.

---

## Pacing

Consent decides whether a guest may be messaged at all. Pacing decides whether
they should be messaged *now*. A system that only answers the first question
sends bursts.

The rule behind all three: **a message that answers something the guest just did
always goes; a message the platform decided to send on a timer has to earn its
place.**

| Rule | Default | What it prevents |
|---|---|---|
| `MIN_MESSAGE_GAP_HOURS` | 8 | Booking 25h ahead and getting the T-24h reminder an hour after the confirmation |
| `MARKETING_COOLDOWN_DAYS` | 14 | Two campaigns reaching the same guest in a week |
| `CAMPAIGN_BOOKING_EXCLUSION_HOURS` | 48 | "We miss you, come back" landing the morning of someone's anniversary dinner |

Only reminders, the feedback nudge and marketing are paced. Confirmations,
deposit links, tickets, waitlist pings, points and call fallbacks are never held
back — the guest just acted and is expecting them.

A suppressed send returns `202` with `state: "SUPPRESSED"` and the rule that
held it, and is recorded in `suppressed_sends` — **not** in `messages`, which
would invent a lifecycle state and corrupt every delivery rate on the dashboard.
`GET /v1/suppressed` answers "why did this guest not get their reminder?".

---

## Campaigns

Build and send are separate calls on purpose. The build resolves the audience,
de-duplicates it, checks consent and reports what it would cost. **Nothing
leaves until someone starts it** — an owner should never learn the size of a
send from the invoice.

```bash
POST /v1/campaigns            # resolve the audience, return the cost
POST /v1/campaigns/:id/start  # begin sending
POST /v1/campaigns/:id/pause
GET  /v1/campaigns/:id        # recipients, delivery, attribution
POST /v1/campaigns/attribution
```

The build returns `total`, `messageable`, `blockedByConsent` and `duplicates`.
**`messageable` is the only number to quote** — `total` includes guests the
consent gate will refuse.

Three things worth knowing:

- **The audience is resolved up front**, not streamed at send time. That is what
  makes the cost estimate honest, and it makes a send resumable: a crash halfway
  leaves rows marked `PENDING` that get picked up again.
- **It sends slowly by default** — 60/minute, configurable per campaign. A
  campaign that saturates the number delays the table-ready ping for a guest
  standing at the host desk, and that trade is never worth making.
- **Every message goes through `enqueueNotification`.** Consent, quiet hours,
  pacing, the marketing cooldown, idempotency and the audit trail all apply. There
  is no bulk path that skips them — that is exactly how a campaign ends up
  messaging someone who opted out.

Attribution is written by the Restaurant OS when a booking follows a campaign
message, rather than inferred here from timestamps: the system that knows a
booking happened is the one that should record it.

---

## Privacy

Two obligations, one mechanism: scheduled retention and on-request erasure.

**Redaction, not deletion.** Deleting rows would destroy delivery rates,
template quality history and the audit trail. So the row survives and the person
in it does not: the phone becomes a keyed HMAC pseudonym, the Graph payload is
dropped entirely (it carries the guest's name and their signed links), consent
rows are deleted outright, and any pending scheduled send is cancelled — erasure
has to stop future contact, not only erase past contact.

The pseudonym is an HMAC keyed on `CREDENTIALS_ENC_KEY`, not a plain hash. A
SHA-256 of a ten-digit Indian mobile is brute-forceable in seconds, so it would
not be anonymisation at all.

```bash
POST /v1/privacy/erasure   # immediate, synchronous, fully audited
GET  /v1/privacy/erasure   # proof it happened, matched on a hash of the number
```

The spec allows seven days. Doing it on request costs nothing extra and means
there is never a backlog to prove you cleared. `RETENTION_DAYS` (default 90)
drives the daily sweep for everything nobody asked about.

---

## The feedback conversation

The only place the platform listens.

```
T+12h   FEEDBACK_REQUEST template      ──►  guest taps "Rate my visit"
                                            (tap opens the 24h window)
        1–10 rating, interactive list  ──►  ≤6 alerts the manager immediately
        food / service / ambience      ──►  three taps
        routed close                        ≥9 review link · 7–8 thanks · ≤6 apology
```

Two decisions worth knowing:

- **The rating is asked first**, though the spec words it "three questions plus
  NPS". The rating routes the outcome and triggers the five-minute manager
  alert. Asking it last means a guest who drops out after question two tells you
  nothing.
- **The manager alert fires on the rating**, not on survey completion. Five
  minutes is a promise, and the guest may never finish.

Every message inside the window is free-form, so none of it needs a template.

---

## Running it

```bash
docker compose up -d          # postgres + redis
cp .env.example .env          # then fill it in
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # CREDENTIALS_ENC_KEY
npm install
npm run migrate
npm run dev
```

```bash
npm test          # 32 tests, no network, no database
npm run typecheck
```

The tests that matter are in [test/templates.test.ts](test/templates.test.ts)
and [test/preview.test.ts](test/preview.test.ts): they build the real Graph API
payload for every event and assert both the variable count and the approval copy
against the registry. That is what stops Meta's `132000` from ever reaching a
guest.

CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) runs three jobs on
every push touching this directory: types and unit tests; migrations applied
twice against real Postgres and Redis with the service booted and its auth
checked; and a scan that fails the build if a `.env` or anything resembling a
live token is committed — the one mistake a revert cannot undo in a public repo.

There is also a load test, outside `npm test` because it needs the service and
its datastores running:

```bash
npm run loadtest -- --rate 40 --seconds 20
```

It is not measuring throughput — delivery is capped by Meta's per-number tier,
not by us. It checks that intake stays responsive while the dispatcher is
saturated, that urgent messages keep their priority under load, and that nothing
is stranded afterwards. Last run: 800 messages at 40/s intake, p99 194ms, zero
failures, zero orphans, drained at the tier's 5/s.

`npm run dev` runs API and workers in one process. Split them (`npm start` +
`npm run worker`) before campaign volume gets real. The retention sweep runs in
the API process; pin it to one instance or move it to a scheduled job if you run
several.

---

## Testing before Meta access

A local simulator exists outside this repo: a mock Graph API, a WhatsApp-style
UI with working buttons, and correctly-signed webhooks flowing back in. It needs
no WABA, no payment method, no approved templates and no phone number — the only
thing that changes is `GRAPH_API_BASE`, so the service cannot tell it is a demo.

It has already been used to walk every scenario end to end, including the full
feedback conversation in all three rating bands. Ask for the `demo/` bundle if
you need it; it is deliberately not published here.

---

## What the integration owner needs to hand over

This service builds the bot; someone else owns the Meta side. Ask them for:

- [ ] **A payment method on the Meta account.** Visible as a required action in
      the app dashboard today. Free-tier conversations can only be *customer*-
      initiated, so an outbound-only service cannot send a single message until
      this is resolved. **This blocks everything.**
- [ ] The app moved from **In development** to **Live** (test numbers only until then)
- [ ] **Tech Provider onboarding + Embedded Signup** configured — required for
      the multi-tenant model, where each restaurant connects its own WABA
- [ ] Webhook callback URL pointed at `POST /webhook`, subscribed to `messages`
- [ ] `META_APP_SECRET` (for signature verification) and the verify token string
- [ ] The template approval owner, and expected turnaround
- [ ] Each outlet's current messaging tier

Credentials then arrive via `PUT /admin/v1/credentials` and are sealed at rest.
Nothing WhatsApp-related belongs in an env var.

---

## Templates to submit for approval

**Eleven named templates, English only** — plus one per marketing campaign as
they are written. Names and variable counts are in the registry; `approvalNote`
on each entry carries what to submit, and the exact body copy is in
[src/templates/approvalCopy.ts](src/templates/approvalCopy.ts).

The locale plumbing is generic and every send carries a language, so adding
Hindi or Kannada later is content work plus a Meta submission, not a migration.

| Event | Template | Category | Buttons |
|---|---|---|---|
| `BOOKING_CONFIRMED` | `booking_confirmed_v1` | UTILITY | 1 URL |
| `CALL_FALLBACK_BOOKING_LINK` | `call_fallback_booking_link_v1` | UTILITY | 1 URL |
| `CALLBACK_ACK` | `callback_ack_v1` | UTILITY | 1 URL |
| `DEPOSIT_PAYMENT_REQUEST` | `deposit_payment_request_v1` | UTILITY | 1 URL |
| `BOOKING_REMINDER_T24` | `booking_reminder_24h_v1` | UTILITY | 2 quick reply |
| `BOOKING_REMINDER_T2` | `booking_reminder_2h_v1` | UTILITY | 2 quick reply |
| `WAITLIST_ADDED` | `waitlist_added_v1` | UTILITY | 1 URL |
| `WAITLIST_TABLE_READY` | `waitlist_table_ready_v1` | UTILITY | — |
| `LOYALTY_POINTS_POSTED` | `loyalty_points_posted_v1` | UTILITY | 1 URL |
| `FEEDBACK_REQUEST` | `feedback_request_v1` | UTILITY | 2 quick reply |
| `EVENT_TICKET_ISSUED` | `event_ticket_issued_v1` | UTILITY | 1 URL, image header |
| `MARKETING_CAMPAIGN` | per campaign | MARKETING | per campaign |

**Submit these in week one.** Rejections cost days, and nothing else on the
critical path depends on the code being finished first.

---

## Known gaps

- **Token expiry is detected, not refreshed.** A dead token flips the outlet to
  `TOKEN_EXPIRED`, stops the retries and fires an alert, but re-authenticating is
  a manual Embedded Signup run. Deliberate: automatic re-auth needs credentials
  this service should not hold.
- **Campaign attribution needs the backend to call it.** The endpoint and the
  reporting are here; something has to post a booking to it.
- Meta's per-message pricing and category rules move. Confirm the current rate
  card before quoting campaign costs — utility templates inside an open window
  are cheaper than marketing ones, and that gap drives the feedback design.
