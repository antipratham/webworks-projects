/**
 * STAGE 0 - What was said before this question.
 *
 * Without this every question is the first one. "What does Growth cost?" answers fine
 * and "is that with GST?" retrieves nothing, because `that` and `GST` share no useful
 * vocabulary with the pricing chunk and BM25 has no idea what `that` refers to. A
 * visitor cannot ask a second question about the same thing, which is most of how
 * people actually talk - and all of how they talk out loud.
 *
 * Three things happen here, and they are separate on purpose:
 *
 *   1. `Conversations` keeps the turns, server-side, keyed by an opaque id.
 *   2. `contextualise()` widens the RETRIEVAL query of a follow-up, so the index is
 *      searched for the thing being referred to rather than for the word "that".
 *   3. `recent()` hands answer.ts the turns to put in the prompt and the context those
 *      turns were gated against.
 *
 * WHY THE SERVER HOLDS THE HISTORY, and not the page.
 *
 * It would be less code to let the console post its own transcript with each question.
 * It would also hand the gate to whoever is typing. answer.ts allows a figure out only
 * if it appears in the context the model was given, and a follow-up's context includes
 * the earlier turns (see `gateContext`) - so a page that could invent a prior turn
 * saying "Growth is ₹9,000 a month" could then ask "what was that price again?" and the
 * gate would pass it, because the figure really is in the context. The agent would
 * quote ₹9,000 to a real buyer, in its own voice, with the gate satisfied.
 *
 * So the page gets an id and nothing else. Everything the gate later trusts was put
 * here by this server, after passing the gate itself. serve.ts never reads a turn from
 * a request body, and there is no parameter that would let it.
 */

import { FUNCTION_WORDS, tokenize } from './retrieve.ts';

export interface Turn {
  /** What the visitor actually asked, as they said it. */
  question: string;
  /** What was released to them - gated text, never the rejected draft. */
  answer: string;
  /**
   * The passages this turn was answered from, already flattened by answer.ts. Kept so a
   * later turn's gate can still recognise a figure that was legitimately said earlier.
   */
  context: string;
  at: number;
}

export interface ConversationOptions {
  /**
   * How many turns to keep. Eight is roughly four exchanges each way - long enough for
   * "what about Enterprise?" three questions later, short enough that the prompt does
   * not crowd out the passages, which are what the answer must actually come from.
   */
  maxTurns?: number;
  /** How long a silent conversation is kept. A browser tab left open is not a session. */
  ttlMs?: number;
  /** A hard ceiling on live conversations, so a crawler cannot grow the map forever. */
  maxConversations?: number;
  clock?: () => number;
}

const DEFAULTS = {
  maxTurns: 8,
  ttlMs: 2 * 60 * 60 * 1000,
  maxConversations: 500,
};

/**
 * Words that stand in for the thing just discussed. They are also function words, so
 * they are stripped before a question is weighed below - "is that with GST?" is one
 * content word, `gst`, and that is exactly why it cannot be searched for on its own.
 */
const REFERENTIAL = new Set([
  'it', 'its', 'that', 'this', 'those', 'these', 'they', 'them', 'their', 'there',
  'he', 'she', 'him', 'her', 'one', 'ones', 'same', 'above', 'previous', 'last',
  'earlier', 'before', 'another', 'other',
]);

/**
 * How many content words a question needs before it is searched as it stands.
 *
 * Two is the whole rule, and it is doing more work than it looks. "What documents will
 * I need?" has `documents` and `need` - enough to find the right chunk unaided, and
 * widening it actively buries that chunk under whatever came before. "Is that with
 * GST?" has only `gst`, which matches the invoicing section, the plans table and half
 * the legal pages equally; the thing that disambiguates it was said a turn ago.
 */
const STANDS_ALONE = 2;

/** A ceiling on carried words, so the visitor's own terms are never outnumbered. */
const CARRY_LIMIT = 6;

/** The words in a question that are worth searching for: no filler, no pronouns. */
function contentWords(question: string): string[] {
  return tokenize(question).filter((t) => !FUNCTION_WORDS.has(t) && !REFERENTIAL.has(t));
}

export class Conversations {
  private readonly turns = new Map<string, Turn[]>();
  private readonly seen = new Map<string, number>();
  private readonly options: Required<Omit<ConversationOptions, 'clock'>> & { clock: () => number };

  constructor(options: ConversationOptions = {}) {
    this.options = {
      maxTurns: options.maxTurns ?? DEFAULTS.maxTurns,
      ttlMs: options.ttlMs ?? DEFAULTS.ttlMs,
      maxConversations: options.maxConversations ?? DEFAULTS.maxConversations,
      clock: options.clock ?? (() => Date.now()),
    };
  }

  /**
   * Hand back the id to use. An unknown or expired id is not an error - it starts a new
   * conversation under a new id, and the page is told which. Failing the question
   * because a tab was left open overnight would be the wrong call.
   */
  open(id?: string | null): string {
    if (id && this.turns.has(id) && !this.expired(id)) {
      this.seen.set(id, this.options.clock());
      return id;
    }
    return this.start();
  }

  private start(): string {
    this.sweep();
    const id = newId();
    this.turns.set(id, []);
    this.seen.set(id, this.options.clock());
    return id;
  }

  private expired(id: string): boolean {
    const last = this.seen.get(id);
    if (last === undefined) return true;
    if (this.options.clock() - last <= this.options.ttlMs) return false;
    this.turns.delete(id);
    this.seen.delete(id);
    return true;
  }

  /** Drop what has timed out, then the oldest, until the map is within its ceiling. */
  private sweep(): void {
    for (const id of [...this.seen.keys()]) this.expired(id);
    if (this.seen.size < this.options.maxConversations) return;
    const oldestFirst = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
    for (const [id] of oldestFirst.slice(0, this.seen.size - this.options.maxConversations + 1)) {
      this.turns.delete(id);
      this.seen.delete(id);
    }
  }

  /** The turns before this question, oldest first. Empty for a new conversation. */
  recent(id: string): Turn[] {
    if (!this.turns.has(id) || this.expired(id)) return [];
    return this.turns.get(id)!;
  }

  record(id: string, turn: Omit<Turn, 'at'>): void {
    if (!this.turns.has(id) || this.expired(id)) return;
    const list = this.turns.get(id)!;
    list.push({ ...turn, at: this.options.clock() });
    // Keep the newest. An old turn falling out is the point of a window, not a loss.
    if (list.length > this.options.maxTurns) list.splice(0, list.length - this.options.maxTurns);
    this.seen.set(id, this.options.clock());
  }

  /** Start again in the same tab - "ask about something else". */
  clear(id: string): void {
    if (this.turns.has(id)) this.turns.set(id, []);
  }

  get size(): number {
    return this.turns.size;
  }
}

/** Opaque, unguessable, and not derived from anything about the visitor. */
function newId(): string {
  return `c_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * Does this question need the previous one to be searchable at all?
 *
 * Note what is NOT asked here: whether it contains a pronoun. An early version widened
 * on any `it` or `that` and it was wrong in both directions. "How do I sign up for it?"
 * and "What documents will I need?" are both plainly about the thing just discussed,
 * but both carry enough of their own vocabulary to find the right chunk, and widening
 * them dragged the previous topic's words in to outvote their own. The question is only
 * ever whether there is enough left to search for once the filler and the pronouns are
 * gone.
 */
export function isFollowUp(question: string, turns: Turn[]): boolean {
  if (!turns.length) return false;
  return contentWords(question).length < STANDS_ALONE;
}

/**
 * The string to SEARCH with. Not the string to show anyone, and not what the model is
 * asked - it is only ever handed to the index.
 *
 * The visitor's own words come first and are left exactly as typed. Appended to them
 * are the content words of the last question that named a subject - the vocabulary
 * "that" was standing in for, and nothing else.
 *
 * Only questions are carried, never answers or passage headings, and only when the
 * question in hand cannot be searched on its own. Both limits exist for the same
 * reason: anything derived from a previous SEARCH can feed that search's result back
 * into the next query, and a conversation is long enough for that to compound.
 */
export function contextualise(question: string, turns: Turn[]): string {
  if (!isFollowUp(question, turns)) return question;

  // Walk back to the last turn that actually named a subject. Two pronoun questions in
  // a row ("what does Growth cost?" / "is that with GST?" / "and that?") would otherwise
  // carry nothing, because the turn immediately before was itself only pronouns.
  let carried: string[] = [];
  for (let i = turns.length - 1; i >= 0 && !carried.length; i--) {
    carried = contentWords(turns[i].question);
  }
  if (!carried.length) return question;

  // Deduplicated, capped, and anything the visitor already typed is dropped: repeating
  // a term here would double its weight against the words they actually chose.
  //
  // Headings of the passages that answered the previous turn are deliberately NOT
  // carried, though they were in the first version of this and they look like free
  // topic vocabulary. They are not free: those headings are the OUTPUT of a search that
  // may itself have been widened, so carrying them feeds each turn's result back into
  // the next turn's query. Five questions into a conversation about pricing, every
  // query had collected enough of the plans table that "what documents will I need?"
  // returned the plans table. Questions are written by the visitor and cannot loop.
  const already = new Set(tokenize(question));
  const extra = [...new Set(carried)].filter((t) => !already.has(t)).slice(0, CARRY_LIMIT);
  return extra.length ? `${question} ${extra.join(' ')}` : question;
}

/**
 * What the model is told was said before. Trimmed hard: the passages are the answer's
 * source and this is only here so pronouns resolve and the agent does not re-introduce
 * itself every turn.
 */
export function renderHistory(turns: Turn[], limit = 4): string {
  const recent = turns.slice(-limit);
  if (!recent.length) return '';
  return recent.map((t) => `Them: ${t.question}\nYou: ${t.answer}`).join('\n');
}

/**
 * The context a follow-up's reply is gated against: this turn's passages, plus those of
 * the turns still in the window.
 *
 * This is a real widening of the guarantee in answer.ts and worth being honest about.
 * Strictly, every figure spoken should appear in a passage retrieved for THIS question.
 * But "Growth is ₹35,000 a month" / "is that plus GST?" retrieves the GST wording and
 * not always the plans table, and an agent that answers its own previous sentence with
 * "I do not want to guess at that" is broken in a way visitors notice immediately.
 *
 * What keeps it sound: every earlier context in this window was itself retrieved from
 * the index for a real question and its reply already passed the gate. The set of
 * quotable figures is still closed over what the knowledge base published - it is just
 * closed over the conversation rather than the single turn. Nothing a visitor types can
 * add to it, which is the property that actually matters, and the reason the history
 * lives on this side of the wire.
 */
export function gateContext(current: string, turns: Turn[]): string {
  if (!turns.length) return current;
  return [current, ...turns.map((t) => t.context)].join('\n');
}
