import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Stage 1 is the step most likely to need prompt refinement, so every
 * query -> filter pair is recorded. Refinement then works from real traffic
 * instead of guesswork.
 */
export interface IntentLogEntry {
  ts: string;
  outlet_id: string;
  query: string;
  ok: boolean;
  attempts: number;
  /** The model's raw output, before validation. */
  raw: unknown;
  /** The validated filter, or null when validation failed. */
  filter: unknown;
  errors?: string[];
}

export interface IntentLogger {
  log(entry: IntentLogEntry): Promise<void>;
}

/** Appends JSONL. Logging must never take down a guest-facing request, so writes fail soft. */
export function createFileLogger(path = 'logs/intent.jsonl'): IntentLogger {
  let ready: Promise<void> | null = null;
  return {
    async log(entry) {
      try {
        ready ??= mkdir(dirname(path), { recursive: true }).then(() => undefined);
        await ready;
        await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch (err) {
        console.warn(`[intent-log] write failed: ${(err as Error).message}`);
      }
    },
  };
}

/** In-memory sink for tests and for callers that ship logs elsewhere. */
export function createMemoryLogger(): IntentLogger & { entries: IntentLogEntry[] } {
  const entries: IntentLogEntry[] = [];
  return {
    entries,
    async log(entry) {
      entries.push(entry);
    },
  };
}
