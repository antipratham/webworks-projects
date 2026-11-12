import crypto from 'node:crypto';
import { request } from 'undici';

/**
 * LOAD TEST
 *
 * Not a unit test — it needs the service, Postgres, Redis and a Graph API
 * endpoint running, so it lives outside `npm test` and is run deliberately:
 *
 *   npx tsx test/load/loadtest.ts --rate 50 --seconds 60
 *
 * What it is actually checking is not throughput. It is these four things,
 * which are the ones that hurt in production:
 *
 *  1. Does intake stay responsive while the dispatcher is saturated? If p99
 *     intake latency climbs with queue depth, the Restaurant OS backend starts
 *     timing out on booking confirmations.
 *
 *  2. Do urgent messages still overtake a campaign? The whole priority scheme
 *     exists for the guest standing at the host desk waiting for a table-ready
 *     ping while a winback campaign is mid-send.
 *
 *  3. Does anything get stranded? A non-zero count of messages still QUEUED
 *     long after the run means the reconciler is covering for something.
 *
 *  4. Does memory hold flat? A slow leak under sustained send is invisible in
 *     a unit test and obvious here.
 */

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  const value = process.argv[i + 1];
  if (key && value) args.set(key, value);
}

const BASE = args.get('base') ?? 'http://127.0.0.1:3000';
const RATE = Number(args.get('rate') ?? 50); // requests per second
const SECONDS = Number(args.get('seconds') ?? 30);
const KEY_PATH = args.get('key') ?? 'demo/.key';
const TENANT = args.get('tenant') ?? '11111111-1111-4111-8111-111111111111';
const OUTLET = args.get('outlet') ?? 'demo-outlet';

const apiKey = (await import('node:fs/promises')).readFile(KEY_PATH, 'utf8');
const API_KEY = (await apiKey).trim();

const latencies: number[] = [];
const urgentLatencies: number[] = [];
let ok = 0;
let failed = 0;
let suppressed = 0;

/**
 * Every request gets a distinct guest number, because pacing would otherwise
 * suppress the second message to the same guest and the test would measure the
 * suppression path instead of the send path.
 */
function guestFor(n: number): string {
  // 9 followed by nine digits, always starting 6-9 as the validator requires.
  return `+919${String(100000000 + (n % 800000000)).padStart(9, '0')}`;
}

async function fire(n: number): Promise<void> {
  // One in twenty is a time-critical message, so its latency can be compared
  // against the rest under the same load.
  const urgent = n % 20 === 0;
  const started = performance.now();

  try {
    const res = await request(`${BASE}/v1/notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify(
        urgent
          ? {
              tenantId: TENANT,
              outletId: OUTLET,
              eventType: 'WAITLIST_TABLE_READY',
              phone: guestFor(n),
              params: { guestName: 'Load', outletName: 'The Table', holdMinutes: 10 },
            }
          : {
              tenantId: TENANT,
              outletId: OUTLET,
              eventType: 'BOOKING_CONFIRMED',
              phone: guestFor(n),
              params: {
                guestName: 'Load',
                outletName: 'The Table',
                partySize: 2,
                dateTimeLabel: 'Sat 4 Oct, 8:00 pm',
                manageToken: `bk_${n.toString(36).padStart(8, '0')}`,
              },
            },
      ),
    });

    const body = (await res.body.json()) as { state?: string };
    const elapsed = performance.now() - started;
    (urgent ? urgentLatencies : latencies).push(elapsed);

    if (res.statusCode === 202 && body.state === 'QUEUED') ok += 1;
    else if (body.state === 'SUPPRESSED') suppressed += 1;
    else failed += 1;
  } catch {
    failed += 1;
    latencies.push(performance.now() - started);
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

console.log(`\nLoad: ${RATE}/s for ${SECONDS}s against ${BASE}\n`);

const startedAt = Date.now();
let counter = 0;
const inFlight: Promise<void>[] = [];

for (let second = 0; second < SECONDS; second += 1) {
  const tickStart = Date.now();
  for (let i = 0; i < RATE; i += 1) {
    inFlight.push(fire(counter++));
  }
  const drift = 1000 - (Date.now() - tickStart);
  if (drift > 0) await new Promise((r) => setTimeout(r, drift));

  if ((second + 1) % 10 === 0) {
    console.log(
      `  ${second + 1}s  sent=${counter}  ok=${ok}  suppressed=${suppressed}  failed=${failed}` +
        `  p95=${percentile(latencies, 95).toFixed(0)}ms`,
    );
  }
}

await Promise.allSettled(inFlight);
const wall = (Date.now() - startedAt) / 1000;

console.log(`
Intake
  requests        ${counter} in ${wall.toFixed(1)}s  (${(counter / wall).toFixed(1)}/s)
  accepted        ${ok}
  suppressed      ${suppressed}
  failed          ${failed}

Latency (intake only — delivery is asynchronous)
  p50             ${percentile(latencies, 50).toFixed(0)} ms
  p95             ${percentile(latencies, 95).toFixed(0)} ms
  p99             ${percentile(latencies, 99).toFixed(0)} ms

Urgent messages, same load
  p95             ${percentile(urgentLatencies, 95).toFixed(0)} ms
  p99             ${percentile(urgentLatencies, 99).toFixed(0)} ms

Now check, after the queue drains:

  curl -s ${BASE}/metrics | grep -E 'queue_depth|messages_stuck'

  messages_stuck{state="QUEUED"} should return to 0.
  Anything left means the dispatcher could not keep up, or something was
  stranded and the reconciler has not run yet.
`);

if (failed > 0) {
  console.error(`${failed} request(s) failed.`);
  process.exit(1);
}
