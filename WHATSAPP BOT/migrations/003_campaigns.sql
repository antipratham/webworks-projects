-- Campaign fan-out: a segment, a cost estimate, a throttled send, attribution.

CREATE TABLE campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id       uuid NOT NULL REFERENCES outlets(id) ON DELETE RESTRICT,

  name            text NOT NULL,
  -- An approved MARKETING template. Validated against the registry before send.
  template_name   text NOT NULL,
  -- Positional body variables shared by every recipient. Per-guest values come
  -- from the recipient row.
  body_params     jsonb NOT NULL DEFAULT '[]'::jsonb,
  url_suffix      text,

  state           text NOT NULL DEFAULT 'DRAFT'
                    CHECK (state IN ('DRAFT','SCHEDULED','SENDING','SENT','PAUSED','CANCELLED')),

  scheduled_for   timestamptz,
  -- Sends per minute. Deliberately slow by default: a campaign must never
  -- saturate the number and delay a table-ready ping.
  send_rate_per_minute int NOT NULL DEFAULT 60 CHECK (send_rate_per_minute BETWEEN 1 AND 6000),

  -- Filled at build time so the owner sees the real number before committing.
  audience_total       int NOT NULL DEFAULT 0,
  audience_messageable int NOT NULL DEFAULT 0,

  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  cancelled_at    timestamptz
);

CREATE INDEX ON campaigns (tenant_id, created_at DESC);
CREATE INDEX ON campaigns (state) WHERE state IN ('SCHEDULED','SENDING');

-- One row per intended recipient, resolved when the campaign is built rather
-- than at send time. Building the audience up front is what makes the cost
-- estimate honest and the send resumable after a crash.
CREATE TABLE campaign_recipients (
  id            bigserial PRIMARY KEY,
  campaign_id   uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  phone_e164    text NOT NULL,
  -- Per-guest overrides for the template's positional variables.
  body_params   jsonb,
  url_suffix    text,

  state         text NOT NULL DEFAULT 'PENDING'
                  CHECK (state IN ('PENDING','QUEUED','SKIPPED','FAILED')),
  message_id    uuid REFERENCES messages(id) ON DELETE SET NULL,
  skip_reason   text,

  processed_at  timestamptz
);

-- A guest appears at most once in a campaign, whatever the segment says.
CREATE UNIQUE INDEX ON campaign_recipients (campaign_id, phone_e164);
CREATE INDEX ON campaign_recipients (campaign_id, state);

-- ---------------------------------------------------------- attribution --

-- A booking that followed a campaign message. Written by the Restaurant OS when
-- a booking is created, so attribution is recorded by the system that knows a
-- booking happened rather than inferred later from timestamps.
CREATE TABLE campaign_attributions (
  id            bigserial PRIMARY KEY,
  campaign_id   uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  message_id    uuid REFERENCES messages(id) ON DELETE SET NULL,
  phone_e164    text NOT NULL,
  booking_id    text NOT NULL,
  -- Money is in paise, as integers, everywhere.
  value_paise   bigint,
  attributed_at timestamptz NOT NULL DEFAULT now(),
  redacted_at   timestamptz
);

CREATE UNIQUE INDEX ON campaign_attributions (campaign_id, booking_id);
CREATE INDEX ON campaign_attributions (campaign_id);
