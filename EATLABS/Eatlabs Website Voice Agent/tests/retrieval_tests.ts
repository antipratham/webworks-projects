/**
 * Tests for the things that are enforced in code rather than asked of the model: what the
 * agent is allowed to SEE (retrieve.ts) and what it is allowed to SAY (answer.ts), on both
 * the whole-reply and the streaming path. None of it needs a model - the stub client
 * stands in for one, and for the invention tests it is made to say something wrong.
 *
 *   node tests/retrieval_tests.ts
 */

import { fileURLToPath } from 'node:url';
import { REPLIES, triage } from '../src/triage.ts';
import { ask, askStream, checkReply, HANDOVER } from '../src/answer.ts';
import type { LlmClient } from '../src/llm.ts';
import { createPassageClient } from '../src/llm.ts';
import { loadIndex } from '../src/retrieve.ts';
import {
  Conversations, contextualise, gateContext, isFollowUp, renderHistory, type Turn,
} from '../src/conversation.ts';

const KB_PATH = fileURLToPath(new URL('../kb.jsonl', import.meta.url));
const index = loadIndex(KB_PATH);
const passages = createPassageClient();

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A model that says exactly what it is told to, so the output gates can be tested. */
function sayingClient(text: string): LlmClient {
  return { label: 'fixed', async complete() { return text; } };
}

/** The same, delivered in pieces, so the streaming gate sees realistic token boundaries. */
function streamingClient(...pieces: string[]): LlmClient {
  return {
    label: 'fixed-stream',
    async complete() { return pieces.join(''); },
    async *stream() { for (const p of pieces) yield p; },
  };
}

async function collect(client: LlmClient, question: string) {
  const events = [];
  for await (const event of askStream(index, client, question)) events.push(event);
  const last = events[events.length - 1];
  return {
    events,
    spoken: events.filter((e) => e.type === 'sentence').map((e) => (e as { text: string }).text),
    final: last && 'text' in last ? last.text : '',
    blocked: last?.type === 'blocked' ? last : undefined,
  };
}

// ---------------------------------------------------------------- retrieval

/**
 * Rank 1, not "somewhere in the top 5".
 *
 * This used to assert top-5 membership, and that is how two real faults shipped: the
 * right chunk was in the list while the wrong one was being read out. Retrieval only
 * hands the model five passages, but the no-model fallback speaks the first, and on a
 * phone call the first is most of the answer. If the intended chunk is not first, that
 * is a miss worth failing on.
 */
const WEBWORKS_ABOUT = [
  'webworksco#who-webworks-co-is-and-what-they-designed',
  'webworksco#what-webworks-co-does-its-services',
];

const expectations: Array<[string, string | string[]]> = [
  // Opening the conversation. None of these have anything to search for, and before
  // the opening fallback existed they were answered from whichever chunk shared a
  // stray word: "could tell me about eatlabs?" returned identity verification, and
  // "Hi" returned the list of booking channels.
  ['Hi', 'identity#what-eatlabs-is'],
  ['hello there', 'identity#what-eatlabs-is'],
  ['thanks!', 'identity#what-eatlabs-is'],
  ['What are you', 'identity#what-eatlabs-is'],
  ['what do you do', 'identity#what-eatlabs-is'],
  ['could tell me about eatlabs?', 'identity#what-eatlabs-is'],
  ['tell me about eatlabs', 'identity#what-eatlabs-is'],
  ['what is eatlabs', 'identity#what-eatlabs-is'],
  ['How much does it cost?', 'pricing#the-published-plans'],
  ['What is the pricing', 'pricing#the-published-plans'],
  ['What are the plans?', 'pricing#the-published-plans'],
  ['What does Enterprise mean?', 'pricing#what-enterprise-means'],
  ['What does eatlabs offer?', 'identity#what-eatlabs-is'],
  ['What do u offer', 'identity#what-eatlabs-is'],
  ['Uses of eatlabs', 'identity#what-eatlabs-is'],
  ['What does EatLabs not do?', 'overview#out-of-scope-what-eatlabs-is-not'],
  ['How many languages covered?', 'overview#languages'],
  ["What's your uptime guarantee?", 'security#availability-and-support-commitments'],
  ['Can double bookings happen?', 'reservations#one-availability-engine-no-double-booking'],
  ['Which POS systems do you support?', 'segments-objections#integrations-at-a-glance'],
  ['Where is my data stored?', 'security#where-data-lives'],
  // Two sections answer this and both say 90 days: the retention table, and the call
  // records section. Either first is correct; pinning one would be pinning a tie.
  ['How long do you keep call recordings?',
    ['security#retention-periods', 'ai-calls#call-records-recording-and-transcripts']],
  ['How do I delete my data?', 'guest-rights#how-to-request-deletion'],
  ['Will the AI replace my staff?', 'segments-objections#objection-will-the-ai-replace-my-staff'],
  ['Can I use my own WhatsApp number?', 'whatsapp-crm#your-own-whatsapp-number'],
  // "Who is WebWorks Co.?" and "What does WebWorks Co. do?" reduce to the same two
  // search terms once question words are removed, so no lexical retriever can tell
  // them apart. Both sections describe the company; either first is correct.
  ['Who is WebWorks Co.?', WEBWORKS_ABOUT],
  ['Who designed EatLabs?', 'webworksco#who-webworks-co-is-and-what-they-designed'],
  ['Who made this?', 'webworksco#who-webworks-co-is-and-what-they-designed'],
  ['What does WebWorks Co. do?', WEBWORKS_ABOUT],
];

for (const [question, wanted] of expectations) {
  const ids = index.search(question, 5).map((h) => h.chunk.id);
  const ok = Array.isArray(wanted) ? wanted.includes(ids[0]) : ids[0] === wanted;
  check(`retrieve: "${question}"`, ok, `top3 = ${ids.slice(0, 3).join(', ') || 'nothing'}`);
}

// A question with real words that match nothing must retrieve nothing, so the answer
// becomes the handover rather than the least-bad chunk. This is the other half of the
// opening fallback: silence is only safe when we are sure we were asked something.
// A question that shares a word with the KB but is plainly about something else
// ("how do I change a tyre" matches `change`) still scores ~3.4, against ~4.4 for the
// weakest real question. That gap is too narrow to put a floor in: the failure it
// would eventually cause is a genuine question silently becoming a handover.
for (const q of ['What is the capital of France?', 'best biryani recipe', 'what is the weather']) {
  check(`off-topic retrieves nothing: "${q}"`, index.search(q, 5).length === 0,
    `got ${index.search(q, 5).map((h) => h.chunk.id).join(', ')}`);
}

// ---------------------------------------------------------------- what it may see

{
  // The guardrails document is instructions for the agent. If it ever comes back as a
  // passage, the agent can read "never say X" aloud to the person asking about X.
  const probes = ['guardrails', 'what must the agent never invent', 'placeholder', 'prompt injection'];
  const leaked = probes.flatMap((p) =>
    index.search(p, 8).filter((h) => h.chunk.visibility === 'agent-only').map((h) => h.chunk.id),
  );
  check('agent-only chunks are never retrievable', leaked.length === 0, leaked.join(', '));
}

{
  // One general assistant: a question about guest data and a question about pricing are
  // both answerable, and neither is filtered away by who the asker is assumed to be.
  const guest = index.search('delete my data', 6);
  check('a guest-rights question still reaches guest-rights', guest.some((h) => h.chunk.doc_id === 'guest-rights'),
    guest.map((h) => h.chunk.id).slice(0, 3).join(', '));
  const owner = index.search('what does it cost per outlet', 6);
  check('a commercial question still reaches pricing', owner.some((h) => h.chunk.doc_id === 'pricing'),
    owner.map((h) => h.chunk.id).slice(0, 3).join(', '));
}

{
  const provided = index.search('WebWorks Co. Marathahalli', 5);
  check('provided content is marked as provided, not scraped',
    provided.some((h) => h.chunk.provenance === 'provided'),
    provided.map((h) => `${h.chunk.id}=${h.chunk.provenance}`).join(', '));
}

// ---------------------------------------------------------------- what it may say

{
  const a = await ask(index, sayingClient('Growth is ₹25,000 per month per venue.'), 'how much does it cost?');
  check('invented price is blocked', a.text === HANDOVER && !!a.rejected, a.rejected ?? a.text);
}

{
  const a = await ask(index, sayingClient('Growth is ₹35,000 per month per venue, plus GST.'), 'how much does it cost?');
  check('a correct price is allowed through', a.text.includes('35,000') && !a.rejected, a.rejected ?? '');
}

{
  const a = await ask(index, sayingClient('We guarantee 99.99% uptime.'), 'what uptime do you promise?');
  check('invented percentage is blocked', a.text === HANDOVER && !!a.rejected, a.rejected ?? a.text);
}

{
  const a = await ask(index, sayingClient('Our office is at [REGISTERED OFFICE ADDRESS], Bengaluru.'), 'where are you based?');
  check('unfilled placeholder is blocked', a.text === HANDOVER && !!a.rejected, a.rejected ?? a.text);
}

{
  const a = await ask(index, sayingClient('- point one\n- **point two**'), 'what do you do?');
  check('markdown is stripped for speech', !/[*\-#]/.test(a.text.replace(/[^\S\n]/g, '')), a.text);
}

{
  const broken: LlmClient = { label: 'down', async complete() { throw new Error('connection refused'); } };
  const a = await ask(index, broken, 'how much does it cost?');
  check('an unreachable model falls back safely', a.text === HANDOVER && !!a.rejected, a.rejected ?? '');
}

{
  // Real words, plainly not about EatLabs. "qwertyuiop zxcvbnm" used to live here and is
  // now caught a stage earlier as gibberish, which is a different and better answer.
  const a = await ask(index, passages, 'What is the capital of France?');
  check('a question matching nothing hands over', a.text === HANDOVER, a.text);
}

// ------------------------------------- a line that was misheard rather than said
//
// These are the cases that must behave the same on every model, which is why they are
// tested against `triage` directly rather than through an answer: no model is involved,
// so swapping Gemini for Qwen cannot change any of it.

{
  const voice = (q: string) => triage(q, 'voice');
  const typed = (q: string) => triage(q, 'text');

  // Whisper is trained on subtitle tracks and falls back on their furniture when the
  // audio holds no speech. Fluent, confident, and nothing anyone said.
  for (const artefact of [
    'Thank you for watching!',
    'Thanks so much for watching.',
    'Please subscribe to my channel.',
    '[Music]',
    '(inaudible)',
    'Subtitles by the Amara.org community',
    'See you in the next video.',
  ]) {
    check(`a recogniser artefact is not answered: "${artefact}"`,
      voice(artefact).kind === 'misheard', voice(artefact).kind);
  }

  // The same words typed are a person saying an odd thing, and get an ordinary answer.
  check('the same words typed are not treated as a transcription failure',
    typed('Thank you for watching!').kind === 'ok', typed('Thank you for watching!').kind);

  // A decoder that loses its place repeats itself until it is reset.
  check('a looping transcript is caught',
    voice('the the the the the the').kind === 'misheard', voice('the the the the the the').kind);
  check('a transcript dominated by one word is caught',
    voice('cost cost cost cost what cost cost').kind === 'misheard',
    voice('cost cost cost cost what cost cost').kind);
  check('a loop in Devanagari is caught too',
    voice('नहीं नहीं नहीं नहीं नहीं नहीं').kind === 'misheard',
    voice('नहीं नहीं नहीं नहीं नहीं नहीं').kind);

  // And the false positives that would matter, because a real question wrongly called
  // misheard is worse than a misheard one wrongly answered.
  for (const real of [
    'is it per outlet or per outlet group',
    'do you do delivery or do you do dine in only',
    'what is the cost of the cost per month',
    'can I can I ask about pricing',
  ]) {
    check(`a real question with a repeat in it is still answered: "${real}"`,
      voice(real).kind === 'ok', voice(real).kind);
  }

  check('three words in a row is a sentence, not a loop',
    voice('no no no').kind === 'ok', voice('no no no').kind);

  // The wording has to match how the question arrived.
  check('a spoken failure is told what to change',
    voice('[Music]').reply === REPLIES.misheard && REPLIES.misheard !== REPLIES.gibberish,
    'misheard' in REPLIES ? REPLIES.misheard : 'missing');
  check('the source defaults to typed when a caller does not say',
    triage('Thank you for watching!').kind === 'ok', triage('Thank you for watching!').kind);

  // Nothing here may reach the index, whichever way it arrived.
  const heard = await ask(index, passages, 'Thanks for watching!', { source: 'voice' });
  check('a misheard line never reaches retrieval',
    heard.mode === 'fixed' && heard.passages.length === 0 && heard.text === REPLIES.misheard,
    `${heard.mode}: ${heard.text}`);
}

// --------------------------------------------------------------- edge cases before search

{
  const rude = await ask(index, passages, 'this is f***ing useless'.replace(/\*\*\*/, 'uck'));
  check('abuse gets a fixed reply, not a passage',
    rude.text === REPLIES.abuse && rude.passages.length === 0, rude.text);

  const cross = await ask(index, passages, 'your product is rubbish, how do I cancel?');
  check('a complaint is still answered',
    cross.text !== REPLIES.abuse && cross.passages.length > 0, cross.text);

  const mash = await ask(index, passages, 'asdkjhasd kjhasdkjh');
  check('gibberish asks for a rephrase', mash.text === REPLIES.gibberish, mash.text);

  const nothing = await ask(index, passages, '   ');
  check('an empty question does not search', nothing.text === REPLIES.empty, nothing.text);

  const hindi = await ask(index, passages, 'क्या कीमत है');
  check('an Indic-script question is not called gibberish',
    hindi.text !== REPLIES.gibberish, hindi.text);

  const stream = await collect(passages, 'fuck off');
  check('abuse ends the stream with the fixed reply',
    stream.final === REPLIES.abuse && stream.spoken.length === 0, stream.final);
}

// ------------------------------------------------- what it may say while still speaking

{
  // The point of the streaming gate: a price split across token boundaries must still be
  // judged whole. "₹25" and ",000" arriving separately must not slip past.
  const r = await collect(streamingClient('Growth is ₹', '25', ',000 per month.'), 'how much does it cost?');
  check('streaming: a price split across tokens is still blocked', !!r.blocked, r.final);
  check('streaming: nothing wrong was released for speech', r.spoken.length === 0, r.spoken.join(' | '));
}

{
  const r = await collect(streamingClient('Growth is ₹35,000 per month per venue. ', 'GST is extra.'), 'how much does it cost?');
  check('streaming: a correct price is released', !r.blocked && r.final.includes('35,000'), r.blocked?.rejected ?? r.final);
  check('streaming: it arrives as more than one sentence', r.spoken.length >= 2, String(r.spoken.length));
}

{
  // A reply that goes wrong late: the clean opening has already been spoken and cannot be
  // recalled, so the answer must end in the handover rather than the invention.
  const r = await collect(
    streamingClient('Every channel checks one availability engine. ', 'It is 99.98% reliable.'),
    'can double bookings happen?');
  check('streaming: a late invention is blocked', !!r.blocked, r.final);
  check('streaming: the clean opening survives, the invention does not',
    r.spoken.length === 1 && r.final.includes('availability engine') && r.final.includes('WhatsApp'),
    `${r.spoken.length} spoken; final=${r.final.slice(0, 80)}`);
}

{
  const r = await collect(streamingClient('[SUPPORT HOURS] is when we answer.'), 'when are you open?');
  check('streaming: a placeholder is blocked', !!r.blocked, r.final);
}

{
  const broken: LlmClient = {
    label: 'down',
    async complete() { throw new Error('refused'); },
    async *stream(): AsyncIterable<string> { throw new Error('refused mid-stream'); },
  };
  const r = await collect(broken, 'how much does it cost?');
  check('streaming: a dropped connection hands over', r.final === HANDOVER && !!r.blocked, r.final);
}

{
  const r = await collect(passages, 'how much does it cost?');
  check('streaming: the no-model fallback streams too', r.spoken.length >= 1 && !r.blocked,
    r.blocked?.rejected ?? `${r.spoken.length} sentences`);
  check('streaming: passages are sent before any sentence',
    r.events[0]?.type === 'passages', r.events[0]?.type ?? 'nothing');
}

// ------------------------------------------------------- hybrid (dense + lexical) search
//
// No embedding endpoint runs in tests, so the embedder is a stub and the vectors are
// synthetic. What is being tested is the part that is ours: that a dense hit the lexical
// side missed can still reach the answer, that the floor keeps noise out, and above all
// that every failure of the dense half leaves the lexical result intact.

{
  const { loadChunks, Index } = await import('../src/retrieve.ts');
  const { normalise } = await import('../src/embed.ts');
  const chunks = loadChunks(KB_PATH);

  /** A one-hot vector per chunk: orthogonal, so similarity is 1 only with itself. */
  const dim = chunks.length;
  const vectorFor = (i: number) => normalise(Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0)));

  const target = chunks.findIndex((c) => c.id === 'security#retention-periods');
  const vectors = new Map(chunks.map((c, i) => [c.id, vectorFor(i)]));

  const stub = (i: number) => ({
    label: 'stub', model: 'stub',
    async embed() { return [vectorFor(i)]; },
  });

  const withVectors = new Index(chunks);
  withVectors.attachVectors(vectors);

  const q = 'How much does it cost?';
  const lexicalOnly = withVectors.search(q, 5).map((h) => h.chunk.id);

  const fused = (await withVectors.searchHybrid(q, 5, stub(target))).map((h) => h.chunk.id);
  check('a dense-only hit reaches the results', fused.includes('security#retention-periods'),
    fused.join(', '));
  check('fusion keeps the lexical winner near the top',
    fused.slice(0, 2).includes(lexicalOnly[0]), fused.join(', '));

  // Every chunk orthogonal to the query sits at cosine 0, far under the floor.
  const noDense = await withVectors.searchHybrid(q, 5, {
    label: 'stub', model: 'stub',
    async embed() { return [normalise(Array.from({ length: dim }, (_, j) => (j === dim - 1 ? 1 : 0)))]; },
  });
  // Not "the chunk is absent" - it may well be a lexical hit on its own merits. The
  // property is that the dense half contributed nothing, so the ranking is unchanged.
  check('the dense floor keeps unrelated chunks out',
    noDense.map((h) => h.chunk.id).join() === lexicalOnly.join(),
    noDense.map((h) => h.chunk.id).join(', '));

  const broken = await withVectors.searchHybrid(q, 5, {
    label: 'stub', model: 'stub',
    async embed(): Promise<number[][]> { throw new Error('endpoint down'); },
  });
  check('a failing embedder falls back to lexical',
    broken[0]?.chunk.id === lexicalOnly[0], broken.map((h) => h.chunk.id).join(', '));

  const noVectors = await new Index(chunks).searchHybrid(q, 5, stub(target));
  check('no vectors means plain lexical search',
    noVectors.map((h) => h.chunk.id).join() === lexicalOnly.join(), '');

  const greeting = await withVectors.searchHybrid('Hi', 5, stub(target));
  check('an opening question is not embedded',
    greeting.length === 1 && greeting[0].chunk.opening === true,
    greeting.map((h) => h.chunk.id).join(', '));
}



// --------------------------------------------- the lexical veto, and scripts BM25 cannot read
//
// Measured on multilingual-e5-small over this KB: real questions' best cosine runs 0.813-0.944
// and off-topic 0.739-0.833. They overlap, so no floor separates them, and dense retrieval
// cannot be allowed to introduce an answer where lexical found none. Except in a script BM25
// cannot tokenize at all, where its silence is not evidence of anything.

{
  const { loadChunks, Index } = await import('../src/retrieve.ts');
  const { normalise } = await import('../src/embed.ts');
  const chunks = loadChunks(KB_PATH);
  const dim = chunks.length;
  const oneHot = (i: number) => normalise(Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0)));
  const idx = new Index(chunks);
  idx.attachVectors(new Map(chunks.map((c, i) => [c.id, oneHot(i)])));

  // An embedder that is always maximally confident about one chunk - the worst case for a floor.
  const target = chunks.findIndex((c) => c.id === 'security#retention-periods');
  const eager = { label: 'stub', model: 'stub', async embed() { return [oneHot(target)]; } };

  const offTopic = await idx.searchHybrid('What is the capital of France?', 5, eager);
  check('dense cannot answer what lexical refused', offTopic.length === 0,
    offTopic.map((h) => h.chunk.id).join(', '));

  const real = await idx.searchHybrid('How much does it cost?', 5, eager);
  check('dense still reorders what lexical did find',
    real.some((h) => h.chunk.id === 'security#retention-periods'), real.map((h) => h.chunk.id).join(', '));

  // Devanagari: tokenize() keeps only [a-z0-9], so lexical returns the opening chunk for every
  // question in this script. Vetoing on that would answer "where is my data?" with "what EatLabs is".
  const hindi = await idx.searchHybrid('मेरा डेटा कहाँ रखा जाता है?', 3, eager);
  check('an Indic-script question is answered by dense, not the opening chunk',
    hindi.length > 0 && hindi[0].chunk.id === 'security#retention-periods',
    hindi.map((h) => h.chunk.id).join(', '));

  const hindiNoEmbedder = await idx.searchHybrid('मेरा डेटा कहाँ रखा जाता है?', 3);
  check('without an embedder an Indic question still gets the opening chunk, not nothing',
    hindiNoEmbedder.length === 1 && hindiNoEmbedder[0].chunk.opening === true,
    hindiNoEmbedder.map((h) => h.chunk.id).join(', '));
}

// ------------------------------------------------ greetings, in all three languages

{
  // Devanagari and Kannada produce no tokens at all from tokenize(), so before these
  // were recognised a greeting skipped the opening fallback and took whatever chunk sat
  // nearest in vector space: "nhमस्ते" returned the sub-processor list and "knಮಸ್ಕಾರ" the
  // data-deletion policy.
  const greetings = ['hi', 'Hello', 'hey', 'hi there', 'Hello!', 'thanks',
    'namaste', 'namaskara', 'नमस्ते', 'हैलो',
    'ನಮಸ್ಕಾರ', 'ಹಲೋ'];
  for (const g of greetings) {
    const hits = index.search(g, 3);
    check(`greeting "${g}" gets the opening answer`,
      hits.length === 1 && hits[0].chunk.opening === true,
      hits.map((h) => h.chunk.id).join(', ') || 'nothing');
  }

  // A greeting attached to a real question is a question.
  const asked = index.search('hi, how much does it cost?', 3);
  check('a greeting before a question does not swallow the question',
    asked[0]?.chunk.id === 'pricing#the-published-plans',
    asked.map((h) => h.chunk.id).join(', '));
}

// ---------------------------------------- the request shape adapts to a hosted endpoint

{
  const { createQwenClient } = await import('../src/llm.ts');
  const seen: Array<Record<string, unknown>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
    seen.push(JSON.parse(init.body));
    throw new Error('intercepted');
  }) as unknown as typeof fetch;

  for (const baseUrl of ['http://127.0.0.1:8000/v1', 'https://generativelanguage.googleapis.com/v1beta/openai']) {
    try { await createQwenClient({ baseUrl, maxRetries: 0 }).complete({ system: 's', user: 'u', maxTokens: 8 }); } catch { /* expected */ }
  }
  globalThis.fetch = real;

  // chat_template_kwargs is vLLM's own field. A hosted OpenAI-compatible endpoint
  // rejects the whole request for an unknown field, so it must not be sent to one.
  check('vLLM-only fields go to a local server', 'chat_template_kwargs' in (seen[0] ?? {}),
    Object.keys(seen[0] ?? {}).join(', '));
  check('vLLM-only fields are withheld from a hosted endpoint',
    !('chat_template_kwargs' in (seen[1] ?? {})), Object.keys(seen[1] ?? {}).join(', '));
}

// --------------------------------- answering without passages, and what that may say

{
  // The router, first. Which prompt a question gets is decided by retrieval, and the
  // mode is reported so a wrong route shows up here rather than in a demo.
  const chat = await ask(index, sayingClient('Paris.'), 'what is the capital of France?');
  check('an unrelated question is answered, not handed over',
    chat.mode === 'open' && chat.text === 'Paris.' && chat.passages.length === 0,
    `${chat.mode}: ${chat.text}`);

  const hello = await ask(index, sayingClient('Hello. What would you like to know?'), 'hi');
  check('a greeting is greeted back, not given the product blurb',
    hello.mode === 'open' && hello.passages.length === 0, `${hello.mode}: ${hello.text}`);

  const priced = await ask(index, passages, 'how much does the Growth plan cost?');
  check('a question the knowledge base answers still takes the grounded route',
    priced.mode === 'grounded' && priced.passages.length > 0, priced.mode);

  const rude = await ask(index, passages, 'fuck off');
  check('abuse is still a fixed reply, not an open one', rude.mode === 'fixed', rude.mode);
}

{
  // The gate on the open route. Every figure is unsourced there by definition, so the
  // rule is simply that there are none - which is what makes it impossible to argue
  // with and impossible for the model to talk its way around.
  const invented = await ask(index,
    sayingClient('EatLabs starts at ₹9,000 a month.'), 'what is the capital of France?');
  check('an open reply quoting a price is blocked', invented.text === HANDOVER, invented.text);

  const counted = await ask(index,
    sayingClient('There are 7 continents.'), 'how many continents are there?');
  check('an open reply with any figure at all is blocked', counted.text === HANDOVER, counted.text);

  const worded = await ask(index,
    sayingClient('Seven, and I can help with EatLabs too.'), 'how many continents are there?');
  check('the same answer written in words is allowed',
    worded.text === 'Seven, and I can help with EatLabs too.', worded.text);

  const contact = await ask(index,
    sayingClient('I will find out. WhatsApp us on +91 80 4000 1200.'), 'tell me a joke');
  check('the handover number is the one figure an open reply may carry',
    contact.text.includes('4000 1200') && contact.text !== HANDOVER, contact.text);

  const linked = await ask(index,
    sayingClient('Try https://example.com for that.'), 'tell me a joke');
  check('an open reply reading out a link is blocked', linked.text === HANDOVER, linked.text);

  // The grounded gate must not have been loosened by any of the above: a price that is
  // in a passage is still fine, and one that is not is still blocked.
  const grounded = await ask(index,
    sayingClient('It is ₹77,777 a month.'), 'how much does the Growth plan cost?');
  check('the grounded gate still blocks an invented price', grounded.text === HANDOVER, grounded.text);
}

{
  // Streaming takes the same route and the same gate, a sentence at a time, so nothing
  // that would be blocked whole can be spoken in pieces.
  const r = await collect(
    streamingClient('Paris is the capital of France. ', 'It has about ', '2.1 million people.'),
    'what is the capital of France?',
  );
  check('streaming an open reply releases the clean sentence', r.spoken[0] === 'Paris is the capital of France.', r.spoken.join(' | '));
  check('streaming an open reply blocks the sentence with a figure', !!r.blocked, r.final);

  const mode = r.events.find((e) => e.type === 'passages');
  check('the stream says which route it took',
    mode?.type === 'passages' && mode.mode === 'open', String(mode?.type));
}

// ------------------------------------------------------ speech in: the wire, not the ear

{
  const { createWhisperClient, createGeminiSttClient, createSttClient } = await import('../src/stt.ts');
  const audio = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]);   // "RIFF" and some padding
  const real = globalThis.fetch;

  /** Captures one request and answers it with a canned body. */
  function intercept(body: unknown) {
    const seen: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: unknown, init: any) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return seen;
  }

  {
    const seen = intercept({ text: '  "How much does the Growth plan cost?"  ' });
    const text = await createWhisperClient({ baseUrl: 'http://127.0.0.1:8010/v1', model: 'whisper-1' })
      .transcribe(audio, 'audio/wav', 'hi');
    check('whisper posts to the OpenAI transcriptions endpoint',
      seen[0]?.url === 'http://127.0.0.1:8010/v1/audio/transcriptions', seen[0]?.url);
    check('whisper is told which language to expect',
      (seen[0]?.init.body as FormData).get('language') === 'hi',
      String((seen[0]?.init.body as FormData)?.get('language')));
    check('a transcript wrapped in quotes is unwrapped',
      text === 'How much does the Growth plan cost?', text);
  }

  {
    // The model describing the audio instead of transcribing it is not a transcript.
    const seen = intercept({ candidates: [{ content: { parts: [{ text: '(silence)' }] } }] });
    const quiet = await createGeminiSttClient({ apiKey: 'k', model: 'm' }).transcribe(audio, 'audio/wav', 'en');
    check('silence transcribes to nothing, not to a word', quiet === '', `"${quiet}"`);
    const body = JSON.parse(seen[0]?.init.body as string);
    check('gemini is sent the audio inline, base64',
      body.contents?.[0]?.parts?.[1]?.inlineData?.mimeType === 'audio/wav',
      JSON.stringify(Object.keys(body.contents?.[0]?.parts?.[1] ?? {})));
    check('gemini transcribes at temperature zero', body.generationConfig?.temperature === 0,
      String(body.generationConfig?.temperature));
  }

  globalThis.fetch = real;

  // Which client, from the environment. Self-hosted must win whenever it is configured:
  // getting this backwards would quietly send production audio to Google.
  const env = process.env;
  const saved = { base: env.STT_BASE_URL, provider: env.STT_PROVIDER, key: env.STT_API_KEY, llm: env.LLM_BASE_URL, llmKey: env.LLM_API_KEY };
  const restore = () => {
    for (const [k, v] of Object.entries({ STT_BASE_URL: saved.base, STT_PROVIDER: saved.provider, STT_API_KEY: saved.key, LLM_BASE_URL: saved.llm, LLM_API_KEY: saved.llmKey })) {
      if (v === undefined) delete env[k]; else env[k] = v;
    }
  };

  delete env.STT_PROVIDER; delete env.STT_API_KEY; delete env.LLM_API_KEY; delete env.LLM_BASE_URL;
  env.STT_BASE_URL = 'http://127.0.0.1:8010/v1';
  check('a configured self-hosted endpoint wins',
    createSttClient()?.label.includes('127.0.0.1:8010') === true, createSttClient()?.label);

  delete env.STT_BASE_URL;
  env.LLM_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
  env.LLM_API_KEY = 'test-key';
  check('a Gemini key already present is reused for transcription',
    createSttClient()?.label.includes('gemini') === true, createSttClient()?.label);

  env.STT_PROVIDER = 'off';
  check('STT_PROVIDER=off means no microphone', createSttClient() === undefined, createSttClient()?.label);

  delete env.STT_PROVIDER; delete env.LLM_API_KEY; delete env.LLM_BASE_URL;
  check('nothing configured means no microphone, not an error',
    createSttClient() === undefined, createSttClient()?.label);

  restore();
}

// ---------------------------------------------------------------- conversation memory
//
// The property under test throughout is that a follow-up can reach the thing it refers
// to, and that nothing a visitor types can widen what the agent is allowed to quote.

function turn(question: string, answer: string, context = ''): Turn {
  return { question, answer, context, at: Date.now() };
}

{
  const priced = [turn('What does Growth cost?', 'Growth is 35,000 rupees per venue per month.',
    'The published plans Growth 35,000 per month per venue. GST extra.')];

  check('a first question is never treated as a follow-up',
    isFollowUp('What does Growth cost?', []) === false);
  check('a pronoun makes it a follow-up', isFollowUp('is that with GST?', priced) === true);
  check('"what about X" makes it a follow-up', isFollowUp('what about Enterprise?', priced) === true);
  check('a bare noun phrase makes it a follow-up', isFollowUp('and Enterprise?', priced) === true);
  check('a full question of its own does not',
    isFollowUp('How do I delete my guest data under the DPDP Act?', priced) === false);

  // The widening is additive: the visitor's own words have to survive it.
  const widened = contextualise('is that with GST?', priced);
  check('a follow-up keeps the words the visitor typed',
    widened.startsWith('is that with GST?'), widened);
  check('a follow-up is widened with the previous topic',
    /growth/i.test(widened) && /cost/i.test(widened), widened);
  // Only the question is carried. Passage headings are the output of a search, and
  // feeding them back in is what made a long thread collapse onto one topic.
  check('a follow-up does not carry the previous passage headings',
    !/published/i.test(widened), widened);
  check('a standalone question is searched exactly as asked',
    contextualise('Where is my data stored?', priced) === 'Where is my data stored?');
  check('with no history there is nothing to widen',
    contextualise('is that with GST?', []) === 'is that with GST?');

  // The point of the widening: it has to actually retrieve the right thing.
  const cold = index.search('is that with GST?', 3).map((h) => h.chunk.id);
  const warm = index.search(widened, 3).map((h) => h.chunk.id);
  check('widening a follow-up reaches the pricing chunk the pronoun meant',
    warm.some((id) => id.startsWith('pricing#')),
    `cold=${cold.join(',') || 'nothing'}  warm=${warm.join(',') || 'nothing'}`);
}

{
  // The gate may recognise a figure established earlier in the same conversation...
  const priced = [turn('What does Growth cost?', 'Growth is 35,000 rupees.',
    'Growth INR 35,000 / month / venue')];
  const now = 'GST is added to every invoice.';
  check('a figure quoted earlier still passes the gate a turn later',
    checkReply('Growth is INR 35,000 plus GST.', gateContext(now, priced)) === null);

  // ...and must still refuse one that was never retrieved at all.
  check('a figure from nowhere is still blocked with history present',
    checkReply('Growth is INR 9,000 plus GST.', gateContext(now, priced)) !== null);
  check('an empty history leaves the gate exactly as it was',
    gateContext(now, []) === now);
}

{
  const store = new Conversations({ maxTurns: 3 });
  const id = store.open();
  check('an id is issued in the server format', /^c_[0-9a-f]{32}$/.test(id), id);
  check('a fresh conversation has no turns', store.recent(id).length === 0);

  for (let i = 1; i <= 5; i++) {
    store.record(id, { question: `q${i}`, answer: `a${i}`, context: '' });
  }
  const kept = store.recent(id);
  check('the window keeps only the most recent turns', kept.length === 3, `${kept.length}`);
  check('the window keeps the newest, not the oldest',
    kept[kept.length - 1].question === 'q5' && kept[0].question === 'q3',
    kept.map((t) => t.question).join(','));

  store.clear(id);
  check('reset empties the thread without losing the id', store.recent(id).length === 0);

  check('an id this server never issued starts a new conversation',
    store.open('c_notarealidatall') !== 'c_notarealidatall');

  // A browser tab left open overnight is not a live session.
  let fakeNow = 0;
  const ageing = new Conversations({ ttlMs: 1000, clock: () => fakeNow });
  const old = ageing.open();
  ageing.record(old, { question: 'q', answer: 'a', context: '' });
  fakeNow = 5000;
  check('a conversation past its ttl is forgotten', ageing.recent(old).length === 0);
  check('an expired id is replaced rather than refused', ageing.open(old) !== old);

  // A crawler must not be able to grow the map without bound.
  const capped = new Conversations({ maxConversations: 10 });
  for (let i = 0; i < 50; i++) capped.open();
  check('live conversations stay within their ceiling', capped.size <= 10, `${capped.size}`);
}

{
  const turns = [turn('What does Growth cost?', 'Growth is 35,000 rupees per venue.')];
  const rendered = renderHistory(turns);
  check('the transcript names both sides', /Them:/.test(rendered) && /You:/.test(rendered), rendered);
  check('an empty history renders to nothing', renderHistory([]) === '');
}

{
  // End to end on the real pipeline: the second question must reach the first one's
  // subject, and the answer path must hand back a memo for the server to record.
  const history = [turn('What does Growth cost?', 'Growth is 35,000 rupees per venue per month.',
    'The published plans Growth 35,000 per month per venue')];

  const follow = await ask(index, passages, 'what about Enterprise?', { history });
  check('a follow-up retrieves against the carried topic',
    follow.passages.some((p) => p.id.startsWith('pricing#')),
    follow.passages.map((p) => p.id).join(',') || 'nothing');
  check('the answer reports what it actually searched for',
    (follow.memo?.searched ?? '').includes('what about Enterprise?'), follow.memo?.searched);
  check('the answer carries a memo for the server to record',
    typeof follow.memo?.context === 'string' && follow.memo.context.length > 0);

  const first = await ask(index, passages, 'What does Growth cost?', {});
  check('a question with no history behaves exactly as before',
    first.memo?.searched === 'What does Growth cost?', first.memo?.searched);

  // "thanks" after a long exchange is a goodbye, not one more pricing question.
  const bye = await ask(index, passages, 'thanks!', { history });
  check('a greeting is not dragged back into the last topic', bye.mode === 'open', bye.mode);
}

// ---------------------------------------------------------------- report

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
