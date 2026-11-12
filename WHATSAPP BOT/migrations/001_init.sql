-- Restaurant OS · outbound WhatsApp notification service
-- Everything here is tenant-scoped. There is no global WABA.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- tenancy --

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outlets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- the outlet id as the Restaurant OS backend knows it
  external_id   text NOT NULL,
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);

-- One WABA phone number per outlet. Token is AES-256-GCM sealed at rest;
-- it is never logged, never returned by any API, never put in an env var.
CREATE TABLE wa_credentials (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id          uuid NOT NULL UNIQUE REFERENCES outlets(id) ON DELETE CASCADE,
  waba_id            text NOT NULL,
  phone_number_id    text NOT NULL,
  display_number     text NOT NULL,
  access_token_enc   bytea NOT NULL,
  -- Meta messaging tier: TIER_250 / TIER_1K / TIER_10K / TIER_100K / UNLIMITED
  messaging_tier     text NOT NULL DEFAULT 'TIER_1K',
  status             text NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE','DISABLED','TOKEN_EXPIRED')),
  rotated_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON wa_credentials (phone_number_id);

-- ---------------------------------------------------------------- consent --

-- Mirror of the Restaurant OS consent record, pushed to us on change.
-- Fail-closed: an absent row is UNKNOWN, and UNKNOWN blocks marketing.
CREATE TABLE guest_consent (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_e164    text NOT NULL,
  channel       text NOT NULL DEFAULT 'WHATSAPP',
  state         text NOT NULL
                  CHECK (state IN ('GRANTED','DENIED','WITHDRAWN','UNKNOWN')),
  locale        text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','hi','kn')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, phone_e164, channel)
);

-- --------------------------------------------------------------- messages --

CREATE TABLE messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  outlet_id         uuid NOT NULL REFERENCES outlets(id) ON DELETE RESTRICT,

  event_type        text NOT NULL,
  category          text NOT NULL
                      CHECK (category IN ('UTILITY','MARKETING','AUTHENTICATION','SERVICE')),

  to_phone_e164     text NOT NULL,
  locale            text NOT NULL CHECK (locale IN ('en','hi','kn')),

  template_name     text,           -- null for free-form SERVICE messages
  template_language text,
  payload           jsonb NOT NULL, -- exact Graph API request body

  state             text NOT NULL DEFAULT 'QUEUED'
                      CHECK (state IN ('QUEUED','SENT','DELIVERED','READ','REPLIED',
                                       'FAILED','BLOCKED_BY_CONSENT')),

  wamid             text,           -- Meta message id, set on SENT
  error_code        text,
  error_detail      text,
  attempts          int NOT NULL DEFAULT 0,

  -- correlation back into the Restaurant OS domain
  correlation_type  text,           -- BOOKING | WAITLIST | VISIT | TICKET | CAMPAIGN | CALL
  correlation_id    text,
  campaign_id       text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  terminal_at       timestamptz
);

CREATE INDEX ON messages (tenant_id, created_at DESC);
CREATE INDEX ON messages (correlation_type, correlation_id);
CREATE INDEX ON messages (state) WHERE state IN ('QUEUED','SENT');
CREATE UNIQUE INDEX ON messages (wamid) WHERE wamid IS NOT NULL;
CREATE INDEX ON messages (campaign_id) WHERE campaign_id IS NOT NULL;

-- Append-only transition log. One row per state change, forever.
CREATE TABLE message_events (
  id            bigserial PRIMARY KEY,
  message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  from_state    text,
  to_state      text NOT NULL,
  actor         text NOT NULL,   -- SYSTEM | META_WEBHOOK | user id
  reason        text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON message_events (message_id, occurred_at);

-- ----------------------------------------------------------- idempotency --

CREATE TABLE idempotency_keys (
  key            text PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_hash   text NOT NULL,
  response_body  jsonb NOT NULL,
  response_code  int NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '7 days'
);

CREATE INDEX ON idempotency_keys (expires_at);

-- ---------------------------------------------------- scheduled delivery --

-- Reminders and hold expiries live here so a booking change can cancel them.
-- BullMQ holds the timer; this table holds the truth.
CREATE TABLE scheduled_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id         uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  event_type        text NOT NULL,
  correlation_type  text NOT NULL,
  correlation_id    text NOT NULL,
  fire_at           timestamptz NOT NULL,
  request           jsonb NOT NULL,
  job_id            text,
  state             text NOT NULL DEFAULT 'PENDING'
                      CHECK (state IN ('PENDING','FIRED','CANCELLED','SUPERSEDED')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- At most one live reminder of a given type per booking.
CREATE UNIQUE INDEX ON scheduled_notifications (correlation_type, correlation_id, event_type)
  WHERE state = 'PENDING';

-- --------------------------------------------------------------- feedback --

-- The only two-way surface in the system.
CREATE TABLE feedback_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id      uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  visit_id       text NOT NULL,
  phone_e164     text NOT NULL,
  locale         text NOT NULL DEFAULT 'en',

  step           text NOT NULL DEFAULT 'AWAITING_OPT_IN'
                   CHECK (step IN ('AWAITING_OPT_IN','Q1','Q2','Q3','RATING',
                                   'COMPLETED','EXPIRED','DECLINED')),
  answers        jsonb NOT NULL DEFAULT '{}'::jsonb,
  rating         int CHECK (rating BETWEEN 1 AND 10),

  -- 24h service window, opened by the guest's first inbound message
  window_opened_at  timestamptz,
  window_expires_at timestamptz,
  last_prompt_at    timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);

-- "One nudge per visit" is a database constraint, not a code convention.
CREATE UNIQUE INDEX ON feedback_sessions (tenant_id, visit_id);
CREATE INDEX ON feedback_sessions (phone_e164, step)
  WHERE step NOT IN ('COMPLETED','EXPIRED','DECLINED');

-- ------------------------------------------------------------------ audit --

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid,
  actor        text NOT NULL,
  action       text NOT NULL,
  entity       text NOT NULL,
  entity_id    text,
  before_state jsonb,
  after_state  jsonb,
  reason       text,
  ip           inet,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX ON audit_log (entity, entity_id);
