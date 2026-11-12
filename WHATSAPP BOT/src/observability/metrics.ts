import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { pool, query } from '../db/pool.js';
import { dispatchQueue, scheduledQueue } from '../queue/queues.js';
import { logger } from '../logging/logger.js';

/**
 * OBSERVABILITY
 *
 * Prometheus text format on /metrics, because it is the neutral choice:
 * Prometheus, Grafana Agent, Datadog's OpenMetrics check, New Relic and
 * CloudWatch's agent all scrape it, so this decision does not lock the backend
 * team into a vendor before they have picked one.
 *
 * Labels carry `outlet` deliberately — the spec asks for "alerts named by
 * outlet", and an alert that says "sends are failing" is useless when you run
 * forty restaurants. Labels never carry a phone number, a guest name or a
 * message id: those are unbounded and they are personal data.
 *
 * The alert rules that go with these are in docs/alerts.md.
 */

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'restoos_wa_' });

const ns = 'restoos_wa';

// ------------------------------------------------------------- counters --

export const messagesAccepted = new Counter({
  name: `${ns}_messages_accepted_total`,
  help: 'Messages accepted at intake and queued for delivery.',
  labelNames: ['event_type', 'category', 'outlet'] as const,
  registers: [registry],
});

export const messagesSent = new Counter({
  name: `${ns}_messages_sent_total`,
  help: 'Messages handed to the WhatsApp Cloud API and accepted by it.',
  labelNames: ['event_type', 'category', 'outlet'] as const,
  registers: [registry],
});

export const messagesFailed = new Counter({
  name: `${ns}_messages_failed_total`,
  help: 'Messages that reached a terminal failure.',
  labelNames: ['event_type', 'error_code', 'meta_code', 'outlet'] as const,
  registers: [registry],
});

export const messagesBlocked = new Counter({
  name: `${ns}_messages_blocked_total`,
  help: 'Sends refused before dispatch, by reason.',
  labelNames: ['event_type', 'reason', 'outlet'] as const,
  registers: [registry],
});

export const deliveryStatus = new Counter({
  name: `${ns}_delivery_status_total`,
  help: 'Delivery receipts received from Meta.',
  labelNames: ['status', 'outlet'] as const,
  registers: [registry],
});

export const webhooksReceived = new Counter({
  name: `${ns}_webhooks_received_total`,
  help: 'Inbound webhook calls, by outcome.',
  labelNames: ['outcome'] as const, // accepted | bad_signature | error
  registers: [registry],
});

export const feedbackSessions = new Counter({
  name: `${ns}_feedback_sessions_total`,
  help: 'Feedback conversations by how they ended.',
  labelNames: ['outcome', 'outlet'] as const, // completed | declined | expired
  registers: [registry],
});

export const feedbackRatings = new Histogram({
  name: `${ns}_feedback_rating`,
  help: 'Ratings given, 1-10.',
  labelNames: ['outlet'] as const,
  buckets: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  registers: [registry],
});

export const orphansRequeued = new Counter({
  name: `${ns}_orphans_requeued_total`,
  help: 'Messages recovered by the reconciler after a dual-write gap.',
  registers: [registry],
});

export const retentionRedacted = new Counter({
  name: `${ns}_retention_redacted_total`,
  help: 'Records whose guest identifiers were stripped.',
  labelNames: ['table', 'trigger'] as const, // trigger: schedule | erasure
  registers: [registry],
});

// ----------------------------------------------------------- histograms --

export const dispatchDuration = new Histogram({
  name: `${ns}_dispatch_duration_seconds`,
  help: 'Time spent in the Graph API call.',
  labelNames: ['outcome'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15],
  registers: [registry],
});

export const queueLatency = new Histogram({
  name: `${ns}_queue_latency_seconds`,
  help: 'Intake to first dispatch attempt. The number that tells you if the 30s call-fallback SLA holds.',
  labelNames: ['event_type', 'urgent'] as const,
  buckets: [1, 5, 10, 30, 60, 300, 1800],
  registers: [registry],
});

// --------------------------------------------------------------- gauges --

/**
 * Gauges are filled on scrape rather than kept live, so a restarted process
 * reports the truth immediately instead of counting up from zero.
 */
const queueDepth = new Gauge({
  name: `${ns}_queue_depth`,
  help: 'Jobs in the dispatch and scheduled queues.',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
});

const stuckMessages = new Gauge({
  name: `${ns}_messages_stuck`,
  help: 'Messages sitting in a non-terminal state longer than they should.',
  labelNames: ['state'] as const,
  registers: [registry],
});

const credentialsUnhealthy = new Gauge({
  name: `${ns}_credentials_unhealthy`,
  help: 'Outlets whose WhatsApp credentials are expired or disabled.',
  labelNames: ['status'] as const,
  registers: [registry],
});

export async function refreshGauges(): Promise<void> {
  try {
    for (const [name, q] of [
      ['dispatch', dispatchQueue],
      ['scheduled', scheduledQueue],
    ] as const) {
      const counts = await q.getJobCounts('wait', 'active', 'delayed', 'failed');
      for (const [state, value] of Object.entries(counts)) {
        queueDepth.set({ queue: name, state }, value);
      }
    }

    // QUEUED for over five minutes means the dispatcher is not keeping up or
    // has stopped. SENT for over an hour means Meta's receipts are not arriving.
    const stuck = await query<{ state: string; n: string }>(
      pool,
      `SELECT state, count(*)::text AS n FROM messages
        WHERE (state = 'QUEUED' AND created_at < now() - interval '5 minutes')
           OR (state = 'SENT'   AND sent_at    < now() - interval '1 hour')
        GROUP BY state`,
    );
    stuckMessages.reset();
    for (const row of stuck) stuckMessages.set({ state: row.state }, Number(row.n));

    const creds = await query<{ status: string; n: string }>(
      pool,
      `SELECT status, count(*)::text AS n FROM wa_credentials
        WHERE status <> 'ACTIVE' GROUP BY status`,
    );
    credentialsUnhealthy.reset();
    for (const row of creds) credentialsUnhealthy.set({ status: row.status }, Number(row.n));
  } catch (err) {
    // A scrape must never take the process down.
    logger.error({ err }, 'failed to refresh metric gauges');
  }
}
