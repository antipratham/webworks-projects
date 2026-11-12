import { withTransaction } from '../db/pool.js';
import { createMessage } from '../messages/repository.js';
import { dispatchQueue } from '../queue/queues.js';
import type { GraphMessageBody } from '../whatsapp/payloads.js';
import type { Locale } from '../templates/registry.js';

/**
 * Free-form sends, used only by the feedback conversation.
 *
 * A SERVICE message is legal solely inside the 24-hour customer service window
 * that the guest's own message or button tap opened. It carries no template, is
 * not consent-gated (the guest just started this conversation), and — the part
 * worth designing around — is not billed the way a template is.
 *
 * The caller is responsible for having checked the window. This function will
 * not check it for you, because the only caller that should ever reach here is
 * the feedback FSM, which owns that state.
 */
export async function enqueueServiceMessage(input: {
  tenantId: string;
  outletId: string;
  eventType: string;
  toPhoneE164: string;
  locale: Locale;
  payload: GraphMessageBody;
  correlationType?: string;
  correlationId?: string;
}): Promise<string> {
  const row = await withTransaction((tx) =>
    createMessage(tx, {
      tenantId: input.tenantId,
      outletId: input.outletId,
      eventType: input.eventType,
      category: 'SERVICE',
      toPhoneE164: input.toPhoneE164,
      locale: input.locale,
      templateName: null,
      templateLanguage: null,
      payload: input.payload,
      correlationType: input.correlationType ?? null,
      correlationId: input.correlationId ?? null,
    }),
  );

  await dispatchQueue.add(
    input.eventType,
    { messageId: row.id, outletId: input.outletId, urgent: true },
    // A guest is waiting with the chat open. This never queues behind a campaign.
    { priority: 1, jobId: `msg-${row.id}` },
  );

  return row.id;
}
