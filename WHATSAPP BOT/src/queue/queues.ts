import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

export const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export interface DispatchJob {
  messageId: string;
  outletId: string;
  /** Time-critical events jump the queue: call fallback, table ready, deposit. */
  urgent: boolean;
}

export interface ScheduledJob {
  scheduleId: string;
}

export const QUEUE_DISPATCH = 'wa-dispatch';
export const QUEUE_SCHEDULED = 'wa-scheduled';

export const dispatchQueue = new Queue<DispatchJob>(QUEUE_DISPATCH, {
  connection,
  defaultJobOptions: {
    // Backoff is exponential from 5s: 5s, 10s, 20s, 40s, 80s, 160s.
    attempts: 6,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: { age: 7 * 86_400 },
  },
});

export const scheduledQueue = new Queue<ScheduledJob>(QUEUE_SCHEDULED, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 86_400 },
    removeOnFail: { age: 30 * 86_400 },
  },
});

/**
 * Per-number throughput guard.
 *
 * Meta throttles per phone number, and a 131048 on one outlet must not stall
 * every other tenant sharing this worker. A simple fixed-window counter in
 * Redis is enough: we are pacing ourselves, not enforcing Meta's exact limit.
 */
const WINDOW_SECONDS = 1;

export async function tryConsumeSendSlot(
  phoneNumberId: string,
  perSecond: number,
): Promise<boolean> {
  const bucket = `wa:rate:${phoneNumberId}:${Math.floor(Date.now() / 1000 / WINDOW_SECONDS)}`;
  const used = await connection.incr(bucket);
  if (used === 1) await connection.expire(bucket, WINDOW_SECONDS + 1);
  return used <= perSecond;
}

/** Set by a 131048/130429: pause this number for a while. */
export async function markNumberThrottled(phoneNumberId: string, seconds: number): Promise<void> {
  await connection.set(`wa:throttled:${phoneNumberId}`, '1', 'EX', seconds);
}

export async function isNumberThrottled(phoneNumberId: string): Promise<boolean> {
  return (await connection.exists(`wa:throttled:${phoneNumberId}`)) === 1;
}

/** Sends per second, derived from the outlet's Meta messaging tier. */
export function sendRateFor(tier: string): number {
  switch (tier) {
    case 'TIER_250':
      return 2;
    case 'TIER_1K':
      return 5;
    case 'TIER_10K':
      return 20;
    case 'TIER_100K':
      return 50;
    case 'UNLIMITED':
      return 80;
    default:
      return 5;
  }
}
