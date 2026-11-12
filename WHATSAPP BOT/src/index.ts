import { initKeyring } from './tenancy/keyring.js';
import { start } from './server.js';
import { startDispatchWorker } from './queue/dispatchWorker.js';
import { startScheduledWorker } from './queue/scheduler.js';
import { expireStaleSessions } from './feedback/fsm.js';
import { reconcileOrphanedMessages } from './queue/reconcile.js';
import { runRetentionSweep } from './retention/retention.js';
import { drainCampaigns } from './campaigns/service.js';
import { logger } from './logging/logger.js';

/**
 * Single-process entrypoint: API and workers together. Fine for staging and for
 * one restaurant. Split them (`npm start` and `npm run worker`) before a
 * campaign sends to more than a few thousand guests, so a slow dispatch cannot
 * make the intake API time out.
 */
// Before anything can encrypt a tenant token or serve a request.
await initKeyring();

const app = await start();
const dispatch = startDispatchWorker();
const scheduled = startScheduledWorker();

const sweeper = setInterval(() => {
  expireStaleSessions()
    .then((n) => n && logger.info({ expired: n }, 'stale feedback sessions closed'))
    .catch((err) => logger.error({ err }, 'feedback sweeper failed'));

  // Catches anything stranded between the Postgres commit and the Redis enqueue.
  reconcileOrphanedMessages().catch((err) => logger.error({ err }, 'reconciler failed'));
}, 60_000);

/**
 * Retention runs daily. It is safe to run on every instance — the work is
 * batched and idempotent — but in a multi-instance deployment you would
 * normally pin it to one, or move it to a scheduled job.
 */
/**
 * Campaign drain. Each tick releases one tick's worth of recipients per
 * campaign, so the send rate is enforced by how much work a tick does rather
 * than by sleeping in a loop — which means a restart resumes cleanly.
 */
const CAMPAIGN_TICK_SECONDS = 10;
const campaigns = setInterval(() => {
  drainCampaigns(CAMPAIGN_TICK_SECONDS)
    .then((n) => n && logger.info({ sent: n }, 'campaign recipients queued'))
    .catch((err) => logger.error({ err }, 'campaign drain failed'));
}, CAMPAIGN_TICK_SECONDS * 1000);

const retention = setInterval(() => {
  runRetentionSweep().catch((err) => logger.error({ err }, 'retention sweep failed'));
}, 24 * 3600_000);

// Once at boot too, so a service that restarts daily still meets its obligation.
runRetentionSweep().catch((err) => logger.error({ err }, 'initial retention sweep failed'));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'shutting down');
    clearInterval(sweeper);
    clearInterval(retention);
    clearInterval(campaigns);
    await Promise.allSettled([app.close(), dispatch.close(), scheduled.close()]);
    process.exit(0);
  });
}
