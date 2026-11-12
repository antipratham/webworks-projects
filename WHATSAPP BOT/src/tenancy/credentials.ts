import crypto from 'node:crypto';
import { pool, one, withTransaction } from '../db/pool.js';
import { encryptionKey } from './keyring.js';
import { AppError } from '../domain/errors.js';
import { logger } from '../logging/logger.js';

/**
 * Per-outlet WhatsApp credentials.
 *
 * Every restaurant connects its OWN WhatsApp Business Account through Embedded
 * Signup, so there is no global token and nothing WhatsApp-related belongs in an
 * env var. The access token is sealed with AES-256-GCM before it touches disk
 * and is decrypted only inside `getCredentials`, which is the one place allowed
 * to hold it in plaintext.
 */

const ALGO = 'aes-256-gcm';

export function seal(plaintext: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // iv | tag | ciphertext
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function unseal(sealed: Buffer): string {
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(12, 28);
  const enc = sealed.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export interface OutletCredentials {
  outletId: string;
  tenantId: string;
  outletName: string;
  timezone: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  messagingTier: string;
}

interface CredRow {
  outlet_id: string;
  tenant_id: string;
  outlet_name: string;
  timezone: string;
  waba_id: string;
  phone_number_id: string;
  access_token_enc: Buffer;
  messaging_tier: string;
  cred_status: string;
  tenant_status: string;
}

const SELECT_CREDS = `
  SELECT o.id            AS outlet_id,
         o.tenant_id     AS tenant_id,
         o.name          AS outlet_name,
         o.timezone      AS timezone,
         c.waba_id,
         c.phone_number_id,
         c.access_token_enc,
         c.messaging_tier,
         c.status        AS cred_status,
         t.status        AS tenant_status
    FROM outlets o
    JOIN tenants t        ON t.id = o.tenant_id
    LEFT JOIN wa_credentials c ON c.outlet_id = o.id
`;

async function hydrate(row: CredRow | undefined, ref: string): Promise<OutletCredentials> {
  if (!row) {
    throw new AppError('OUTLET_UNKNOWN', 'No such outlet.', { outlet: ref });
  }
  if (row.tenant_status !== 'ACTIVE') {
    throw new AppError('TENANT_SUSPENDED', 'This tenant is not active.', { outlet: ref });
  }
  if (!row.phone_number_id) {
    throw new AppError(
      'CREDENTIALS_MISSING',
      'This outlet has not completed WhatsApp Embedded Signup.',
      { outlet: ref },
    );
  }
  if (row.cred_status === 'TOKEN_EXPIRED') {
    throw new AppError('CREDENTIALS_EXPIRED', 'The WhatsApp token for this outlet has expired.', {
      outlet: ref,
    });
  }
  if (row.cred_status !== 'ACTIVE') {
    throw new AppError('CREDENTIALS_MISSING', 'WhatsApp is disabled for this outlet.', {
      outlet: ref,
    });
  }

  return {
    outletId: row.outlet_id,
    tenantId: row.tenant_id,
    outletName: row.outlet_name,
    timezone: row.timezone,
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    accessToken: unseal(row.access_token_enc),
    messagingTier: row.messaging_tier,
  };
}

/** Look up by the outlet id the Restaurant OS backend uses. */
export async function getCredentialsByExternalId(
  tenantId: string,
  externalOutletId: string,
): Promise<OutletCredentials> {
  const row = await one<CredRow>(
    pool,
    `${SELECT_CREDS} WHERE o.tenant_id = $1 AND o.external_id = $2`,
    [tenantId, externalOutletId],
  );
  return hydrate(row, externalOutletId);
}

export async function getCredentials(outletId: string): Promise<OutletCredentials> {
  const row = await one<CredRow>(pool, `${SELECT_CREDS} WHERE o.id = $1`, [outletId]);
  return hydrate(row, outletId);
}

/**
 * Inbound webhooks identify the outlet only by `phone_number_id`. This is the
 * reverse lookup that routes a delivery receipt or a button tap to its tenant.
 */
export async function getCredentialsByPhoneNumberId(
  phoneNumberId: string,
): Promise<OutletCredentials> {
  const row = await one<CredRow>(pool, `${SELECT_CREDS} WHERE c.phone_number_id = $1`, [
    phoneNumberId,
  ]);
  return hydrate(row, phoneNumberId);
}

/**
 * Called by the Admin Console after Embedded Signup completes, and again on
 * every token rotation. The plaintext token exists only in this call frame.
 */
export async function upsertCredentials(input: {
  outletId: string;
  wabaId: string;
  phoneNumberId: string;
  displayNumber: string;
  accessToken: string;
  messagingTier?: string;
  actor: string;
}): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO wa_credentials
         (outlet_id, waba_id, phone_number_id, display_number,
          access_token_enc, messaging_tier, status, rotated_at)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'TIER_1K'),'ACTIVE',now())
       ON CONFLICT (outlet_id) DO UPDATE SET
         waba_id          = EXCLUDED.waba_id,
         phone_number_id  = EXCLUDED.phone_number_id,
         display_number   = EXCLUDED.display_number,
         access_token_enc = EXCLUDED.access_token_enc,
         messaging_tier   = EXCLUDED.messaging_tier,
         status           = 'ACTIVE',
         rotated_at       = now()`,
      [
        input.outletId,
        input.wabaId,
        input.phoneNumberId,
        input.displayNumber,
        seal(input.accessToken),
        input.messagingTier ?? null,
      ],
    );

    // The token itself never reaches the audit row.
    await tx.query(
      `INSERT INTO audit_log (tenant_id, actor, action, entity, entity_id, after_state, reason)
       SELECT o.tenant_id, $2, 'WA_CREDENTIALS_UPSERT', 'wa_credentials', $1::text,
              jsonb_build_object('waba_id', $3::text, 'phone_number_id', $4::text),
              'embedded signup or token rotation'
         FROM outlets o WHERE o.id = $1`,
      [input.outletId, input.actor, input.wabaId, input.phoneNumberId],
    );
  });

  logger.info({ outletId: input.outletId }, 'whatsapp credentials stored');
}

/** Marks a tenant's token dead so the dispatcher stops burning retries on it. */
export async function markTokenExpired(phoneNumberId: string): Promise<void> {
  await pool.query(
    `UPDATE wa_credentials SET status = 'TOKEN_EXPIRED' WHERE phone_number_id = $1`,
    [phoneNumberId],
  );
  logger.error({ phoneNumberId }, 'whatsapp token expired — outlet cannot send');
}
