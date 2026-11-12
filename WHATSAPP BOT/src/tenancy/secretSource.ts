import { readFile } from 'node:fs/promises';
import { request } from 'undici';
import { logger } from '../logging/logger.js';

/**
 * WHERE THE ENCRYPTION KEY COMES FROM
 *
 * `CREDENTIALS_ENC_KEY` protects two things: every tenant's WhatsApp access
 * token, and the pseudonyms that stand in for erased guests. If it leaks, every
 * restaurant's WhatsApp account is compromised and the anonymisation is
 * reversible. So where it is read from is a production decision, not a detail.
 *
 * Four sources, chosen by `SECRET_SOURCE`:
 *
 *   env     the key is in CREDENTIALS_ENC_KEY. Fine for local and CI.
 *           Not fine for production: environment variables leak through crash
 *           dumps, `docker inspect`, process listings and CI logs.
 *
 *   file    read from a path. This is how Kubernetes mounts a Secret, and how
 *           Docker Swarm and ECS mount secrets. Usually the right answer: the
 *           platform does the fetching and rotation, and this service stays
 *           unaware of which vendor is behind it.
 *
 *   aws     AWS Secrets Manager, read through the instance's own IAM role via
 *           the Secrets Manager Agent sidecar. No SDK dependency and no
 *           credentials in this process.
 *
 *   vault   HashiCorp Vault, read through the Vault Agent sidecar for the same
 *           reason.
 *
 * `aws` and `vault` both talk to a localhost sidecar rather than the vendor
 * API directly. That is deliberate: it keeps vendor SDKs, retry behaviour and
 * cloud credentials out of this service, and makes the two paths identical to
 * test. If you would rather call the vendor directly, replace `fetchFromAgent`.
 *
 * The key is read ONCE at boot and held in memory. Rotation is a restart — a
 * rolling one, with both keys valid during the overlap. Re-reading per request
 * would put a network call in front of every send, and a secret store outage
 * would then stop the restaurant from messaging its guests.
 */

export type SecretSource = 'env' | 'file' | 'aws' | 'vault';

const AGENT_TIMEOUT_MS = 5_000;

async function fetchFromAgent(url: string, headers: Record<string, string>): Promise<string> {
  const res = await request(url, {
    method: 'GET',
    headers,
    headersTimeout: AGENT_TIMEOUT_MS,
    bodyTimeout: AGENT_TIMEOUT_MS,
  });
  if (res.statusCode >= 300) {
    throw new Error(`secret agent returned ${res.statusCode}`);
  }
  return await res.body.text();
}

function extract(payload: string, jsonKey: string | undefined): string {
  // A secret store may hold the raw value or a JSON document containing it.
  const trimmed = payload.trim();
  if (!trimmed.startsWith('{')) return trimmed;

  const parsed = JSON.parse(trimmed) as Record<string, unknown>;

  // Vault wraps the value twice: { data: { data: { <key>: value } } }
  const vaultData = (parsed.data as { data?: Record<string, unknown> } | undefined)?.data;
  const bag = vaultData ?? (parsed.data as Record<string, unknown> | undefined) ?? parsed;

  if (jsonKey) {
    const value = bag[jsonKey] ?? parsed[jsonKey];
    if (typeof value === 'string') return value;
    throw new Error(`secret document has no string field "${jsonKey}"`);
  }

  // AWS Secrets Manager's own envelope.
  if (typeof parsed.SecretString === 'string') return extract(parsed.SecretString, undefined);

  const values = Object.values(bag).filter((v) => typeof v === 'string');
  if (values.length === 1) return values[0] as string;

  throw new Error('secret document has several fields — set SECRET_JSON_KEY to choose one');
}

export interface SecretSourceConfig {
  source: SecretSource;
  /** Path for `file`, secret id for `aws`, secret path for `vault`. */
  ref?: string | undefined;
  /** Field to read when the stored secret is a JSON document. */
  jsonKey?: string | undefined;
  /** Sidecar base URL. Defaults to the vendor's conventional localhost port. */
  agentUrl?: string | undefined;
  /** Value to use when `source` is `env`. */
  envValue?: string | undefined;
}

export async function loadEncryptionKey(cfg: SecretSourceConfig): Promise<Buffer> {
  const raw = await loadRaw(cfg);
  const key = Buffer.from(raw.trim(), 'base64');

  if (key.length !== 32) {
    throw new Error(
      `CREDENTIALS_ENC_KEY must be 32 bytes base64-encoded; got ${key.length} bytes from source "${cfg.source}"`,
    );
  }

  // The source is worth logging. The key never is.
  logger.info({ source: cfg.source }, 'encryption key loaded');
  return key;
}

async function loadRaw(cfg: SecretSourceConfig): Promise<string> {
  switch (cfg.source) {
    case 'env': {
      if (!cfg.envValue) {
        throw new Error('SECRET_SOURCE=env but CREDENTIALS_ENC_KEY is not set');
      }
      return cfg.envValue;
    }

    case 'file': {
      if (!cfg.ref) throw new Error('SECRET_SOURCE=file requires SECRET_REF (the mount path)');
      return extract(await readFile(cfg.ref, 'utf8'), cfg.jsonKey);
    }

    case 'aws': {
      if (!cfg.ref) throw new Error('SECRET_SOURCE=aws requires SECRET_REF (the secret id or ARN)');
      const base = cfg.agentUrl ?? 'http://localhost:2773';
      const url = `${base}/secretsmanager/get?secretId=${encodeURIComponent(cfg.ref)}`;
      // The agent authorises with the task role; this token only proves the
      // caller is inside the container.
      const token = process.env.AWS_SESSION_TOKEN ?? '';
      return extract(await fetchFromAgent(url, { 'X-Aws-Parameters-Secrets-Token': token }), cfg.jsonKey);
    }

    case 'vault': {
      if (!cfg.ref) throw new Error('SECRET_SOURCE=vault requires SECRET_REF (the secret path)');
      const base = cfg.agentUrl ?? 'http://127.0.0.1:8200';
      const url = `${base}/v1/${cfg.ref.replace(/^\/+/, '')}`;
      const token = process.env.VAULT_TOKEN ?? '';
      return extract(await fetchFromAgent(url, { 'X-Vault-Token': token }), cfg.jsonKey);
    }
  }
}
