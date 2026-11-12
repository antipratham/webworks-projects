import { Worker, UnrecoverableError, type Job } from 'bullmq';
import {
  connection,
  QUEUE_DISPATCH,
  isNumberThrottled,
  markNumberThrottled,
  sendRateFor,
  tryConsumeSendSlot,
  type DispatchJob,
} from './queues.js';
import { getCredentials, markTokenExpired } from '../tenancy/credentials.js';
import { getMessage, incrementAttempt, transition } from '../messages/repository.js';
import { sendMessage } from '../whatsapp/client.js';
import { WhatsAppError } from '../whatsapp/errors.js';
import { AppError } from '../domain/errors.js';
import { logger, maskPhone } from '../logging/logger.js';
import {
  messagesSent,
  messagesFailed,
  dispatchDuration,
  queueLatency,
} from '../observability/metrics.js';

/**
 * The dispatcher.
 *
 * Its whole job: take one QUEUED message, respect the number's throughput, hand
 * it to Meta, and record what happened. It never decides *whether* a message
 * should exist — consent, quiet hours and template validity were settled at
 * intake. It only decides whether to try again.
 */
export function startDispatchWorker() {
  const worker = new Worker<DispatchJob>(
    QUEUE_DISPATCH,
    async (job: Job<DispatchJob>) => {
      const { messageId, outletId } = job.data;

      const message = await getMessage(messageId);
      if (!message) throw new UnrecoverableError(`Message ${messageId} vanished.`);

      // Idempotency at the worker level: a redelivered job for a message that
      // already left must not send it twice.
      if (message.state !== 'QUEUED') {
        logger.debug({ messageId, state: message.state }, 'dispatch skipped, already left QUEUED');
        return;
      }

      let creds;
      try {
        creds = await getCredentials(outletId);
      } catch (err) {
        if (err instanceof AppError && !err.retryable) {
          await transition(messageId, 'FAILED', {
            actor: 'SYSTEM',
            reason: err.message,
            errorCode: err.code,
          });
          throw new UnrecoverableError(err.message);
        }
        throw err;
      }

      // A number Meta has throttled is parked, not hammered.
      if (await isNumberThrottled(creds.phoneNumberId)) {
        await job.moveToDelayed(Date.now() + 30_000, job.token);
        return;
      }

      const perSecond = sendRateFor(creds.messagingTier);
      if (!(await tryConsumeSendSlot(creds.phoneNumberId, perSecond))) {
        // Out of budget this second. Come back shortly; do not count an attempt.
        await job.moveToDelayed(Date.now() + 1_000, job.token);
        return;
      }

      const attempt = await incrementAttempt(messageId);
      const startedAt = process.hrtime.bigint();

      try {
        const { wamid } = await sendMessage(creds, message.payload, attempt);
        await transition(messageId, 'SENT', { actor: 'SYSTEM', wamid });

        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        dispatchDuration.observe({ outcome: 'sent' }, seconds);
        messagesSent.inc({
          event_type: message.event_type,
          category: message.category,
          outlet: creds.outletName,
        });
        if (job.timestamp) {
          // Intake to first attempt. This is the number that says whether the
          // 30-second call-fallback promise is actually being kept.
          queueLatency.observe(
            { event_type: message.event_type, urgent: String(job.data.urgent) },
            Math.max(0, (Date.now() - job.timestamp) / 1000),
          );
        }
        logger.info(
          {
            messageId,
            eventType: message.event_type,
            guest: maskPhone(message.to_phone_e164),
            attempt,
          },
          'message handed to whatsapp',
        );
      } catch (err) {
        dispatchDuration.observe(
          { outcome: 'failed' },
          Number(process.hrtime.bigint() - startedAt) / 1e9,
        );
        if (!(err instanceof WhatsAppError)) throw err;

        if (err.credentialFailure) {
          await markTokenExpired(creds.phoneNumberId);
        }
        if (err.throttled) {
          await markNumberThrottled(creds.phoneNumberId, 60);
        }

        if (!err.retryable) {
          messagesFailed.inc({
            event_type: message.event_type,
            error_code: err.code,
            meta_code: String(err.metaCode),
            outlet: creds.outletName,
          });
          await transition(messageId, 'FAILED', {
            actor: 'SYSTEM',
            reason: err.message,
            errorCode: err.code,
            errorDetail: `meta:${err.metaCode}`,
          });
          // Stop BullMQ from spending five more attempts on a settled failure.
          throw new UnrecoverableError(`${err.code} (meta ${err.metaCode})`);
        }

        // Retryable: leave the row QUEUED and let backoff do its work. If this
        // was the final attempt, `failed` below marks it FAILED.
        throw err;
      }
    },
    { connection, concurrency: 20 },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) return;

    await transition(job.data.messageId, 'FAILED', {
      actor: 'SYSTEM',
      reason: `retries exhausted: ${err.message}`,
      errorCode: err instanceof AppError ? err.code : 'WHATSAPP_TRANSIENT',
    });
    logger.error(
      { messageId: job.data.messageId, attempts: job.attemptsMade },
      'message failed permanently after retries',
    );
  });

  logger.info('dispatch worker started');
  return worker;
}
