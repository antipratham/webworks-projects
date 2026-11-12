/**
 * Cross-cutting rule: every API error returns a stable code, a human-readable
 * message and field-level detail. Clients branch on the code, never on the text.
 *
 * Adding a code is a contract change. Renaming one is a breaking change.
 */
export const ERROR_CODES = {
  // intake
  PHONE_INVALID: 400,
  TEMPLATE_UNKNOWN: 400,
  TEMPLATE_PARAMS_INVALID: 400,
  LOCALE_UNSUPPORTED: 400,
  OUTLET_UNKNOWN: 404,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_KEY_MISSING: 400,

  // policy
  BLOCKED_BY_CONSENT: 200, // not an error to the caller: a recorded outcome
  QUIET_HOURS_DEFERRED: 202,
  RATE_LIMITED: 429,

  // tenancy
  TENANT_SUSPENDED: 403,
  CREDENTIALS_MISSING: 424,
  CREDENTIALS_EXPIRED: 424,

  // delivery
  WHATSAPP_TRANSIENT: 503,
  WHATSAPP_PERMANENT: 502,
  TEMPLATE_NOT_APPROVED: 502,
  RECIPIENT_NOT_REACHABLE: 502,

  // auth
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,

  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    detail?: Record<string, unknown>,
    retryable = false,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.detail = detail;
    this.retryable = retryable;
  }

  toResponse() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.detail ? { detail: this.detail } : {}),
      },
    };
  }
}
