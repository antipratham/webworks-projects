import { pool, one, withTransaction, type Db } from '../db/pool.js';
import { logger, maskPhone } from '../logging/logger.js';
import {
  evaluateTransition,
  TERMINAL_STATES,
  type MessageState,
} from './stateMachine.js';
import type { GraphMessageBody } from '../whatsapp/payloads.js';
import type { Locale } from '../templates/registry.js';

export interface MessageRow {
  id: string;
  tenant_id: string;
  outlet_id: string;
  event_type: string;
  category: string;
  to_phone_e164: string;
  locale: Locale;
  template_name: string | null;
  template_language: string | null;
  payload: GraphMessageBody;
  state: MessageState;
  wamid: string | null;
  attempts: number;
  correlation_type: string | null;
  correlation_id: string | null;
  campaign_id: string | null;
}

export interface CreateMessageInput {
  tenantId: string;
  outletId: string;
  eventType: string;
  category: string;
  toPhoneE164: string;
  locale: Locale;
  templateName: string | null;
  templateLanguage: string | null;
  payload: GraphMessageBody;
  correlationType?: string | null;
  correlationId?: string | null;
  campaignId?: string | null;
  /** Set when the policy gate refused before anything was queued. */
  initialState?: MessageState;
  blockReason?: string;
}

export async function createMessage(
  db: Db,
  input: CreateMessageInput,
): Promise<MessageRow> {
  const state = input.initialState ?? 'QUEUED';
  const row = await one<MessageRow>(
    db,
    `INSERT INTO messages
       (tenant_id, outlet_id, event_type, category, to_phone_e164, locale,
        template_name, template_language, payload, state,
        correlation_type, correlation_id, campaign_id, terminal_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             CASE WHEN $10 IN ('FAILED','BLOCKED_BY_CONSENT') THEN now() ELSE NULL END)
     RETURNING *`,
    [
      input.tenantId,
      input.outletId,
      input.eventType,
      input.category,
      input.toPhoneE164,
      input.locale,
      input.templateName,
      input.templateLanguage,
      JSON.stringify(input.payload),
      state,
      input.correlationType ?? null,
      input.correlationId ?? null,
      input.campaignId ?? null,
    ],
  );
  if (!row) throw new Error('message insert returned no row');

  await db.query(
    `INSERT INTO message_events (message_id, from_state, to_state, actor, reason)
     VALUES ($1, NULL, $2, 'SYSTEM', $3)`,
    [row.id, state, input.blockReason ?? 'created'],
  );

  return row;
}

export async function getMessage(id: string): Promise<MessageRow | undefined> {
  return one<MessageRow>(pool, `SELECT * FROM messages WHERE id = $1`, [id]);
}

export async function getMessageByWamid(wamid: string): Promise<MessageRow | undefined> {
  return one<MessageRow>(pool, `SELECT * FROM messages WHERE wamid = $1`, [wamid]);
}

/**
 * Advance a message, or decline to. Returns whether the state actually moved.
 *
 * Always runs inside a transaction with `SELECT ... FOR UPDATE`, because Meta
 * will happily deliver `sent`, `delivered` and `read` for the same message to
 * three workers at the same moment.
 */
export async function transition(
  messageId: string,
  to: MessageState,
  opts: {
    actor: string;
    reason?: string;
    wamid?: string;
    errorCode?: string;
    errorDetail?: string;
  },
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const current = await one<{ state: MessageState; to_phone_e164: string }>(
      tx,
      `SELECT state, to_phone_e164 FROM messages WHERE id = $1 FOR UPDATE`,
      [messageId],
    );
    if (!current) return false;

    const outcome = evaluateTransition(current.state, to);

    if (outcome.kind !== 'apply') {
      if (outcome.kind === 'illegal') {
        logger.warn(
          { messageId, from: current.state, to, reason: outcome.reason },
          'illegal message transition refused',
        );
      }
      return false;
    }

    await tx.query(
      `UPDATE messages
          SET state = $2,
              wamid = COALESCE($3, wamid),
              error_code = COALESCE($4, error_code),
              error_detail = COALESCE($5, error_detail),
              sent_at = CASE WHEN $2 = 'SENT' THEN now() ELSE sent_at END,
              terminal_at = CASE WHEN $2 = ANY($6::text[]) THEN now() ELSE terminal_at END
        WHERE id = $1`,
      [
        messageId,
        to,
        opts.wamid ?? null,
        opts.errorCode ?? null,
        opts.errorDetail ?? null,
        [...TERMINAL_STATES],
      ],
    );

    await tx.query(
      `INSERT INTO message_events (message_id, from_state, to_state, actor, reason)
       VALUES ($1,$2,$3,$4,$5)`,
      [messageId, current.state, to, opts.actor, opts.reason ?? null],
    );

    logger.info(
      { messageId, from: current.state, to, guest: maskPhone(current.to_phone_e164) },
      'message state advanced',
    );
    return true;
  });
}

export async function incrementAttempt(messageId: string): Promise<number> {
  const row = await one<{ attempts: number }>(
    pool,
    `UPDATE messages SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
    [messageId],
  );
  return row?.attempts ?? 0;
}
