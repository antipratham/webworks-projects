/**
 * STAGE 0 - Safety screen.
 *
 * Runs before any model call, in plain code, so it cannot be talked around: a guest
 * who abuses the terminal is answered by a fixed string, and the model is never
 * asked to compose a reply to them.
 *
 * This layer is deliberately narrow. It catches the unambiguous cases - slurs and
 * direct abuse - and leaves judgement ("is this about the menu at all?") to Stage 1,
 * which classifies every request as MENU, OFF_TOPIC or ABUSIVE. Two layers, because
 * a word list misses what is phrased politely and a model misses what is misspelt.
 */

import type { RequestKind } from './taxonomy.ts';

/**
 * Conservative and deliberately short. Anything subtler is Stage 1's judgement call.
 * Stems are matched on a word boundary at the start, so "bastards" and "bloody"
 * are caught by "bastard" and "bloody" without a combinatorial list.
 *
 * Kept in English, Hindi and Kannada transliteration because the guest surfaces
 * are in all three.
 */
const ABUSE_STEMS = [
  // English
  'fuck',
  'fucking',
  'shit',
  'bitch',
  'bastard',
  'asshole',
  'dickhead',
  'cunt',
  'retard',
  'scumbag',
  'whore',
  'slut',
  // Hindi / Urdu, as speech-to-text and keyboards write them
  'chutiya',
  'chutiye',
  'bhosdi',
  'bhosda',
  'madarchod',
  'behenchod',
  'bhenchod',
  'gaandu',
  'gandu',
  'harami',
  'kamina',
  'kamine',
  'randi',
  // Kannada
  'bevarsi',
];

/**
 * The same words in their own scripts. Normalisation strips to Latin letters, so
 * these are matched against the raw text before that.
 */
const ABUSE_NATIVE: RegExp[] = [
  // Hindi / Devanagari
  /चूतिय[ाे]/,
  /भोसड़?ी/,
  /मादरचोद/,
  /बहनचोद/,
  /हरामी/,
  /कमीन[ाे]/,
  /बकवास/,
  /गांडू/,
  // Kannada
  /ಬೆವರ್ಸಿ/,
  /ಲಾಸ್ಟಿ/,
];

// Words left OUT on purpose. "stupid", "idiot", "kutta", "saala", "nayi" and "boli"
// either collide with ordinary Hindi and Kannada words or mark a rude guest rather
// than an abusive one. Refusing to serve someone who called the menu stupid is worse
// service than answering them, so those are left to Stage 1's judgement.

/** Threats and harassment aimed at people, which a food word list would not catch. */
const THREAT_PATTERNS: RegExp[] = [
  /\b(?:kill|murder|stab|shoot|burn down|beat up|bash)\s+(?:you|u|your|the\s+\w+|staff|waiter|server|chef|manager)\b/i,
  /\bi(?:'|’)?ll\s+(?:kill|hurt|find|get)\s+you\b/i,
  /\b(?:rape|molest)\b/i,
];

/**
 * Folds the tricks used to slip a word past a list: case, repeated letters, digits
 * and symbols standing in for letters, and separators inside a word.
 */
export function normalizeForScreening(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[@4]/g, 'a')
    .replace(/[0]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/[^a-z\s]/g, ' ')
    // Collapse a letter repeated three or more times: "fuuuuck" -> "fuck".
    .replace(/([a-z])\1{2,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const ABUSE_PATTERN = new RegExp(`\\b(?:${ABUSE_STEMS.join('|')})[a-z]*\\b`, 'i');

export interface ScreenResult {
  kind: RequestKind;
  /** The rule that fired, for the log. Never shown to the guest. */
  reason: string | null;
}

/** The deterministic pass. Returns ABUSIVE only on an unambiguous hit. */
export function screenRequest(query: string): ScreenResult {
  const normalized = normalizeForScreening(query);

  const abusive = normalized.match(ABUSE_PATTERN);
  if (abusive) return { kind: 'ABUSIVE', reason: `abuse term: ${abusive[0]}` };

  for (const pattern of ABUSE_NATIVE) {
    if (pattern.test(query)) return { kind: 'ABUSIVE', reason: 'abuse term (native script)' };
  }

  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(query) || pattern.test(normalized)) {
      return { kind: 'ABUSIVE', reason: `threat pattern: ${pattern.source.slice(0, 40)}` };
    }
  }

  return { kind: 'MENU', reason: null };
}

/**
 * Fixed replies. Written here rather than generated, so that nothing a guest types
 * can influence what is said back to them, and so these can be translated with the
 * rest of the guest-facing catalogue.
 *
 * Neither reply lectures. One declines and redirects; the other explains the limit
 * and offers the nearest useful thing.
 */
/** English replies. The Hindi and Kannada versions live in i18n.ts as CANNED. */
export const CANNED_REPLIES: Record<'ABUSIVE' | 'OFF_TOPIC' | 'UNPARSEABLE', string> = {
  ABUSIVE: "I'm here to help you order. Tell me what you feel like eating and I'll find it.",
  OFF_TOPIC:
    "I can only help with this menu — dishes, drinks, flavours, prices and dietary needs. What are you in the mood for?",
  UNPARSEABLE:
    'I could not quite follow that — could you tell me again what you feel like eating?',
};

/**
 * Anything the guest wrote that is echoed back must be sanitised first: a
 * clarification that repeats "cold" is fine, one that repeats an injected
 * instruction is not.
 */
export function sanitizeEcho(text: string, maxLength = 60): string {
  const cleaned = text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>{}[\]`*_#|\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1).trimEnd()}…` : cleaned;
}
