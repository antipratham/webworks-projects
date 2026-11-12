import { config } from '../config.js';
import { loadEncryptionKey } from './secretSource.js';

/**
 * The process-wide encryption key.
 *
 * Loaded once at boot, deliberately: re-reading it per request would put a
 * network call in front of every send, and an outage at the secret store would
 * then stop a restaurant messaging its guests. Rotation is a rolling restart
 * with both keys valid during the overlap.
 *
 * Every entry point must call `initKeyring()` before serving traffic. Reading
 * the key before that throws rather than falling back to something weaker — a
 * silent fallback here would encrypt tenant tokens with a key nobody chose.
 */
let key: Buffer | undefined;

export async function initKeyring(): Promise<void> {
  if (key) return;
  key = await loadEncryptionKey({
    source: config.SECRET_SOURCE,
    ref: config.SECRET_REF,
    jsonKey: config.SECRET_JSON_KEY,
    agentUrl: config.SECRET_AGENT_URL,
    envValue: config.CREDENTIALS_ENC_KEY,
  });
}

export function encryptionKey(): Buffer {
  if (!key) {
    throw new Error('Keyring is not initialised. Call initKeyring() before serving traffic.');
  }
  return key;
}

/** Tests and scripts that need a key without a secret store. */
export function setKeyForTesting(value: Buffer): void {
  key = value;
}
