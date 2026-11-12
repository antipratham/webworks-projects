import { request } from 'undici';
import { config } from '../config.js';
import { logger } from '../logging/logger.js';

/**
 * Calls back into the Restaurant OS backend.
 *
 * This service owns message delivery and nothing else. Feedback answers, manager
 * alerts and booking changes all belong to the Restaurant OS domain, so they go
 * home as soon as they are captured. Nothing guest-shaped is stored here longer
 * than the conversation needs it.
 */

async function post<T>(path: string, body: unknown): Promise<T | undefined> {
  try {
    const res = await request(`${config.RESTAURANT_OS_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.RESTAURANT_OS_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    if (res.statusCode >= 300) {
      logger.error({ path, status: res.statusCode }, 'restaurant os rejected callback');
      return undefined;
    }
    return (await res.body.json()) as T;
  } catch (err) {
    logger.error({ err, path }, 'restaurant os callback failed');
    return undefined;
  }
}

async function get<T>(path: string): Promise<T | undefined> {
  try {
    const res = await request(`${config.RESTAURANT_OS_BASE_URL}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.RESTAURANT_OS_API_KEY}` },
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    if (res.statusCode >= 300) return undefined;
    return (await res.body.json()) as T;
  } catch (err) {
    logger.error({ err, path }, 'restaurant os lookup failed');
    return undefined;
  }
}

export interface FeedbackSubmission {
  tenantId: string;
  outletId: string;
  visitId: string;
  rating: number;
  answers: Record<string, string>;
  channel: 'WHATSAPP';
  completedAt: string;
}

export async function submitFeedback(payload: FeedbackSubmission): Promise<void> {
  await post('/internal/v1/feedback', payload);
}

/**
 * A rating of 6 or less must reach a manager within five minutes. We fire this
 * the moment the rating lands, before the remaining questions, because five
 * minutes is a promise and the guest may never finish the survey.
 */
export async function alertManager(payload: {
  tenantId: string;
  outletId: string;
  visitId: string;
  rating: number;
  severity: 'DETRACTOR';
}): Promise<void> {
  await post('/internal/v1/alerts/feedback', payload);
}

/** One-tap actions from a reminder template. */
export async function confirmBooking(bookingId: string, tenantId: string): Promise<void> {
  await post('/internal/v1/bookings/confirm', { bookingId, tenantId, actor: 'GUEST_WHATSAPP' });
}

export async function cancelBooking(bookingId: string, tenantId: string): Promise<void> {
  await post('/internal/v1/bookings/cancel', {
    bookingId,
    tenantId,
    actor: 'GUEST_WHATSAPP',
    reason: 'Guest cancelled from the WhatsApp reminder',
  });
}

/** Where promoters are sent. Null when the outlet has not configured one. */
export async function getReviewLink(outletId: string): Promise<string | undefined> {
  const res = await get<{ reviewUrl?: string }>(`/internal/v1/outlets/${outletId}/review-link`);
  return res?.reviewUrl;
}
