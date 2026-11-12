import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { logger } from './logging/logger.js';
import { AppError } from './domain/errors.js';
import { notificationRoutes } from './api/routes/notifications.js';
import { webhookRoutes } from './api/routes/webhook.js';
import { adminRoutes } from './api/routes/admin.js';
import { voiceCompatRoutes } from './api/routes/voiceCompat.js';
import { governanceRoutes } from './api/routes/governance.js';
import { campaignRoutes } from './api/routes/campaigns.js';
import { registry, refreshGauges } from './observability/metrics.js';
import { pool } from './db/pool.js';

export async function buildServer() {
  const app = Fastify({ loggerInstance: logger, trustProxy: true });

  /**
   * Keep the raw body. Meta signs the exact bytes it sent, so verifying against
   * a re-serialised object fails on anything with unusual key ordering or
   * unicode escaping.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Server-side limits. Client-side countdowns are convenience only.
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    // Per key rather than per IP: one restaurant's campaign burst must not
    // rate-limit another restaurant's table-ready ping from the same gateway.
    keyGenerator: (req) => (req.headers.authorization as string) ?? req.ip,
    allowList: (req) => req.url === '/healthz' || req.url === '/metrics',
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send(err.toResponse());
    }
    const asError = err as { validation?: unknown; message?: string };
    if (asError.validation) {
      return reply.code(400).send({
        error: {
          code: 'TEMPLATE_PARAMS_INVALID',
          message: asError.message ?? 'Request body is not valid.',
        },
      });
    }
    logger.error({ err }, 'unhandled request error');
    return reply.code(500).send({
      error: { code: 'INTERNAL', message: 'Something went wrong on our side.' },
    });
  });

  app.get('/healthz', async () => ({ ok: true }));

  /**
   * Prometheus text format. Deliberately vendor-neutral: Prometheus, Grafana
   * Agent, the Datadog OpenMetrics check and the CloudWatch agent all scrape
   * this, so the choice of monitoring stack stays open.
   *
   * Unauthenticated, like every /metrics endpoint, so it must not be exposed
   * publicly — bind it to the internal network or put it behind the ingress.
   * It carries no guest data: labels are event types, error codes and outlet
   * names only.
   */
  app.get('/metrics', async (_req, reply) => {
    if (!config.METRICS_ENABLED) return reply.code(404).send();
    await refreshGauges();
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await app.register(webhookRoutes);
  await app.register(notificationRoutes);
  await app.register(adminRoutes);
  await app.register(voiceCompatRoutes);
  await app.register(governanceRoutes);
  await app.register(campaignRoutes);

  return app;
}

export async function start() {
  const app = await buildServer();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'api listening');
  return app;
}
