import pino from 'pino';
import { config } from '../config.js';

/**
 * Spec rule: guest name, phone, transcript text and recording URLs never appear
 * in application logs, analytics events or crash reports.
 *
 * Redaction here is the safety net, not the strategy. The strategy is that call
 * sites log `maskPhone(x)` and message ids, never raw guest fields.
 */
const REDACT_PATHS = [
  'phone',
  'to',
  'to_phone_e164',
  'phone_e164',
  'name',
  'guest_name',
  'access_token',
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  '*.phone',
  '*.to',
  '*.name',
  '*.access_token',
  'payload.to',
  'payload.template.components',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: 'restoos-whatsapp' },
});

/**
 * The only form of a guest phone number allowed into a log line: country code,
 * then the last two digits. `+91XXXXXXXX42`. Enough to correlate a support
 * ticket, not enough to identify or dial.
 */
export function maskPhone(e164: string): string {
  if (e164.length < 6) return '[redacted]';
  const cc = e164.slice(0, 3);
  const tail = e164.slice(-2);
  return `${cc}${'X'.repeat(Math.max(0, e164.length - 5))}${tail}`;
}
