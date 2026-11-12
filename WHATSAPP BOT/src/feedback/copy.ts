import type { Locale } from '../templates/registry.js';

/**
 * Guest-facing strings for the feedback conversation.
 *
 * Spec rule: no hard-coded strings on guest surfaces — they come from a
 * catalogue. This file IS that catalogue for the one conversational surface;
 * template copy lives in Meta's approved templates instead.
 *
 * English only, by decision. The shape is per-locale so a second language is a
 * new object here plus approved templates, nothing structural.
 */

export interface FeedbackCopy {
  ratingHeader: string;
  ratingBody: (outlet: string) => string;
  ratingButton: string;
  ratingRow: (n: number) => string;
  ratingLow: string;
  ratingHigh: string;

  q1: string;
  q2: string;
  q3: string;
  optionGood: string;
  optionOkay: string;
  optionPoor: string;

  thanksPromoter: (outlet: string) => string;
  reviewCta: string;
  thanksPassive: (outlet: string) => string;
  apologyDetractor: (outlet: string) => string;

  declined: string;
  notUnderstood: string;
  expired: string;
}

const en: FeedbackCopy = {
  ratingHeader: 'Your visit',
  ratingBody: (outlet) =>
    `Thanks for dining at ${outlet}. Out of 10, how was your experience overall?`,
  ratingButton: 'Rate 1-10',
  ratingRow: (n) => String(n),
  ratingLow: 'Poor',
  ratingHigh: 'Excellent',

  q1: 'And the food?',
  q2: 'How was the service?',
  q3: 'How was the ambience?',
  optionGood: 'Great',
  optionOkay: 'Fine',
  optionPoor: 'Poor',

  thanksPromoter: (outlet) =>
    `That is lovely to hear — thank you. If you have a moment, a public review helps ${outlet} more than you would think.`,
  reviewCta: 'Leave a review',
  thanksPassive: () => 'Thank you for taking the time. We have passed your notes to the team.',
  apologyDetractor: (outlet) =>
    `We are sorry — that is not the evening ${outlet} wanted to give you. The manager has been told and will be in touch shortly.`,

  declined: 'No problem at all. We hope to see you again soon.',
  notUnderstood: 'Sorry, could you pick one of the options above?',
  expired: 'This feedback link has closed. Thank you all the same.',
};

export const COPY: Record<Locale, FeedbackCopy> = { en };

export function copyFor(locale: Locale): FeedbackCopy {
  return COPY[locale] ?? COPY.en;
}
