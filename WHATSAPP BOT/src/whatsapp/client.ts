import crypto from 'node:crypto';
import { request } from 'undici';
import { config } from '../config.js';
import { logger } from '../logging/logger.js';
import { WhatsAppError, type MetaErrorShape } from './errors.js';
import type { OutletCredentials } from '../tenancy/credentials.js';
import type { GraphMessageBody } from './payloads.js';

export interface SendResult {
  wamid: string;
}

/**
 * Thin Graph API client. Deliberately thin: it sends one message, classifies the
 * failure, and returns. Retries, backoff and state transitions belong to the
 * dispatch worker, not here — a client that retries silently is a client you
 * cannot reason about from the message log.
 */
export async function sendMessage(
  creds: OutletCredentials,
  body: GraphMessageBody,
  attempt: number,
): Promise<SendResult> {
  const url = `${config.GRAPH_API_BASE}/${config.GRAPH_API_VERSION}/${creds.phoneNumberId}/messages`;

  const res = await request(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${creds.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
  });

  const text = await res.body.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }

  if (res.statusCode >= 200 && res.statusCode < 300) {
    const ok = parsed as { messages?: { id: string }[] };
    const wamid = ok.messages?.[0]?.id;
    if (!wamid) {
      // A 200 with no message id should never happen. Treat it as transient
      // rather than marking a message SENT we cannot later correlate.
      throw new WhatsAppError({ code: 131000, message: 'Graph returned no message id.' }, attempt);
    }
    return { wamid };
  }

  const errBody = parsed as {
    error?: { code?: number; message?: string; error_subcode?: number; error_data?: { details?: string } };
  };
  const meta: MetaErrorShape = {
    code: errBody.error?.code ?? res.statusCode,
    message: errBody.error?.message,
    subcode: errBody.error?.error_subcode,
    details: errBody.error?.error_data?.details,
  };

  // No guest fields in this log line — only Meta's own codes.
  logger.warn(
    { metaCode: meta.code, metaSubcode: meta.subcode, status: res.statusCode, attempt },
    'graph api rejected message',
  );

  throw new WhatsAppError(meta, attempt);
}

/**
 * Meta signs every webhook with the APP SECRET, not the tenant token. Verify
 * before parsing: an unverified body is attacker-controlled input.
 */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = crypto
    .createHmac('sha256', config.META_APP_SECRET)
    .update(rawBody)
    .digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
