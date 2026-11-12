import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { logger, maskPhone } from '../../logging/logger.js';
import { verifyWebhookSignature } from '../../whatsapp/client.js';
import { getCredentialsByPhoneNumberId } from '../../tenancy/credentials.js';
import { getMessageByWamid, transition } from '../../messages/repository.js';
import { metaStatusToState } from '../../messages/stateMachine.js';
import { fromMetaWaId } from '../../domain/phone.js';
import { handleInbound } from '../../feedback/fsm.js';
import * as os from '../../integrations/restaurantOs.js';
import { webhooksReceived, deliveryStatus } from '../../observability/metrics.js';

/**
 * Meta's webhook.
 *
 * "Outbound only" does not mean "no webhook". Two things arrive here that the
 * platform cannot work without:
 *
 *   1. Delivery receipts — sent, delivered, read, failed. Without them the
 *      message state machine never leaves SENT and the owner's dashboard is
 *      lying about what reached the guest.
 *
 *   2. Button taps — a reminder's Confirm/Cancel, and the feedback opt-in.
 *
 * Anything else a guest sends is acknowledged with a 200 and dropped. That is
 * intentional: this is not a chat bot, and an auto-reply to an unsolicited
 * message is both a worse guest experience and a policy risk.
 */
export async function webhookRoutes(app: FastifyInstance) {
  /** Meta's one-time subscription handshake. */
  app.get('/webhook', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (
      q['hub.mode'] === 'subscribe' &&
      q['hub.verify_token'] === config.WHATSAPP_WEBHOOK_VERIFY_TOKEN
    ) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send();
  });

  app.post('/webhook', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.headers['x-hub-signature-256'];

    if (!raw || !verifyWebhookSignature(raw, typeof signature === 'string' ? signature : undefined)) {
      webhooksReceived.inc({ outcome: 'bad_signature' });
      logger.warn('rejected webhook with a bad or missing signature');
      return reply.code(401).send();
    }

    // Always 200 immediately. Meta retries aggressively on anything else, and a
    // slow handler turns one delivery receipt into a thundering herd.
    reply.code(200).send();

    try {
      await processWebhook(req.body as MetaWebhookBody);
      webhooksReceived.inc({ outcome: 'accepted' });
    } catch (err) {
      webhooksReceived.inc({ outcome: 'error' });
      logger.error({ err }, 'webhook processing failed');
    }
  });
}

interface MetaWebhookBody {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        statuses?: {
          id: string;
          status: string;
          errors?: { code: number; title?: string }[];
        }[];
        messages?: {
          from: string;
          id: string;
          type: string;
          text?: { body: string };
          button?: { payload?: string; text?: string };
          interactive?: {
            type: string;
            button_reply?: { id: string };
            list_reply?: { id: string };
          };
        }[];
      };
    }[];
  }[];
}

async function processWebhook(body: MetaWebhookBody): Promise<void> {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      for (const status of value?.statuses ?? []) {
        await applyStatus(status);
      }

      if (value?.messages?.length) {
        const creds = await getCredentialsByPhoneNumberId(phoneNumberId);
        for (const message of value.messages) {
          await applyInbound(creds, message);
        }
      }
    }
  }
}

async function applyStatus(status: {
  id: string;
  status: string;
  errors?: { code: number; title?: string }[];
}): Promise<void> {
  const state = metaStatusToState(status.status);
  if (!state) return;

  const message = await getMessageByWamid(status.id);
  if (!message) {
    // A receipt for a message we did not send — another app on the same number,
    // or a replay from before this database existed.
    logger.debug({ status: status.status }, 'status for an unknown message id');
    return;
  }

  deliveryStatus.inc({ status: status.status, outlet: 'unknown' });

  const err = status.errors?.[0];
  await transition(message.id, state, {
    actor: 'META_WEBHOOK',
    ...(err ? { errorCode: 'WHATSAPP_PERMANENT', errorDetail: `meta:${err.code} ${err.title ?? ''}`.trim() } : {}),
  });
}

async function applyInbound(
  creds: Awaited<ReturnType<typeof getCredentialsByPhoneNumberId>>,
  message: {
    from: string;
    id: string;
    type: string;
    text?: { body: string };
    button?: { payload?: string };
    interactive?: { button_reply?: { id: string }; list_reply?: { id: string } };
  },
): Promise<void> {
  const phoneE164 = fromMetaWaId(message.from);
  const buttonPayload = message.button?.payload;
  const interactiveId =
    message.interactive?.list_reply?.id ?? message.interactive?.button_reply?.id;
  const text = message.text?.body;

  // A reply of any kind against one of our messages closes its lifecycle.
  await markRepliedIfTracked(phoneE164);

  // Booking one-tap actions from a reminder template.
  const action = buttonPayload ?? interactiveId ?? '';
  if (action.startsWith('CONFIRM:')) {
    await os.confirmBooking(action.slice('CONFIRM:'.length), creds.tenantId);
    logger.info({ guest: maskPhone(phoneE164) }, 'booking confirmed from reminder tap');
    return;
  }
  if (action.startsWith('CANCEL:')) {
    await os.cancelBooking(action.slice('CANCEL:'.length), creds.tenantId);
    logger.info({ guest: maskPhone(phoneE164) }, 'booking cancelled from reminder tap');
    return;
  }

  const handled = await handleInbound({
    creds,
    phoneE164,
    ...(buttonPayload ? { buttonPayload } : {}),
    ...(interactiveId ? { interactiveId } : {}),
    ...(text ? { text } : {}),
  });

  if (!handled) {
    // Deliberate silence. See the note at the top of this file.
    logger.debug({ guest: maskPhone(phoneE164) }, 'unsolicited inbound message ignored');
  }
}

/** Marks the most recent delivered message to this guest as REPLIED. */
async function markRepliedIfTracked(phoneE164: string): Promise<void> {
  const { pool } = await import('../../db/pool.js');
  const row = await pool.query<{ id: string }>(
    `SELECT id FROM messages
      WHERE to_phone_e164 = $1 AND state IN ('SENT','DELIVERED','READ')
      ORDER BY created_at DESC LIMIT 1`,
    [phoneE164],
  );
  const id = row.rows[0]?.id;
  if (id) await transition(id, 'REPLIED', { actor: 'META_WEBHOOK' });
}
