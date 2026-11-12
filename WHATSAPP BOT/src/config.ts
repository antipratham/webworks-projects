import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  GRAPH_API_VERSION: z.string().default('v21.0'),
  GRAPH_API_BASE: z.string().url().default('https://graph.facebook.com'),

  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(8),
  META_APP_SECRET: z.string().min(8),

  /**
   * Where the encryption key is read from. `env` is fine locally and in CI;
   * production should use `file` (a mounted Kubernetes/ECS secret), `aws`
   * (Secrets Manager Agent) or `vault` (Vault Agent). See
   * src/tenancy/secretSource.ts.
   */
  SECRET_SOURCE: z.enum(['env', 'file', 'aws', 'vault']).default('env'),
  /** Mount path, secret id/ARN, or Vault path, depending on SECRET_SOURCE. */
  SECRET_REF: z.string().min(1).optional(),
  /** Field to read when the stored secret is a JSON document. */
  SECRET_JSON_KEY: z.string().min(1).optional(),
  /** Sidecar base URL; defaults to the vendor's conventional localhost port. */
  SECRET_AGENT_URL: z.string().url().optional(),

  /** Only used, and only required, when SECRET_SOURCE=env. */
  CREDENTIALS_ENC_KEY: z.string().optional(),

  RESTAURANT_OS_BASE_URL: z.string().url(),
  RESTAURANT_OS_API_KEY: z.string().min(8),

  QUIET_HOURS_START: z.coerce.number().int().min(0).max(23).default(21),
  QUIET_HOURS_END: z.coerce.number().int().min(0).max(23).default(9),

  // ---- pacing ----
  /** Minimum hours between any message and the next platform-timed one. */
  MIN_MESSAGE_GAP_HOURS: z.coerce.number().min(0).max(72).default(8),
  /** A guest hears from marketing at most once in this many days. */
  MARKETING_COOLDOWN_DAYS: z.coerce.number().min(0).max(365).default(14),
  /** Campaigns skip guests with a booking inside this horizon. */
  CAMPAIGN_BOOKING_EXCLUSION_HOURS: z.coerce.number().min(0).max(720).default(48),

  // ---- retention ----
  /** Guest identifiers are stripped from records older than this. */
  RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  /** An erasure request must complete inside this window. Ours is immediate. */
  ERASURE_SLA_DAYS: z.coerce.number().int().min(1).max(30).default(7),

  // ---- provisioning ----
  /**
   * Mints the first per-tenant API key and nothing else. It cannot send a
   * message or read a guest. Belongs in a secret manager, rotated often.
   */
  BOOTSTRAP_ADMIN_KEY: z.string().min(24),

  /** Serve Prometheus metrics on /metrics. Off means the endpoint 404s. */
  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const withSecretRules = schema
  .refine(
    (c) => c.SECRET_SOURCE !== 'env' || (c.CREDENTIALS_ENC_KEY ?? '').length > 0,
    { message: 'CREDENTIALS_ENC_KEY is required when SECRET_SOURCE=env', path: ['CREDENTIALS_ENC_KEY'] },
  )
  .refine(
    (c) =>
      c.SECRET_SOURCE !== 'env' ||
      Buffer.from(c.CREDENTIALS_ENC_KEY ?? '', 'base64').length === 32,
    { message: 'must be 32 bytes, base64', path: ['CREDENTIALS_ENC_KEY'] },
  )
  .refine((c) => c.SECRET_SOURCE === 'env' || !!c.SECRET_REF, {
    message: 'SECRET_REF is required unless SECRET_SOURCE=env',
    path: ['SECRET_REF'],
  });

const parsed = withSecretRules.safeParse(process.env);
if (!parsed.success) {
  // Fail loudly at boot rather than at 9pm on a Friday.
  console.error('Invalid configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

/**
 * Feedback goes out 12 hours after the visit completes — long enough that the
 * guest has finished eating and left, short enough that the meal is still fresh.
 */
export const FEEDBACK_DELAY_HOURS = 12;

/** Meta's customer service window, opened by any guest-initiated message. */
export const SERVICE_WINDOW_HOURS = 24;

/** A feedback session with no reply for this long is abandoned, never re-prompted. */
export const FEEDBACK_IDLE_TIMEOUT_MINUTES = 60;

/**
 * Guest-facing language.
 *
 * English only, by decision. The locale plumbing is left intact — templates are
 * approved per (name, language) and the column is already there — so adding a
 * language later is content work, not a migration. What is NOT left in place is
 * half-reviewed Hindi and Kannada copy: unreviewed strings in an apology to a
 * guest who had a bad meal are worse than no translation at all.
 */
export const SUPPORTED_LOCALES = ['en'] as const;
