/**
 * STAGE 1 - Find the passages. Pure code, no model.
 *
 * BM25 over the chunks in kb.jsonl, plus an exact-phrase boost. No embeddings:
 * menu-ai ships with no runtime dependencies and there is no embedding model on the
 * box, and at this size lexical retrieval is not the weak link. The words people use
 * for this product are the words the site uses - "Petpooja", "DPDP", "35,000",
 * "Razorpay" - and those are exactly the terms a vector search blurs.
 *
 * If an embedding endpoint ever runs beside vLLM, add it as a second scorer and blend.
 * The interface here does not have to change.
 *
 * One thing is enforced here rather than asked of the model, because a prompt cannot be
 * trusted to hold it (see AGENT-INSTRUCTIONS.md §3): `visibility: agent-only` chunks are
 * never returned as passages. The guardrails document is rules for the agent, not source
 * material, and an agent that can retrieve "never say X" can read it aloud to the person
 * asking about X.
 *
 * There is no audience routing. This is one general assistant answering anyone who opens
 * the website, and every chunk that is not agent-only is in scope for every question.
 */

import { readFileSync, existsSync } from 'node:fs';
import { similarity, type Embedder } from './embed.ts';

/** How deep each ranking is taken before fusing. Deeper than k, so the two can disagree. */
const FUSE_DEPTH = 20;

/**
 * A weak second filter, not the safety net it looks like.
 *
 * Measured on multilingual-e5-small over this knowledge base: real questions top out
 * between 0.813 and 0.944, and plainly off-topic ones between 0.739 and 0.833. Those
 * ranges OVERLAP - "best biryani recipe" scores 0.819, above the weakest real question
 * at 0.813 - so no threshold separates them. Other models spread differently; bge-m3
 * separates better, but the number below is worth re-measuring, not trusting.
 *
 * Because a floor cannot be relied on, it is not what keeps the agent from answering
 * questions it was not asked. `lexicalVeto` below is.
 */
const DENSE_FLOOR = Number(process.env.DENSE_FLOOR ?? 0.3);

/** Latin letters, i.e. the script BM25's vocabulary is actually written in. */
const LATIN = /[a-z]/i;

/**
 * Hello, in the three languages this agent answers in, plus the romanised spellings
 * people actually type on a phone keyboard.
 *
 * This has to be script-aware rather than left to the filler list, because `tokenize`
 * keeps only `[a-z0-9]`. A Devanagari or Kannada greeting produces no tokens at all, so
 * it never reaches the filler test, skips the opening fallback and goes to the dense
 * ranking - where "नमस्ते" was answered with the sub-processor list and "ನಮಸ್ಕಾರ" with the
 * data-deletion policy. Nearest neighbour is not the same thing as an answer.
 */
const GREETINGS = new Set([
  'hi', 'hii', 'hiii', 'hello', 'helo', 'hey', 'heya', 'hiya', 'yo', 'howdy',
  'greetings', 'morning', 'afternoon', 'evening', 'thanks', 'thankyou', 'ty',
  'bye', 'goodbye', 'ok', 'okay', 'hmm',
  'namaste', 'namaskar', 'namaskara', 'namaskaara', 'vanakkam', 'salaam', 'adaab',
  'shukriya', 'dhanyavad', 'dhanyavaad', 'dhanyavada',
  'नमस्ते', 'नमस्कार', 'हैलो', 'हेलो', 'हाय', 'सुप्रभात', 'धन्यवाद', 'शुक्रिया', 'अलविदा',
  'ನಮಸ್ಕಾರ', 'ನಮಸ್ತೆ', 'ಹಲೋ', 'ಹಾಯ್', 'ಧನ್ಯವಾದ', 'ಧನ್ಯವಾದಗಳು', 'ಶುಭೋದಯ',
]);

/** Words in any of the three scripts, unlike `tokenize`, which only sees Latin. */
const ANY_SCRIPT = /[a-z0-9ऀ-ॿಀ-೿]+/gi;

/**
 * A greeting and nothing else - in any of the three languages. Such a message has no
 * question in it to retrieve against, so it gets the opening answer rather than whatever
 * chunk happens to sit nearest in vector space.
 */
export function isGreeting(query: string): boolean {
  const words = query.toLowerCase().match(ANY_SCRIPT) ?? [];
  if (!words.length) return false;
  return words.every((w) => GREETINGS.has(w) || FILLER_LATIN.has(w));
}

/** The handful of Latin words that may sit beside a greeting: "hi there", "hello again". */
const FILLER_LATIN = new Set(['there', 'again', 'good', 'very', 'so', 'a', 'the', 'ji', 'sir', 'madam']);

/** Standard RRF damping. Large enough that rank 1 does not simply win outright. */
const RRF_K = 60;

/**
 * Reciprocal rank fusion. Each list contributes 1/(RRF_K + rank), so agreement between
 * the two methods matters more than either one's confidence - which is the point, since
 * neither method's score means anything to the other.
 */
function fuse(lexical: Scored[], dense: Scored[], k: number): Scored[] {
  const points = new Map<string, { chunk: Chunk; score: number }>();
  for (const list of [lexical, dense]) {
    list.forEach((hit, i) => {
      const seen = points.get(hit.chunk.id);
      const add = 1 / (RRF_K + i + 1);
      if (seen) seen.score += add;
      else points.set(hit.chunk.id, { chunk: hit.chunk, score: add });
    });
  }
  return [...points.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

export interface Chunk {
  id: string;
  doc_id: string;
  heading: string;
  topic: string;
  visibility: string;
  sensitivity: string;
  provenance: string;
  spoken: string | null;
  text: string;
  /** Marked by `opening_section:` in the KB. The answer to "what is this?". */
  opening?: boolean;
  source_urls: string[];
  scraped: string;
}

export interface Scored {
  chunk: Chunk;
  score: number;
}

const K1 = 1.2;
const B = 0.75;

/**
 * The gap between what a person asks and what the website wrote.
 *
 * This is lexical retrieval's one real weakness and it shows up immediately: "how much
 * does it cost" shares no content word with a pricing section that says "price", "plan"
 * and "₹35,000". An embedding would close that gap on its own; with no embedding model
 * on the box, a short hand-written table closes it for the vocabulary this product
 * actually has. Every entry below came from a retrieval test that failed.
 *
 * Expansions are scored at a fraction of a real term (EXPANSION_WEIGHT) so they break
 * ties and rescue misses without letting a synonym outrank the word someone typed.
 */
const SYNONYMS: Record<string, string[]> = {
  cost: ['price', 'pricing', 'plan', 'month', 'venue', 'rupees', 'gst'],
  costs: ['price', 'pricing', 'plan', 'month', 'venue'],
  expensive: ['price', 'pricing', 'plan', 'month'],
  charge: ['price', 'pricing', 'fees', 'invoice'],
  charges: ['price', 'pricing', 'fees', 'invoice'],
  fee: ['price', 'pricing', 'fees', 'invoice'],
  fees: ['price', 'pricing', 'invoice', 'gst'],
  pay: ['price', 'payment', 'invoice', 'razorpay'],
  budget: ['price', 'pricing', 'plan'],
  keep: ['retention', 'retained', 'stored', 'days'],
  kept: ['retention', 'retained', 'stored', 'days'],
  store: ['stored', 'retention', 'india', 'mumbai'],
  stored: ['retention', 'india', 'mumbai', 'residency'],
  retain: ['retention', 'retained', 'days'],
  long: ['retention', 'days', 'period'],
  recordings: ['recording', 'call', 'transcripts', 'retention'],
  recording: ['recordings', 'call', 'transcripts'],
  pos: ['petpooja', 'posist', 'webhook', 'integration'],
  integrate: ['integration', 'petpooja', 'posist', 'api', 'webhook'],
  integration: ['petpooja', 'posist', 'api', 'webhook'],
  app: ['browser', 'download', 'qr'],
  download: ['app', 'browser'],
  language: ['english', 'hindi', 'kannada', 'languages'],
  languages: ['english', 'hindi', 'kannada'],
  cancel: ['terminate', 'termination', 'notice', 'renew', 'renewal'],
  cancelling: ['terminate', 'termination', 'notice', 'renewal'],
  refund: ['refunds', 'credits', 'termination'],
  contract: ['terms', 'renewal', 'notice', 'order'],
  lock: ['contract', 'renewal', 'notice'],
  secure: ['security', 'encryption', 'access', 'audit'],
  safety: ['security', 'allergen', 'allergy'],
  gdpr: ['dpdp', 'privacy', 'compliance'],
  compliance: ['dpdp', 'gst', 'trai', 'privacy'],
  erase: ['deletion', 'delete', 'erasure'],
  // There is no stemmer here, so "delete my data" shares no term with the section headed
  // "How to request deletion". These three entries are that missing suffix rule.
  delete: ['deletion', 'erasure', 'request'],
  deleted: ['deletion', 'erasure'],
  deleting: ['deletion', 'erasure'],
  remove: ['deletion', 'delete', 'erasure', 'opt'],
  unsubscribe: ['opt', 'stop', 'marketing', 'consent'],
  spam: ['marketing', 'consent', 'opt', 'stop'],
  uptime: ['availability', 'sla', 'maintenance'],
  sla: ['availability', 'uptime', 'order'],
  staff: ['team', 'host', 'roles'],
  outlets: ['outlet', 'group', 'multi'],
  chain: ['group', 'outlets', 'multi'],
  // "What is the pricing" lost to the shorter Enterprise section, which mentions pricing
  // once against the plans table's twice - BM25's length penalty, working as designed and
  // giving the wrong answer. Pulling in the words the plans table is made of settles it.
  pricing: ['plans', 'plan', 'growth', 'trial', 'venue', 'month'],
  price: ['plans', 'plan', 'growth', 'venue', 'month'],
  // "What does it offer?" is the single most common opening question and the copy never
  // uses the word. The site says "platform", "modules" and "operating system", so a
  // visitor asking the most basic question of all was getting the cookie policy.
  offer: ['platform', 'modules', 'operating', 'system', 'bookings', 'loyalty'],
  offers: ['platform', 'modules', 'operating', 'system', 'bookings', 'loyalty'],
  offering: ['platform', 'modules', 'operating', 'system'],
  uses: ['platform', 'modules', 'operating', 'system', 'bookings'],
  // There is deliberately no bare `use:` entry. "What does it use" is rare; "can I use my
  // own WhatsApp number", "can I use it on a tablet" are not, and expanding those into
  // five product-overview words buried the specific section under "What EatLabs is".
  // It survived only while the KB was small enough for the real chunk to outscore the
  // expansion anyway - adding the guide pages lowered the IDF of shared words like
  // "whatsapp" and the question started resolving to the overview. Leave it out.
  features: ['modules', 'platform', 'operating', 'system', 'bookings'],
  feature: ['modules', 'platform', 'operating', 'system'],
  capabilities: ['modules', 'platform', 'operating', 'system'],
  provide: ['platform', 'modules', 'operating', 'system'],
  provides: ['platform', 'modules', 'operating', 'system'],
  // "Who made this?" is one of the first things a visitor types, and none of the words
  // for it appear in the copy, which says "designed", "built" and "WebWorks Co."
  made: ['webworks', 'designed', 'built', 'company'],
  make: ['webworks', 'designed', 'built', 'company'],
  built: ['webworks', 'designed', 'company'],
  build: ['webworks', 'designed', 'company'],
  created: ['webworks', 'designed', 'built'],
  behind: ['webworks', 'designed', 'company'],
  developed: ['webworks', 'designed', 'built'],
  demo: ['contact', 'enquiry', 'quote'],
  trial: ['free', 'days', 'onboarding'],
  support: ['contact', 'whatsapp', 'email'],
};

const EXPANSION_WEIGHT = 0.45;

/**
 * Words people wrap a question in. They are not topics, and scoring them is actively
 * harmful: they are rare in the knowledge base, so BM25 treats them as highly
 * informative. "could tell me about eatlabs?" was answered with identity verification
 * because `tell`, `could` and `me` appear in four, two and one chunk respectively, while
 * `eatlabs` - the only real word in the question - is in half of them and worth nothing.
 *
 * Removed from the question only. A chunk that genuinely says "tell" keeps it.
 */
const FILLER = new Set([
  'could', 'would', 'should', 'tell', 'telling', 'know', 'knowing', 'like', 'want',
  'please', 'kindly', 'hi', 'hey', 'hello', 'thanks', 'thank', 'yeah', 'yes', 'no',
  'ok', 'okay', 'pls', 'plz', 'just', 'maybe', 'really', 'actually', 'sorry',
  'give', 'need', 'say', 'said', 'get', 'got', 'let', 'make', 'going', 'good',
  'morning', 'evening', 'sir', 'madam', 'dear', 'anything', 'something', 'stuff',
]);

/**
 * A term in half the chunks cannot pick between them. `eatlabs` is in 49% and
 * `restaurant` in 44%, which is what makes "tell me about eatlabs" a question with no
 * usable search terms at all once the filler is gone.
 */
const COMMON_TERM_SHARE = 0.4;

/** Split on anything that is not a word character, keeping ₹ and % - they carry meaning here. */
export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9₹%]+/g) ?? []).filter((t) => t.length > 1);
}

/**
 * Function words carry no topic, and tripling them in the heading boost below was doing
 * real damage: "How do I delete my data?" matched
 * `Objection: "Do my guests need to download an app?"` on nothing but `do` and `my`, and
 * that objection outranked the deletion instructions. They stay in the index - the full
 * heading is still written once - they are just not amplified.
 */
export const FUNCTION_WORDS = new Set([
  // `not` is deliberately absent: there is a section headed "what EatLabs is not", and
  // dropping the word makes "what does EatLabs not do" the same question as its opposite.
  'the', 'and', 'for', 'are', 'but', 'you', 'your', 'our', 'their', 'its',
  'with', 'from', 'that', 'this', 'these', 'those', 'what', 'which', 'who', 'whom',
  'how', 'when', 'where', 'why', 'can', 'will', 'do', 'does', 'did', 'has',
  'have', 'had', 'was', 'were', 'been', 'being', 'into', 'onto', 'about', 'any',
  'all', 'my', 'me', 'we', 'they', 'them', 'it', 'is', 'of', 'to', 'in', 'on', 'at',
  'as', 'by', 'or', 'if', 'an', 'be', 'so', 'up', 'out', 'over', 'than', 'too',
  'there', 'here', 'also', 'much', 'many', 'more', 'some', 'such', 'only', 'own',
]);

/**
 * Headings are the question in disguise ("How to request deletion"), so they are worth
 * more than body text. Repeating them is the cheapest way to weight a field in BM25.
 *
 * `spoken` is indexed too, and it is not redundant with `text`. It is the same fact
 * written the way a person would say it, so it carries the plain words a visitor types
 * while the prose carries the formal ones. Leaving it out had a real cost: "what is your
 * uptime guarantee" matched nothing useful, because the chunk that answers it says
 * "we don't publish a general uptime percentage" in its spoken line and nowhere else.
 */
function indexText(c: Chunk): string {
  const boost = tokenize(c.heading).filter((t) => !FUNCTION_WORDS.has(t)).join(' ');
  return `${c.heading} ${boost} ${boost} ${c.topic} ${c.spoken ?? ''} ${c.text}`;
}

export class Index {
  private chunks: Chunk[] = [];
  private docs: string[][] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(chunks: Chunk[]) {
    this.chunks = chunks;
    this.docs = chunks.map((c) => tokenize(indexText(c)));
    this.avgLen = this.docs.reduce((n, d) => n + d.length, 0) / (this.docs.length || 1);
    for (const doc of this.docs) {
      for (const term of new Set(doc)) this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }
  }

  get size(): number {
    return this.chunks.length;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    // +1 inside the log keeps this positive for a term in every document.
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * The chunk to answer an opening question with: "hi", "what are you", "tell me about
   * eatlabs". These have nothing to search for, and the honest options are a greeting or
   * nothing - never the chunk that happens to share a stray word.
   */
  private get opening(): Scored[] {
    const chunk = this.chunks.find((c) => c.opening && c.visibility !== 'agent-only');
    return chunk ? [{ chunk, score: 0 }] : [];
  }

  /** A term in more than COMMON_TERM_SHARE of chunks cannot tell them apart. */
  private discriminates(term: string): boolean {
    return (this.df.get(term) ?? 0) / (this.docs.length || 1) <= COMMON_TERM_SHARE;
  }

  /**
   * Dense vectors, keyed by chunk id, as written by tools/embed_kb.ts. Absent until an
   * embedding endpoint has been run over the knowledge base, and absent is fine: search
   * stays lexical.
   */
  private vectors = new Map<string, number[]>();

  attachVectors(vectors: Map<string, number[]>): void {
    this.vectors = vectors;
  }

  get hasVectors(): boolean {
    return this.vectors.size > 0;
  }

  /**
   * Whole-question search, fusing the lexical ranking with a dense one.
   *
   * Fused by RANK, not by score: BM25 is unbounded and query-dependent, cosine is
   * bounded, and any attempt to put them on one scale needs a normalisation that is
   * itself a tuned constant. Reciprocal rank fusion needs none - a chunk that both
   * methods like rises, and a chunk only one of them likes still gets a hearing.
   *
   * Falls back to the lexical result whenever vectors or the endpoint are missing, or
   * the endpoint fails. A search that works is worth more than a search that is clever.
   */
  async searchHybrid(query: string, k = 5, embedder?: Embedder): Promise<Scored[]> {
    // Checked before anything else, and before the script branch below, because a
    // greeting in Devanagari or Kannada reaches neither the filler list nor the opening
    // fallback on its own.
    if (isGreeting(query)) return this.opening;

    const lexical = this.search(query, Math.max(k, FUSE_DEPTH));
    const isOpening = lexical.length === 1 && lexical[0].chunk.opening && lexical[0].score === 0;

    if (!embedder || !this.vectors.size) return lexical.slice(0, k);

    /**
     * A question with no Latin letters is one BM25 cannot read. `tokenize` keeps only
     * `[a-z0-9]`, so a Hindi or Kannada question produces no terms at all, falls into
     * the opening fallback, and every such question gets "what EatLabs is" - whatever
     * it asked. The lexical result is not weak evidence here, it is no evidence, so it
     * is set aside entirely and the dense ranking stands on its own.
     *
     * This is the case dense retrieval earns its place on: two of the three languages
     * this agent supports have no lexical retrieval at all.
     */
    if (!LATIN.test(query)) {
      try {
        const [vector] = await embedder.embed([query]);
        const dense = this.dense(vector, k);
        return dense.length ? dense : lexical.slice(0, k);
      } catch {
        return lexical.slice(0, k);
      }
    }

    // An opening answer means the question had nothing to search for. Embedding "hi"
    // would produce a confident vector for no question at all.
    if (isOpening) return lexical;

    /**
     * The lexical veto, and the reason off-topic questions still hand over.
     *
     * An embedding always has a nearest neighbour. Over this knowledge base, an
     * unrelated question's best match scores inside the range real questions occupy,
     * so no cosine threshold can tell them apart - the measurement is above DENSE_FLOOR.
     * What CAN tell them apart is that a question about tyres or biryani shares no
     * vocabulary with any chunk, and BM25 returns nothing for it.
     *
     * So dense retrieval may REORDER what lexical found, and may not INTRODUCE an
     * answer where lexical found none. The agent keeps the right to say it does not
     * know, which is worth more than the handful of questions dense alone would catch.
     *
     * The exception is scripts BM25 was never able to read. The knowledge base is
     * written in English, so a question typed in Devanagari or Kannada produces no
     * lexical hits whatever it asks - silence there means nothing, and vetoing on it
     * would silently refuse two of the three languages this agent supports.
     */
    if (!lexical.length && LATIN.test(query)) return [];

    let dense: Scored[];
    try {
      const [vector] = await embedder.embed([query]);
      dense = this.dense(vector, FUSE_DEPTH);
    } catch {
      return lexical.slice(0, k);
    }

    return fuse(lexical, dense, k);
  }

  /** Cosine ranking over the chunks that have a vector, floored to keep noise out. */
  private dense(query: number[], k: number): Scored[] {
    const scored: Scored[] = [];
    for (const chunk of this.chunks) {
      if (chunk.visibility === 'agent-only') continue;
      const v = this.vectors.get(chunk.id);
      if (!v) continue;
      const score = similarity(query, v);
      // Without this, cosine ranks all 104 chunks for any input at all and the agent is
      // back to always having an answer. "What is the capital of France?" must still
      // come back empty.
      if (score < DENSE_FLOOR) continue;
      scored.push({ chunk, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  search(query: string, k = 5): Scored[] {
    if (isGreeting(query)) return this.opening;
    const phrase = query.toLowerCase().trim();
    const asked = tokenize(query).filter((t) => !FILLER.has(t) && !FUNCTION_WORDS.has(t));

    // Nothing to search on: the question was all filler ("hi", "thanks", "what are
    // you"), or its single remaining word is one half the knowledge base uses ("tell me
    // about eatlabs"). Both are someone opening a conversation.
    //
    // Deliberately narrow. Two common words still get scored, because "what does EatLabs
    // not do" is a real question built entirely from common words, and answering it with
    // the opening blurb would be its own kind of wrong.
    const distinct = new Set(asked);
    if (!distinct.size) return this.opening;
    if (distinct.size === 1 && !asked.some((t) => this.discriminates(t))) return this.opening;

    // A term the person typed counts fully; a synonym of it counts for less. Where a
    // word is both, the higher weight wins.
    const terms = new Map<string, number>();
    for (const t of asked) terms.set(t, 1);
    for (const t of asked) {
      for (const syn of SYNONYMS[t] ?? []) {
        if (!terms.has(syn)) terms.set(syn, EXPANSION_WEIGHT);
      }
    }

    const scored: Scored[] = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      if (chunk.visibility === 'agent-only') continue;

      const doc = this.docs[i];
      const len = doc.length || 1;
      const freq = new Map<string, number>();
      for (const t of doc) freq.set(t, (freq.get(t) ?? 0) + 1);

      let score = 0;
      for (const [term, weight] of terms) {
        const f = freq.get(term);
        if (!f) continue;
        score += weight * this.idf(term) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / this.avgLen)));
      }
      if (score === 0) continue;

      // An exact phrase in the heading is a near-certain match and BM25 alone misses it:
      // "how long do you keep call recordings" scores no better than a bag of those words.
      if (chunk.heading.toLowerCase().includes(phrase)) score *= 1.6;
      else if (chunk.text.toLowerCase().includes(phrase)) score *= 1.25;

      scored.push({ chunk, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}

export function loadChunks(path: string): Chunk[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Chunk);
}

/** Vectors written by tools/embed_kb.ts: one {id, v} per line, beside kb.jsonl. */
export function loadVectors(path: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { id: string; v: number[] };
    out.set(row.id, row.v);
  }
  return out;
}

export function loadIndex(path: string, vectorPath?: string): Index {
  const index = new Index(loadChunks(path));
  if (vectorPath) index.attachVectors(loadVectors(vectorPath));
  return index;
}
