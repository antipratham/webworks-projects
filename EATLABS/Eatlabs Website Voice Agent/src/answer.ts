/**
 * STAGE 2 - Answer, then check the answer before anyone hears it.
 *
 * The checks below are the reason this file exists. They are not belt-and-braces on a
 * well-behaved model; they are the enforcement layer that AGENT-INSTRUCTIONS.md §3
 * promises, and they run on every reply whatever the prompt said.
 *
 * Each check fails CLOSED - to a sentence that is true, useful and hands over to a
 * person. An agent that says "let me get someone to confirm that" has cost nothing.
 * An agent that says "₹25,000" on a sales call has cost a deal and some trust.
 *
 * Two ways in, one set of checks:
 *   ask()       - the whole reply, checked, then returned.
 *   askStream() - a sentence at a time, each one checked before it is released, so the
 *                 console can start speaking before the model has finished. See the
 *                 note above askStream for what that costs.
 *
 * Two prompts, two gates, one router. `plan()` below decides which of the two the
 * question gets, and from that point the code is identical - the same loop, the same
 * release rules, the same fail-closed handover. Nothing can answer without a gate
 * because there is no path that does not go through the Route it returns.
 */

import { build } from './prompt.ts';
import { buildOpen, type OpenMode } from './open.ts';
import { triage, type Source } from './triage.ts';
import type { LlmClient } from './llm.ts';
import type { Embedder } from './embed.ts';
import { isGreeting, type Index, type Scored } from './retrieve.ts';
import { contextualise, gateContext, renderHistory, type Turn } from './conversation.ts';

export const HANDOVER =
  'I do not want to guess at that. Message us on WhatsApp on +91 80 4000 1200 and a person will confirm it, 9 am to 9 pm.';

export interface AskOptions {
  lang?: string;
  k?: number;
  clock?: Date;
  /** When present and the KB has vectors, search reads the question, not its keywords. */
  embedder?: Embedder;
  /**
   * Typed, or transcribed from a microphone. Only triage reads it, and only to decide
   * which failures are plausible and how to word the reply. Defaults to text, so a
   * caller that does not know is treated as the stricter case.
   */
  source?: Source;
  /**
   * The turns before this one, oldest first, straight from the server's own store.
   * Never from a request body - see the note at the top of conversation.ts for why
   * that distinction is load-bearing rather than stylistic.
   *
   * Absent or empty means a first question, and every path below behaves exactly as it
   * did before conversations existed.
   */
  history?: Turn[];
}

export interface Passage {
  id: string;
  heading: string;
  score: number;
  sensitivity: string;
  provenance: string;
  sources: string[];
}

/**
 * Where the answer came from. Worth returning rather than inferring from an empty
 * passage list, because "the knowledge base answered this" and "the model answered this
 * with no source" are different enough that the console says so out loud.
 */
export type Mode =
  /** Written from retrieved passages, gated against them. */
  | 'grounded'
  /** Written with no passages at all, gated against carrying any figure. */
  | 'open'
  /** Not written by a model: abuse, gibberish, an empty box. */
  | 'fixed';

/**
 * What the server needs in order to remember this turn, and the visitor does not need
 * at all: the full passage text the gate ran against.
 *
 * It travels back with the answer rather than being recomputed, because recomputing it
 * would mean a second retrieval that could return something different and quietly gate
 * the next turn against passages this one never saw. serve.ts strips it before the
 * reply goes out - it is several kilobytes of text the page has no use for.
 */
export interface TurnMemo {
  context: string;
  /** The query actually sent to the index, widened if this was a follow-up. */
  searched: string;
}

export interface Answer {
  text: string;
  passages: Passage[];
  mode: Mode;
  /** Which check rejected the model's reply, if any. Shown in the test console. */
  rejected?: string;
  /** What the model actually said, when a check rejected it. For debugging only. */
  rejectedText?: string;
  model: string;
  ms: number;
  /** Server-side only. Removed in serve.ts before this is serialised to the page. */
  memo?: TurnMemo;
}

/** Any ₹ or Rs figure, however written: ₹35,000 · Rs 2,000 · ₹0 */
const MONEY = /(?:₹|\bRs\.?\s?|\bINR\s?)\s?([\d,]+(?:\.\d+)?)/gi;
/** A leftover template blank on the website: [SUPPORT HOURS], [REGISTERED OFFICE ADDRESS]. */
const PLACEHOLDER = /\[[A-Z][A-Z \-_]{3,}\]/;

const digits = (s: string) => s.replace(/[^\d]/g, '');

/**
 * Every money figure in the reply must appear in a passage the model was given.
 *
 * This will occasionally reject a correct answer - a model that writes "35000" where
 * the passage says "35,000" is right, and the digit comparison handles that, but one
 * that totals two figures is wrong in a way we cannot distinguish from arithmetic we
 * would have wanted. We take the false positive.
 */
function inventedMoney(reply: string, context: string): string | null {
  const allowed = new Set<string>();
  for (const m of context.matchAll(MONEY)) allowed.add(digits(m[1]));
  for (const m of reply.matchAll(MONEY)) {
    const value = digits(m[1]);
    if (!allowed.has(value)) return m[0].trim();
  }
  return null;
}

/** Percentages are the other number that sells: no-show rates, commission, uptime. */
function inventedPercent(reply: string, context: string): string | null {
  const allowed = new Set((context.match(/\d+(?:\.\d+)?\s?%/g) ?? []).map(digits));
  for (const found of reply.match(/\d+(?:\.\d+)?\s?%/g) ?? []) {
    if (!allowed.has(digits(found))) return found;
  }
  return null;
}

/**
 * The single gate. Both entry points call this and nothing else decides what may be
 * said, so there is no way to add a path that speaks ungated text by forgetting a check.
 */
export function checkReply(reply: string, context: string): string | null {
  const money = inventedMoney(reply, context);
  if (money) return `quoted ${money}, which is in no passage`;

  const percent = inventedPercent(reply, context);
  if (percent) return `quoted ${percent}, which is in no passage`;

  if (PLACEHOLDER.test(reply)) return 'read back an unfilled placeholder from the website';

  if (!reply || reply.trim().length < 2) return 'empty reply';

  return null;
}

/** The handover number, which is the one string of digits an open reply may carry. */
const CONTACT = /\+?\s?91[\s-]?80[\s-]?4000[\s-]?1200/g;
/** A link, invented or otherwise. Spoken aloud it is noise, and it is never needed. */
const LINK = /\b(?:https?:\/\/|www\.)\S+/i;

/**
 * The gate for a reply written with no passages behind it.
 *
 * One rule carries almost all of this: no digits. Not "no prices" or "no claims about
 * EatLabs" - those need the gate to understand the sentence, and it cannot. Every fact
 * about this product that would hurt to get wrong is a figure: a price, a share, a
 * notice period, a retention window, an uptime number, a count of outlets. A reply that
 * contains no figure cannot carry one, whatever the model believed it knew, and the
 * prompt asks for small numbers as words so the model is not fighting the rule.
 *
 * What it costs, stated rather than hidden: the agent cannot answer "what year did the
 * Second World War end" or "how many continents are there" - those hand over instead.
 * That is a fair trade for a rule that needs no judgement and cannot be argued with.
 */
export function checkOpen(reply: string): string | null {
  const base = checkReply(reply, '');     // no context: every figure is unsourced here
  if (base) return base;

  const digits = reply.replace(CONTACT, '');
  const found = digits.match(/\d[\d,.]*/);
  if (found) return `used the figure ${found[0]} with no passage behind it`;

  if (LINK.test(reply)) return 'read out a link';

  return null;
}

/** Markdown and bullets survive a surprising amount of prompting. Strip, don't reject. */
function forSpeech(text: string): string {
  return text
    .replace(/[*_`#]+/g, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function describe(hits: Scored[]): Passage[] {
  return hits.map((h) => ({
    id: h.chunk.id,
    heading: h.chunk.heading,
    score: Number(h.score.toFixed(2)),
    sensitivity: h.chunk.sensitivity,
    provenance: h.chunk.provenance,
    sources: h.chunk.source_urls,
  }));
}

/** What the gates are allowed to consider true: the passages, and nothing else. */
function groundTruth(hits: Scored[]): string {
  return hits.map((h) => `${h.chunk.heading} ${h.chunk.spoken ?? ''} ${h.chunk.text}`).join('\n');
}

/**
 * One question, one route: the prompt it gets and the gate its reply is judged by,
 * chosen together so neither can be used with the wrong one.
 */
interface Route {
  mode: Mode;
  hits: Scored[];
  system: string;
  gate(reply: string): string | null;
  /**
   * What was actually searched for. Equal to the question unless this was a follow-up,
   * in which case conversation.ts widened it. Returned to the console so a surprising
   * set of passages can be explained rather than guessed at.
   */
  searched: string;
}

/**
 * Which of the two prompts this question gets.
 *
 * The decision is made by retrieval, not by the model and not by a classifier: if the
 * knowledge base holds something on it, the grounded prompt answers from that and may
 * say nothing else. If the knowledge base holds nothing, there is nothing to be
 * faithful to, and insisting on a handover only makes the agent useless at small talk.
 *
 * Because of the lexical veto in retrieve.ts, "nothing" here is a strong signal rather
 * than a weak one: it means the question shares no vocabulary with anything EatLabs
 * publishes. A question about the product that is merely worded oddly still retrieves
 * something and still takes the grounded route.
 */
async function plan(index: Index, question: string, options: AskOptions): Promise<Route> {
  const turns = options.history ?? [];
  const history = renderHistory(turns);

  const open = (mode: OpenMode): Route => ({
    mode: 'open',
    hits: [],
    system: buildOpen(mode, { lang: options.lang, clock: options.clock, history }),
    gate: checkOpen,
    searched: question,
  });

  // Checked here as well as in retrieve.ts, because a greeting is not a search that
  // failed - it is an opening, and handing it the "what EatLabs is" passage answers a
  // question nobody asked. Hello deserves hello.
  //
  // Still checked against the question as typed, never the widened one: "thanks" after
  // a long exchange is a greeting, and carrying the last topic into it would turn a
  // goodbye into one more answer about pricing.
  if (isGreeting(question)) return open('greeting');

  // The only place the widened query is used. Everything downstream - the prompt, the
  // gate, the transcript, what the visitor is shown - sees the question as they asked
  // it, because the widening is a search trick and not a reinterpretation of them.
  const searched = contextualise(question, turns);
  const hits = await index.searchHybrid(searched, options.k ?? 5, options.embedder);
  if (!hits.length) return open('unrelated');

  const context = gateContext(groundTruth(hits), turns);
  return {
    mode: 'grounded',
    hits,
    system: build(hits, { lang: options.lang, clock: options.clock, history }),
    gate: (reply) => checkReply(reply, context),
    searched,
  };
}

export async function ask(
  index: Index,
  llm: LlmClient,
  question: string,
  options: AskOptions = {},
): Promise<Answer> {
  const started = Date.now();
  const ms = () => Date.now() - started;

  // Abuse, gibberish and an empty box never reach the index or the model.
  const first = triage(question, options.source);
  if (first.kind !== 'ok') {
    return { text: first.reply, passages: [], mode: 'fixed', rejected: first.kind, model: llm.label, ms: ms() };
  }

  const route = await plan(index, question, options);
  const base = {
    passages: describe(route.hits),
    mode: route.mode,
    model: llm.label,
    memo: memoFor(route),
  };

  let raw: string;
  try {
    raw = await llm.complete({ system: route.system, user: question, maxTokens: 220 });
  } catch (err) {
    return { ...base, text: HANDOVER, rejected: `model unreachable: ${(err as Error).message}`, ms: ms() };
  }

  const reply = forSpeech(raw);
  const rejected = route.gate(reply);
  return {
    ...base,
    text: rejected ? HANDOVER : reply,
    rejected: rejected ?? undefined,
    rejectedText: rejected ? reply : undefined,
    ms: ms(),
  };
}

/**
 * An open reply has no passages, so it contributes no quotable figures to a later
 * turn's gate - `groundTruth([])` is empty and that is correct, not an oversight. The
 * turn is still worth remembering: "hi" then "what do you do?" needs the first line in
 * the transcript even though it grounds nothing.
 */
function memoFor(route: Route): TurnMemo {
  return { context: groundTruth(route.hits), searched: route.searched };
}

export type StreamEvent =
  | { type: 'passages'; passages: Passage[]; mode: Mode; model: string }
  /** A complete sentence that has passed the gate. Safe to display and to speak. */
  | { type: 'sentence'; text: string }
  /**
   * Both terminal events carry `memo`, and both are worth recording: a blocked turn
   * still happened, and leaving it out of the transcript makes the next question's
   * pronouns point at the wrong thing. serve.ts strips `memo` before writing the event
   * to the wire. See TurnMemo.
   */
  | { type: 'done'; text: string; ms: number; memo?: TurnMemo }
  | { type: 'blocked'; text: string; rejected: string; rejectedText?: string; ms: number; memo?: TurnMemo };

/** Release boundary. A clause end is close enough to a breath to be worth speaking. */
const SENTENCE_END = /[.!?](\s|$)|[;:]\s/g;

/**
 * A full stop that is not the end of anything. "WebWorks Co." and "9 a.m." would each be
 * released as their own utterance otherwise, and the answer comes out of the speaker in
 * pieces - "WebWorks Co." ... "is the company that builds EatLabs."
 */
const ABBREVIATION = /\b(?:Co|Ltd|Pvt|Inc|Corp|No|Mr|Mrs|Ms|Dr|Prof|Rs|approx|etc|vs|e\.g|i\.e|a\.m|p\.m)\.$/i;

/** Below this, a fragment is not worth speaking on its own; keep gathering. */
const MIN_RELEASE = 24;

/**
 * The end of the first piece worth releasing, or -1 to keep buffering.
 *
 * `final` is set once the model has stopped, when whatever is left has to go out however
 * short it is - otherwise the last few words of every answer would never be spoken.
 */
function releasePoint(buffer: string, final: boolean): number {
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(buffer); m; m = SENTENCE_END.exec(buffer)) {
    const cut = m.index + m[0].length;
    const piece = buffer.slice(0, cut);
    const trimmed = piece.trimEnd();
    if (ABBREVIATION.test(trimmed)) continue;
    // A decimal inside a number: "99.98" must not break after the point.
    if (/\d\.$/.test(trimmed) && /^\s*\d/.test(buffer.slice(cut))) continue;
    if (piece.trim().length < MIN_RELEASE) continue;
    return cut;
  }
  return final && buffer.trim() ? buffer.length : -1;
}

/**
 * The same answer, released a sentence at a time.
 *
 * Why sentences and not tokens: the gate needs a whole figure to judge it. "₹35" and
 * ",000" arrive as separate tokens, and a gate that ran per token would either block the
 * correct price or wave the wrong one through. Buffering to a sentence boundary means
 * every figure is complete before it is weighed, and costs one sentence of latency rather
 * than the whole reply.
 *
 * What this trades away, stated plainly: a sentence that has been released cannot be
 * recalled. If sentence three invents a price, sentences one and two have already been
 * displayed and may already have been spoken. They were each gated and clean, so nothing
 * false has been said - but the answer stops mid-flow and switches to the handover, which
 * is more jarring than a reply that was checked whole. That is the price of audio that
 * starts before the model has finished, and it is why ask() is still the default.
 */
export async function* askStream(
  index: Index,
  llm: LlmClient,
  question: string,
  options: AskOptions = {},
): AsyncIterable<StreamEvent> {
  const started = Date.now();
  const ms = () => Date.now() - started;

  const first = triage(question, options.source);
  if (first.kind !== 'ok') {
    yield { type: 'passages', passages: [], mode: 'fixed', model: llm.label };
    // A fixed reply is a complete answer, so it is spoken as one sentence and ends the
    // stream. It goes out as `blocked` because nothing was generated or gated.
    yield {
      type: 'blocked', text: first.reply, rejected: first.kind, ms: ms(),
      memo: { context: '', searched: question },
    };
    return;
  }

  const route = await plan(index, question, options);
  const memo = memoFor(route);

  yield { type: 'passages', passages: describe(route.hits), mode: route.mode, model: llm.label };

  const released: string[] = [];
  let buffer = '';

  const flush = (piece: string): StreamEvent | null => {
    const sentence = forSpeech(piece);
    if (!sentence) return null;
    const rejected = route.gate(sentence);
    if (rejected) {
      return {
        type: 'blocked',
        text: released.length ? `${released.join(' ')} ${HANDOVER}` : HANDOVER,
        rejected,
        rejectedText: sentence,
        ms: ms(),
        memo,
      };
    }
    released.push(sentence);
    return { type: 'sentence', text: sentence };
  };

  try {
    // A client without stream() still works; it just arrives in one piece at the end.
    const source = llm.stream
      ? llm.stream({ system: route.system, user: question, maxTokens: 220 })
      : [await llm.complete({ system: route.system, user: question, maxTokens: 220 })];

    for await (const delta of source) {
      buffer += delta;
      for (let cut = releasePoint(buffer, false); cut > 0; cut = releasePoint(buffer, false)) {
        const piece = buffer.slice(0, cut);
        buffer = buffer.slice(cut);
        const event = flush(piece);
        if (event?.type === 'blocked') {
          yield event;
          return;
        }
        if (event) yield event;
      }
    }
  } catch (err) {
    yield {
      type: 'blocked',
      text: HANDOVER,
      rejected: `model unreachable: ${(err as Error).message}`,
      ms: ms(),
      memo,
    };
    return;
  }

  // Whatever is left over had no terminator - a reply that ends without punctuation.
  const tail = flush(buffer);
  if (tail?.type === 'blocked') {
    yield tail;
    return;
  }
  if (tail) yield tail;

  const text = released.join(' ').trim();
  if (!text) {
    yield { type: 'blocked', text: HANDOVER, rejected: 'empty reply', ms: ms(), memo };
    return;
  }
  yield { type: 'done', text, ms: ms(), memo };
}
