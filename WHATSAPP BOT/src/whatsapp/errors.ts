import { AppError, type ErrorCode } from '../domain/errors.js';

/**
 * Meta error codes, classified.
 *
 * The distinction that matters is RETRY vs DON'T: retrying a 132001 (template
 * not approved in this language) a hundred times just burns the queue, while
 * giving up on a 131016 (service unavailable) loses a real message.
 *
 * Codes are from the Cloud API error reference. Anything unlisted is treated as
 * transient on the first two attempts, then parked — unknown-and-permanent is
 * the more expensive mistake to guess wrong.
 */

export interface MetaErrorShape {
  code: number;
  /** Meta nests the useful part in error.error_data.details. */
  details?: string | undefined;
  subcode?: number | undefined;
  message?: string | undefined;
}

type Classification = {
  retryable: boolean;
  appCode: ErrorCode;
  /** True when the token itself is dead and the outlet must re-authenticate. */
  credentialFailure?: boolean;
  /** True when the whole phone number is throttled; back off the shared bucket. */
  throttled?: boolean;
};

const CLASSIFICATIONS: Record<number, Classification> = {
  // --- authentication and permission: no amount of retrying helps -----------
  0: { retryable: false, appCode: 'CREDENTIALS_EXPIRED', credentialFailure: true },
  3: { retryable: false, appCode: 'WHATSAPP_PERMANENT' },
  10: { retryable: false, appCode: 'WHATSAPP_PERMANENT' },
  190: { retryable: false, appCode: 'CREDENTIALS_EXPIRED', credentialFailure: true },
  131005: { retryable: false, appCode: 'WHATSAPP_PERMANENT' },
  131031: { retryable: false, appCode: 'CREDENTIALS_EXPIRED', credentialFailure: true },

  // --- throttling: retry, but slow the whole number down --------------------
  4: { retryable: true, appCode: 'RATE_LIMITED', throttled: true },
  80007: { retryable: true, appCode: 'RATE_LIMITED', throttled: true },
  130429: { retryable: true, appCode: 'RATE_LIMITED', throttled: true },
  131048: { retryable: true, appCode: 'RATE_LIMITED', throttled: true },
  131056: { retryable: true, appCode: 'RATE_LIMITED', throttled: true },
  368: { retryable: false, appCode: 'WHATSAPP_PERMANENT' }, // temporarily blocked, policy

  // --- transient: retry with backoff ---------------------------------------
  1: { retryable: true, appCode: 'WHATSAPP_TRANSIENT' },
  2: { retryable: true, appCode: 'WHATSAPP_TRANSIENT' },
  131000: { retryable: true, appCode: 'WHATSAPP_TRANSIENT' },
  131016: { retryable: true, appCode: 'WHATSAPP_TRANSIENT' },
  131053: { retryable: true, appCode: 'WHATSAPP_TRANSIENT' }, // media upload

  // --- our payload is wrong: fix the code, not the retry count --------------
  131008: { retryable: false, appCode: 'TEMPLATE_PARAMS_INVALID' },
  131009: { retryable: false, appCode: 'TEMPLATE_PARAMS_INVALID' },
  131051: { retryable: false, appCode: 'WHATSAPP_PERMANENT' },
  132000: { retryable: false, appCode: 'TEMPLATE_PARAMS_INVALID' }, // variable count mismatch
  132005: { retryable: false, appCode: 'TEMPLATE_PARAMS_INVALID' }, // hydrated text too long
  132007: { retryable: false, appCode: 'TEMPLATE_PARAMS_INVALID' }, // character policy
  132012: { retryable: false, appCode: 'TEMPLATE_PARAMS_INVALID' }, // format mismatch

  // --- template lifecycle: page a human, do not retry ----------------------
  132001: { retryable: false, appCode: 'TEMPLATE_NOT_APPROVED' }, // missing in this language
  132015: { retryable: false, appCode: 'TEMPLATE_NOT_APPROVED' }, // paused for quality
  132016: { retryable: false, appCode: 'TEMPLATE_NOT_APPROVED' }, // disabled

  // --- the recipient, not us ------------------------------------------------
  131026: { retryable: false, appCode: 'RECIPIENT_NOT_REACHABLE' }, // not on WhatsApp
  131047: { retryable: false, appCode: 'WHATSAPP_PERMANENT' }, // needs a template, window shut
  133010: { retryable: false, appCode: 'CREDENTIALS_MISSING' }, // number not registered
};

export function classifyMetaError(err: MetaErrorShape, attempt: number): Classification {
  const known = CLASSIFICATIONS[err.code];
  if (known) return known;
  // Unknown code: give it two attempts, then stop guessing.
  return { retryable: attempt < 2, appCode: 'WHATSAPP_TRANSIENT' };
}

export class WhatsAppError extends AppError {
  readonly metaCode: number;
  readonly credentialFailure: boolean;
  readonly throttled: boolean;

  constructor(meta: MetaErrorShape, attempt: number) {
    const c = classifyMetaError(meta, attempt);
    super(
      c.appCode,
      meta.details ?? meta.message ?? `WhatsApp rejected the message (code ${meta.code}).`,
      { metaCode: meta.code, ...(meta.subcode ? { metaSubcode: meta.subcode } : {}) },
      c.retryable,
    );
    this.name = 'WhatsAppError';
    this.metaCode = meta.code;
    this.credentialFailure = c.credentialFailure ?? false;
    this.throttled = c.throttled ?? false;
  }
}
