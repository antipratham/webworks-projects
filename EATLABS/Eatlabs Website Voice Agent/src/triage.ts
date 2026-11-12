/**
 * STAGE 0 - decide whether this is a question at all, before retrieval sees it.
 *
 * Four kinds of input are not questions about EatLabs, and all four used to be
 * answered anyway, because BM25 will always rank something:
 *
 *   abuse      - venting, or testing what the agent will say back
 *   gibberish  - "asdkjhasd", a pocket dial, a mash of the keyboard
 *   misheard   - word-shaped, but a recogniser produced it from something that was not
 *                speech: silence, music, a noisy line, a decoder stuck in a loop
 *   empty      - a stray submit
 *
 * Each gets a short, calm, fixed reply. None of them reaches the index, so none of them
 * can surface a passage that happens to share a rare word with the insult.
 *
 * Why all of this is here and not in the prompt: these are the replies that must not
 * change when the model behind the agent changes. Qwen on the GPU box has to handle a
 * misheard line exactly as the testing model does, and the only way to promise that is
 * for no model to be involved.
 *
 * This runs before retrieval rather than after, for a reason worth keeping: on a phone
 * line the reply to abuse should be immediate and identical every time. Routing it
 * through retrieval and a model would make it slower, variable, and arguable.
 */

/** Rude, but still a question. These are answered normally: annoyance is not abuse. */
const COMPLAINT_WORDS = /\b(?:useless|rubbish|terrible|awful|hate|stupid|worst|pathetic|nonsense|waste)\b/i;

/**
 * Abuse, as opposed to a complaint. Deliberately short and whole-word only.
 *
 * Substring matching is not an option here - it is how a filter ends up rejecting
 * "Scunthorpe", "assess" or "classic". Every entry is matched with word boundaries.
 *
 * It is meant to be extended by whoever runs this, including with Hindi and Kannada
 * terms written in Latin script, which is how people actually type them. It will never
 * be complete, and it does not need to be: everything it misses falls through to the
 * ordinary path, which answers from the knowledge base or hands over.
 */
const ABUSE_WORDS = [
  'fuck', 'fucking', 'fucker', 'shit', 'bullshit', 'bastard', 'bitch', 'cunt',
  'dick', 'asshole', 'arsehole', 'wanker', 'prick', 'slut', 'whore', 'retard',
  'chutiya', 'chutiye', 'bhenchod', 'behenchod', 'madarchod', 'madarchod',
  'gandu', 'gaandu', 'harami', 'kutta', 'kamina', 'randi', 'lauda', 'bokka',
];

/** Common inflections, so the list holds stems rather than every form of every word. */
const ABUSE = new RegExp(`\\b(?:${ABUSE_WORDS.join('|')})(?:s|es|ed|ing|er|ers|y)?\\b`, 'i');

/**
 * Character substitutions people use to get past exactly this kind of filter. Applied
 * only for the abuse test, never to the text that reaches retrieval.
 */
function deleet(s: string): string {
  return s
    .toLowerCase()
    .replace(/[@4]/g, 'a')
    .replace(/[3]/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    // Collapse every repeat, not just long ones: "fuuuuck" has to reach "fuck" exactly,
    // because the match is anchored on word boundaries. No entry in the list above has a
    // doubled letter, so this cannot turn a clean word into a hit.
    .replace(/(.)\1+/g, '$1')
    .replace(/[^a-z0-9\s]/g, ' ');
}

/**
 * "f u c k" and "f.u.c.k" are the same word with the boundaries removed, so a run of
 * single letters is closed up and tested as one. Four or more, to leave initialisms
 * like "a m p m" and ordinary short words alone.
 */
function joinSpacedLetters(s: string): string {
  return s.replace(/\b(?:[a-z]\W+){3,}[a-z]\b/gi, (m) => m.replace(/\W+/g, ''));
}

/**
 * Keyboard mashing passes the vowel test - "qwertyuiop" is full of vowels - so it needs
 * its own check. These are the three rows and their reverses, in runs long enough that
 * no real word contains one.
 */
const KEYBOARD_RUN = /(?:qwert|werty|ertyu|rtyui|tyuio|yuiop|asdfg|sdfgh|dfghj|fghjk|ghjkl|zxcvb|xcvbn|cvbnm|poiuy|lkjhg|mnbvc)/i;

const VOWEL = /[aeiouy]/;
const LONG_CONSONANT_RUN = /[bcdfghjklmnpqrstvwxz]{5,}/;

/**
 * Does this token look like a word someone meant to type?
 *
 * Deliberately generous. A false "gibberish" is worse than a false "question": the
 * question still gets an answer or an honest handover, while a real question wrongly
 * called gibberish is told to rephrase something it said perfectly well. So a token
 * only fails on strong evidence - no vowel at all, or a consonant pile-up no language
 * written in this script produces.
 */
function looksTyped(token: string): boolean {
  if (token.length <= 3) return true;              // too short to judge; "SLA", "GST", "AI"
  if (/\d/.test(token)) return true;               // prices, dates, phone numbers
  if (KEYBOARD_RUN.test(token)) return false;
  if (!VOWEL.test(token)) return false;
  if (LONG_CONSONANT_RUN.test(token)) return false;
  return true;
}

/**
 * How the words arrived. It changes two things and nothing else: which failures are
 * plausible, and how the reply is worded. "Could you type that again" to someone who
 * spoke, or "say it again" to someone who typed, is a small thing that reads as the
 * agent not having been listening.
 */
export type Source = 'text' | 'voice';

/**
 * What a speech recogniser emits when it was handed silence, music or room noise
 * instead of speech.
 *
 * This is the failure that will NOT look the same when the stand-in is replaced.
 * Gemini, asked to transcribe nothing, returns the sentinel it was told to and stt.ts
 * maps that to an empty string. Whisper does not: it is trained largely on subtitle
 * tracks, so when the audio carries no speech it falls back on the furniture of that
 * training data - a sign-off, a plea to subscribe, a bracketed sound label, a credit
 * line - and it emits it fluently and confidently. Those are real words in a real
 * sentence, so every other check here waves them through, and the agent would answer
 * a question nobody asked.
 *
 * Caught in code rather than left to the model, because the model cannot tell "thanks
 * for watching" typed by a person from the same words invented by an ASR, and because
 * this has to behave identically on every model this ever runs on.
 */
const ASR_ARTEFACT = new RegExp([
  // Bracketed or bare sound labels, when that is the whole of it.
  String.raw`^\W*[\[\(]?\s*(?:music|applause|silence|inaudible|laughter|blank[ _]audio|background noise|no speech|foreign|sound effects?)\s*[\]\)]?\W*$`,
  // Subtitle-track furniture. Nobody asks a restaurant website any of this.
  String.raw`thank(?:s| you)(?: (?:so|very) much)? for watching`,
  String.raw`thanks for (?:listening|joining)`,
  String.raw`(?:please )?(?:subscribe|like and subscribe)`,
  String.raw`subscribe to (?:my|our|the) channel`,
  String.raw`(?:subtitles?|captions?|transcri(?:bed|ption))\s+(?:by|from)\b`,
  String.raw`amara\.org`,
  String.raw`see you (?:in the )?next (?:video|time)`,
].join('|'), 'i');

/**
 * An ASR that loses its place repeats itself - the same word, or the same short phrase,
 * until the decoder is reset. People do not do this, so the threshold can be set where
 * it catches the failure without catching anyone's question.
 *
 * Both tests need a reasonable number of words before they mean anything, because
 * "is it per outlet or per outlet group" is a real question with a real repetition in
 * it, and three words in a row is a sentence, not a loop.
 */
function loops(tokens: string[]): boolean {
  if (tokens.length < 6) return false;

  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  if (Math.max(...counts.values()) / tokens.length >= 0.5) return true;

  let run = 1;
  for (let i = 1; i < tokens.length; i++) {
    run = tokens[i] === tokens[i - 1] ? run + 1 : 1;
    if (run >= 4) return true;
  }
  return false;
}

export type Triage =
  | { kind: 'ok' }
  | { kind: 'abuse'; reply: string }
  | { kind: 'gibberish'; reply: string }
  /** Word-shaped, but the recogniser produced it from something that was not speech. */
  | { kind: 'misheard'; reply: string }
  | { kind: 'empty'; reply: string };

export const REPLIES = {
  /**
   * No lecture and no refusal theatre. It states what the agent is for, leaves the door
   * open, and offers a person - which is what someone swearing at a website usually
   * wanted in the first place.
   */
  abuse:
    'I would rather keep this useful. Ask me anything about EatLabs, or message us on WhatsApp on +91 80 4000 1200 and a person will help.',
  gibberish: 'I did not catch that. Could you say it again?',
  /** Spoken, and nothing usable came through. Says what to change, not just that it failed. */
  misheard: 'I did not catch that. Could you say it again, a little closer to the microphone?',
  empty: 'Ask me anything about EatLabs.',
} as const;

export function triage(question: string, source: Source = 'text'): Triage {
  const trimmed = question.trim();
  if (!trimmed) return { kind: 'empty', reply: REPLIES.empty };

  const forAbuse = deleet(joinSpacedLetters(trimmed));
  if (ABUSE.test(forAbuse)) return { kind: 'abuse', reply: REPLIES.abuse };

  // Keep the complaint check after abuse: "this is useless" is answered, "this is
  // f***ing useless" is not. Someone saying the product is rubbish is still asking
  // something, and deserves the passage rather than a canned line.
  if (COMPLAINT_WORDS.test(trimmed)) return { kind: 'ok' };

  // Only for audio. Typed, these are a person saying an odd thing and they get an
  // ordinary answer; transcribed, they are the recogniser talking to itself.
  if (source === 'voice' && ASR_ARTEFACT.test(trimmed)) {
    return { kind: 'misheard', reply: REPLIES.misheard };
  }

  const tokens = trimmed.toLowerCase().match(/[a-zऀ-ॿಀ-೿]+/g) ?? [];

  // Nothing alphabetic at all: "?????", "123456", an emoji on its own.
  if (!tokens.length) {
    return source === 'voice'
      ? { kind: 'misheard', reply: REPLIES.misheard }
      : { kind: 'gibberish', reply: REPLIES.gibberish };
  }

  // A decoder stuck in a loop, which is a transcription failure however real the words
  // are. Checked on all scripts, because the loop does not care which one it is in.
  if (loops(tokens)) {
    return source === 'voice'
      ? { kind: 'misheard', reply: REPLIES.misheard }
      : { kind: 'gibberish', reply: REPLIES.gibberish };
  }

  // Devanagari and Kannada are not judged by a Latin-script vowel rule, so anything in
  // those scripts passes. Hindi and Kannada are supported languages; silently calling
  // them gibberish would be the worst version of this check.
  const latin = tokens.filter((t) => /^[a-z]+$/.test(t));
  if (!latin.length) return { kind: 'ok' };

  const typed = latin.filter(looksTyped).length;
  if (typed / latin.length < 0.5) {
    return source === 'voice'
      ? { kind: 'misheard', reply: REPLIES.misheard }
      : { kind: 'gibberish', reply: REPLIES.gibberish };
  }

  return { kind: 'ok' };
}
