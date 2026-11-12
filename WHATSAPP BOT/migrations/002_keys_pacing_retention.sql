-- Per-tenant API keys, message pacing, and data retention.

-- ------------------------------------------------------------- API keys --

-- A key is never stored. Only its SHA-256 is, alongside a short public prefix
-- used to find the row without scanning every hash in the table.
--
-- Format issued to callers:  rok_<prefix>_<secret>
--   prefix  12 chars, stored in clear, indexed, safe to log
--   secret  43 chars, base64url of 32 random bytes, shown exactly once
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_prefix   text NOT NULL UNIQUE,
  key_hash     bytea NOT NULL,
  -- INTAKE lets a caller send messages; ADMIN also provisions outlets and keys.
  scope        text NOT NULL DEFAULT 'INTAKE' CHECK (scope IN ('INTAKE', 'ADMIN')),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  revoked_by   text
);

CREATE INDEX ON api_keys (tenant_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- pacing --

-- The guest a scheduled send is aimed at, so pacing and campaign exclusion can
-- be decided with one query instead of digging through the request payload.
ALTER TABLE scheduled_notifications ADD COLUMN phone_e164 text;

CREATE INDEX ON scheduled_notifications (phone_e164, fire_at)
  WHERE state = 'PENDING';

-- Answering "when did we last message this guest?" is now the hottest read on
-- the table, because every platform-timed send asks it.
CREATE INDEX ON messages (tenant_id, to_phone_e164, created_at DESC)
  WHERE state <> 'BLOCKED_BY_CONSENT';

-- ------------------------------------------------------------- retention --

-- An erasure request is itself a record we must keep, so it stores a hash of
-- the number rather than the number. Keeping the plaintext would defeat it.
CREATE TABLE erasure_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_sha256  bytea NOT NULL,
  requested_by  text NOT NULL,
  reason        text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  messages_redacted   int NOT NULL DEFAULT 0,
  sessions_redacted   int NOT NULL DEFAULT 0,
  consent_deleted     int NOT NULL DEFAULT 0
);

CREATE INDEX ON erasure_requests (tenant_id, requested_at DESC);
CREATE INDEX ON erasure_requests (phone_sha256);

-- Marks a row whose guest identifiers have been stripped. The row survives so
-- that counts, delivery rates and billing history stay correct; the person in
-- it does not.
ALTER TABLE messages          ADD COLUMN redacted_at timestamptz;
ALTER TABLE feedback_sessions ADD COLUMN redacted_at timestamptz;

CREATE INDEX ON messages (created_at) WHERE redacted_at IS NULL;

-- A redacted message keeps its event type, state and timings, and loses the
-- guest: the phone becomes a stable pseudonym and the Graph payload is dropped
-- entirely, since it holds the guest's name and their signed links.
COMMENT ON COLUMN messages.redacted_at IS
  'Guest identifiers stripped; event, state and timings retained for reporting.';

-- ---------------------------------------------------- suppressed sends --

-- A message held back by pacing is not a message. It never reaches Meta, has no
-- wamid and no lifecycle, so putting it in `messages` would corrupt delivery
-- rates and invent a state the spec's enumeration does not have.
--
-- It still has to be visible: "why did this guest not get their reminder?" is a
-- question the owner dashboard must be able to answer.
CREATE TABLE suppressed_sends (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id    uuid REFERENCES outlets(id) ON DELETE SET NULL,
  phone_e164   text NOT NULL,
  event_type   text NOT NULL,
  category     text NOT NULL,
  rule         text NOT NULL
                 CHECK (rule IN ('MIN_GAP','MARKETING_COOLDOWN','UPCOMING_BOOKING')),
  reason       text NOT NULL,
  correlation_id text,
  campaign_id  text,
  redacted_at  timestamptz,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON suppressed_sends (tenant_id, occurred_at DESC);
CREATE INDEX ON suppressed_sends (phone_e164);
CREATE INDEX ON suppressed_sends (rule, occurred_at DESC);
