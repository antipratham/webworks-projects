import { pool, one, query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { toE164 } from '../domain/phone.js';
import { AppError } from '../domain/errors.js';
import { logger } from '../logging/logger.js';
import { getCredentialsByExternalId } from '../tenancy/credentials.js';
import { enqueueNotification } from '../notifications/service.js';
import { getConsent } from '../policy/consent.js';

/**
 * CAMPAIGN FAN-OUT
 *
 * The piece that turns "send this to everyone who has not visited in 60 days"
 * into individual messages, without any of the ways that normally goes wrong.
 *
 * Three decisions shape it:
 *
 *  1. THE AUDIENCE IS RESOLVED UP FRONT, not streamed at send time. That is
 *     what makes the cost estimate honest — an owner approving a spend needs
 *     the real number of billable messages, not an estimate that drifts — and
 *     it makes the send resumable, because a crash halfway through leaves rows
 *     marked PENDING that simply get picked up again.
 *
 *  2. IT SENDS SLOWLY BY DEFAULT. 60 a minute, configurable per campaign. A
 *     campaign that saturates the number's throughput delays the table-ready
 *     ping for a guest standing at the host desk, and that trade is never worth
 *     making. The dispatcher already gives urgent messages priority; this makes
 *     sure they rarely have to use it.
 *
 *  3. EVERY MESSAGE GOES THROUGH `enqueueNotification`. Consent, quiet hours,
 *     pacing, the marketing cooldown, idempotency and the audit trail all apply
 *     exactly as they do to a single send. There is no bulk path that skips
 *     them — that is how a campaign ends up messaging someone who opted out.
 */

export interface AudienceMember {
  phone: string;
  /** Overrides the campaign's shared body params for this guest. */
  bodyParams?: string[] | undefined;
  urlSuffix?: string | undefined;
}

// -------------------------------------------------------------- building --

/**
 * Builds a campaign and its audience, and reports what it would cost.
 *
 * Nothing is sent. The returned `messageable` count is the only number an owner
 * should be shown — `total` includes guests the consent gate will refuse.
 */
export async function buildCampaign(input: {
  tenantId: string;
  outletId: string;
  name: string;
  templateName: string;
  bodyParams?: string[];
  urlSuffix?: string;
  audience: AudienceMember[];
  sendRatePerMinute?: number;
  scheduledFor?: Date;
  createdBy: string;
}): Promise<{
  campaignId: string;
  total: number;
  messageable: number;
  blockedByConsent: number;
  duplicates: number;
  estimatedMinutes: number;
}> {
  const creds = await getCredentialsByExternalId(input.tenantId, input.outletId);

  if (input.audience.length === 0) {
    throw new AppError('TEMPLATE_PARAMS_INVALID', 'A campaign needs at least one recipient.');
  }

  // Normalise and de-duplicate before anything else. The same guest reached
  // twice by one campaign is the complaint that gets a sender reported.
  const seen = new Map<string, AudienceMember>();
  let duplicates = 0;
  for (const member of input.audience) {
    const phone = toE164(member.phone);
    if (seen.has(phone)) {
      duplicates += 1;
      continue;
    }
    seen.set(phone, member);
  }

  // Consent is checked now so the owner sees the real reach before approving,
  // and again at send time because it can change in between.
  let messageable = 0;
  for (const phone of seen.keys()) {
    const { state } = await getConsent(creds.tenantId, phone);
    if (state === 'GRANTED') messageable += 1;
  }

  const rate = input.sendRatePerMinute ?? 60;

  const campaignId = await withTransaction(async (tx) => {
    const row = await one<{ id: string }>(
      tx,
      `INSERT INTO campaigns
         (tenant_id, outlet_id, name, template_name, body_params, url_suffix,
          state, scheduled_for, send_rate_per_minute,
          audience_total, audience_messageable, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,
               CASE WHEN $7::timestamptz IS NULL THEN 'DRAFT' ELSE 'SCHEDULED' END,
               $7,$8,$9,$10,$11)
       RETURNING id`,
      [
        creds.tenantId,
        creds.outletId,
        input.name,
        input.templateName,
        JSON.stringify(input.bodyParams ?? []),
        input.urlSuffix ?? null,
        input.scheduledFor?.toISOString() ?? null,
        rate,
        seen.size,
        messageable,
        input.createdBy,
      ],
    );

    for (const [phone, member] of seen) {
      await tx.query(
        `INSERT INTO campaign_recipients (campaign_id, phone_e164, body_params, url_suffix)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (campaign_id, phone_e164) DO NOTHING`,
        [
          row!.id,
          phone,
          member.bodyParams ? JSON.stringify(member.bodyParams) : null,
          member.urlSuffix ?? null,
        ],
      );
    }

    await tx.query(
      `INSERT INTO audit_log (tenant_id, actor, action, entity, entity_id, after_state, reason)
       VALUES ($1,$2,'CAMPAIGN_BUILT','campaign',$3,$4,'audience resolved')`,
      [
        creds.tenantId,
        input.createdBy,
        row!.id,
        JSON.stringify({ name: input.name, total: seen.size, messageable }),
      ],
    );

    return row!.id;
  });

  logger.info(
    { campaignId, total: seen.size, messageable, duplicates },
    'campaign built',
  );

  return {
    campaignId,
    total: seen.size,
    messageable,
    blockedByConsent: seen.size - messageable,
    duplicates,
    estimatedMinutes: Math.ceil(messageable / rate),
  };
}

// --------------------------------------------------------------- sending --

export async function startCampaign(campaignId: string, tenantId: string): Promise<void> {
  const updated = await one<{ id: string }>(
    pool,
    `UPDATE campaigns SET state = 'SENDING', started_at = COALESCE(started_at, now())
      WHERE id = $1 AND tenant_id = $2 AND state IN ('DRAFT','SCHEDULED','PAUSED')
      RETURNING id`,
    [campaignId, tenantId],
  );
  if (!updated) {
    throw new AppError('TEMPLATE_PARAMS_INVALID', 'Campaign is not in a startable state.');
  }
  logger.info({ campaignId }, 'campaign started');
}

export async function pauseCampaign(campaignId: string, tenantId: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    pool,
    `UPDATE campaigns SET state = 'PAUSED'
      WHERE id = $1 AND tenant_id = $2 AND state = 'SENDING' RETURNING id`,
    [campaignId, tenantId],
  );
  return Boolean(row);
}

export async function cancelCampaign(campaignId: string, tenantId: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    pool,
    `UPDATE campaigns SET state = 'CANCELLED', cancelled_at = now()
      WHERE id = $1 AND tenant_id = $2 AND state IN ('DRAFT','SCHEDULED','SENDING','PAUSED')
      RETURNING id`,
    [campaignId, tenantId],
  );
  return Boolean(row);
}

/**
 * Drains one tick's worth of recipients for every sending campaign.
 *
 * Called on a timer. Each call releases `send_rate_per_minute / 60` messages per
 * campaign, so the pacing is enforced by how much work a tick does rather than
 * by sleeping inside a loop — which means a restart resumes cleanly instead of
 * losing its place.
 */
export async function drainCampaigns(tickSeconds = 10): Promise<number> {
  const due = await query<{
    id: string;
    tenant_id: string;
    outlet_id: string;
    template_name: string;
    body_params: string[];
    url_suffix: string | null;
    send_rate_per_minute: number;
    external_id: string;
  }>(
    pool,
    `SELECT c.id, c.tenant_id, c.outlet_id, c.template_name, c.body_params,
            c.url_suffix, c.send_rate_per_minute, o.external_id
       FROM campaigns c
       JOIN outlets o ON o.id = c.outlet_id
      WHERE c.state = 'SENDING'
         OR (c.state = 'SCHEDULED' AND c.scheduled_for <= now())`,
  );

  let sent = 0;

  for (const campaign of due) {
    const batch = Math.max(1, Math.round((campaign.send_rate_per_minute * tickSeconds) / 60));

    // Claim the batch before doing any work, so two workers cannot send the
    // same guest the same campaign.
    const claimed = await query<{
      id: string;
      phone_e164: string;
      body_params: string[] | null;
      url_suffix: string | null;
    }>(
      pool,
      `UPDATE campaign_recipients SET state = 'QUEUED'
        WHERE id IN (
          SELECT id FROM campaign_recipients
           WHERE campaign_id = $1 AND state = 'PENDING'
           ORDER BY id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
        )
        RETURNING id, phone_e164, body_params, url_suffix`,
      [campaign.id, batch],
    );

    if (claimed.length === 0) {
      await pool.query(
        `UPDATE campaigns SET state = 'SENT', finished_at = now()
          WHERE id = $1 AND NOT EXISTS (
            SELECT 1 FROM campaign_recipients WHERE campaign_id = $1 AND state = 'PENDING'
          )`,
        [campaign.id],
      );
      continue;
    }

    if (due.length && campaign.send_rate_per_minute) {
      await pool.query(`UPDATE campaigns SET state = 'SENDING' WHERE id = $1 AND state = 'SCHEDULED'`, [
        campaign.id,
      ]);
    }

    for (const recipient of claimed) {
      try {
        const result = await enqueueNotification({
          tenantId: campaign.tenant_id,
          outletId: campaign.external_id,
          eventType: 'MARKETING_CAMPAIGN',
          phone: recipient.phone_e164,
          params: {
            templateName: campaign.template_name,
            bodyParams: recipient.body_params ?? campaign.body_params,
            ...(recipient.url_suffix ?? campaign.url_suffix
              ? { urlSuffix: recipient.url_suffix ?? campaign.url_suffix }
              : {}),
            campaignId: campaign.id,
          },
          campaignId: campaign.id,
        });

        if (result.state === 'QUEUED') {
          await pool.query(
            `UPDATE campaign_recipients
                SET state = 'QUEUED', message_id = $2, processed_at = now()
              WHERE id = $1`,
            [recipient.id, result.messageId],
          );
          sent += 1;
        } else {
          // Blocked by consent, or held by pacing. Both are correct outcomes and
          // both are recorded with their reason rather than retried.
          await pool.query(
            `UPDATE campaign_recipients
                SET state = 'SKIPPED', skip_reason = $2, message_id = $3, processed_at = now()
              WHERE id = $1`,
            [recipient.id, result.reason ?? result.state, result.messageId],
          );
        }
      } catch (err) {
        await pool.query(
          `UPDATE campaign_recipients
              SET state = 'FAILED', skip_reason = $2, processed_at = now()
            WHERE id = $1`,
          [recipient.id, (err as Error).message.slice(0, 300)],
        );
        logger.error({ err, campaignId: campaign.id }, 'campaign recipient failed');
      }
    }
  }

  return sent;
}

// ----------------------------------------------------------- attribution --

/**
 * Called by the Restaurant OS when a booking is created by a guest who received
 * a campaign message. Attribution is recorded by the system that knows a
 * booking happened, rather than inferred here from timestamps.
 */
export async function attributeBooking(input: {
  tenantId: string;
  campaignId: string;
  phoneE164: string;
  bookingId: string;
  valuePaise?: number;
}): Promise<boolean> {
  const message = await one<{ id: string }>(
    pool,
    `SELECT id FROM messages
      WHERE tenant_id = $1 AND campaign_id = $2 AND to_phone_e164 = $3
      ORDER BY created_at DESC LIMIT 1`,
    [input.tenantId, input.campaignId, input.phoneE164],
  );

  const row = await one<{ id: string }>(
    pool,
    `INSERT INTO campaign_attributions
       (campaign_id, message_id, phone_e164, booking_id, value_paise)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (campaign_id, booking_id) DO NOTHING
     RETURNING id`,
    [input.campaignId, message?.id ?? null, input.phoneE164, input.bookingId, input.valuePaise ?? null],
  );

  return Boolean(row);
}

export async function campaignReport(campaignId: string, tenantId: string) {
  const campaign = await one(
    pool,
    `SELECT id, name, template_name, state, scheduled_for, send_rate_per_minute,
            audience_total, audience_messageable, created_by, created_at,
            started_at, finished_at
       FROM campaigns WHERE id = $1 AND tenant_id = $2`,
    [campaignId, tenantId],
  );
  if (!campaign) throw new AppError('OUTLET_UNKNOWN', 'No such campaign.');

  const recipients = await query(
    pool,
    `SELECT state, count(*)::int AS n FROM campaign_recipients
      WHERE campaign_id = $1 GROUP BY state`,
    [campaignId],
  );

  // Delivery comes from the message rows, so it reflects Meta's own receipts.
  const delivery = await query(
    pool,
    `SELECT state, count(*)::int AS n FROM messages
      WHERE campaign_id = $1 GROUP BY state`,
    [campaignId],
  );

  const attribution = await one<{ bookings: number; value_paise: string | null }>(
    pool,
    `SELECT count(*)::int AS bookings, COALESCE(sum(value_paise), 0)::text AS value_paise
       FROM campaign_attributions WHERE campaign_id = $1`,
    [campaignId],
  );

  return {
    campaign,
    recipients,
    delivery,
    attribution: {
      bookings: attribution?.bookings ?? 0,
      // Paise as an integer string: this number is money and must not become a float.
      valuePaise: attribution?.value_paise ?? '0',
    },
  };
}

void config;
