import { initKeyring } from '../tenancy/keyring.js';
import { startDispatchWorker } from './dispatchWorker.js';
import { startScheduledWorker } from './scheduler.js';
import { logger } from '../logging/logger.js';

/** Workers only. Run this alongside the API once campaign volume justifies it. */
await initKeyring();

const dispatch = startDispatchWorker();
const scheduled = startScheduledWorker();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'workers shutting down');
    await Promise.allSettled([dispatch.close(), scheduled.close()]);
    process.exit(0);
  });
}
