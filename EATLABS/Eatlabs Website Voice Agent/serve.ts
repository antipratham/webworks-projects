/**
 * The test console for the site agent: ask it something, read the answer, hear it
 * spoken, and see exactly which passages it was given.
 *
 *   node serve.ts                      # http://127.0.0.1:3100
 *   PORT=8080 node serve.ts
 *   LLM_BASE_URL=http://127.0.0.1:8000/v1 node serve.ts     # with the real model
 *   TTS_BASE_URL=http://127.0.0.1:8020 node serve.ts        # with Indic Parler-TTS
 *
 * With neither set it still runs: the answer is the best passage read back, and the
 * speech is the browser's own voice. The point is that you can open the page and try
 * the retrieval before any GPU exists.
 *
 * The rule the codebase follows applies here too: the browser captures and displays,
 * the server decides. The page never sees the prompt, never picks the passages, and
 * cannot ask the model anything the server did not build.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ask, askStream, type StreamEvent, type TurnMemo } from './src/answer.ts';
import { Conversations } from './src/conversation.ts';

/** Only the terminal events carry a memo, but destructuring is simpler over the union. */
type StreamEventWithMemo = StreamEvent & { memo?: TurnMemo; text?: string };
import { createPassageClient, createQwenClient, probeServer } from './src/llm.ts';
import { createEmbedder, probeEmbedder } from './src/embed.ts';
import { createSttClient, probeStt } from './src/stt.ts';
import { loadIndex } from './src/retrieve.ts';

const PORT = Number(process.env.PORT ?? 3100);
const TTS_BASE_URL = process.env.TTS_BASE_URL ?? '';
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const index = loadIndex(here('./kb.jsonl'), here('./kb.vectors.jsonl'));

/**
 * Who asked what, so a second question can be about the first one's answer.
 *
 * In memory, and therefore lost on restart - which is correct for a console and would
 * not be for production. The thing to keep if this is ever moved behind Redis or a
 * table is not the storage but the direction: a request carries an id, never a
 * transcript. conversation.ts explains what goes wrong when that is reversed.
 */
const conversations = new Conversations();

// One probe at boot decides which client is used, so a page load is never spent finding
// out the GPU box is off.
const probe = await probeServer();
const llm = probe.reachable ? createQwenClient() : createPassageClient();

// Dense retrieval needs both halves: an endpoint to embed the question, and vectors for
// the knowledge base. Either one missing means lexical search, which is the default and
// is not a degraded mode - it is what has been answering all along.
const embedProbe = index.hasVectors
  ? await probeEmbedder()
  : { reachable: false, detail: 'no kb.vectors.jsonl (run tools/embed_kb.ts)' };
const embedder = embedProbe.reachable ? createEmbedder() : undefined;

// Speech in. Probed for the same reason as the others, and for one more: the console
// hides the microphone when there is nothing behind it, rather than offering a button
// that fails after the visitor has already spoken into it.
const sttCandidate = createSttClient();
const sttProbe = await probeStt(sttCandidate);
const stt = sttProbe.reachable ? sttCandidate : undefined;

console.log(`knowledge base: ${index.size} chunks`);
console.log(`model:          ${probe.reachable ? probe.detail : `${probe.detail}  → falling back to passages`}`);
console.log(`speech out:     ${TTS_BASE_URL || 'browser voice (set TTS_BASE_URL for Indic Parler-TTS)'}`);
console.log(`speech in:      ${stt ? sttProbe.detail : `${sttProbe.detail}  → microphone off`}`);
console.log(`retrieval:      ${embedder ? `hybrid - BM25 + ${embedProbe.detail}` : `lexical (BM25). ${embedProbe.detail}`}`);
// The address is printed from the 'listening' event, not here: printed before the bind
// it appears above the failure that says the port was taken, which reads as if the server
// had started.

/**
 * A conversation id off the wire, or nothing.
 *
 * Shape-checked rather than trusted, because this string is used as a Map key: without
 * a bound, a caller could post a megabyte of id per request and keep every one of them
 * alive in memory. The format is ours (`c_` and 32 hex characters), so anything else
 * was not issued by this server and starts a new conversation instead of an argument.
 */
function asId(value: unknown): string | undefined {
  return typeof value === 'string' && /^c_[0-9a-f]{32}$/.test(value) ? value : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64_000) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Audio does not fit the 64 KB JSON limit above, so it gets its own reader with its own
 * ceiling. Sixteen-bit mono at 16 kHz is 32 KB a second, so 8 MB is a little over four
 * minutes - far more than anyone will say to a website, and small enough that a stuck
 * upload cannot fill memory.
 */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

async function readAudio(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_AUDIO_BYTES) throw new Error('recording too long');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(here('./web/index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, {
        chunks: index.size,
        model: llm.label,
        modelReachable: probe.reachable,
        tts: TTS_BASE_URL ? 'indic-parler' : 'browser',
        stt: stt ? stt.label : null,
        retrieval: embedder ? 'hybrid' : 'lexical',
      });
      return;
    }

    /**
     * Speech in. The audio is turned into text and returned; it is not answered here.
     *
     * Two requests rather than one on purpose. The visitor sees what was heard before
     * it is asked, which matters because ASR is wrong often enough that silently
     * answering a misheard question is worse than showing it. It also keeps one
     * pipeline: the transcript goes back through /api/ask like any typed question, so
     * triage, retrieval and both gates behave identically whichever way it arrived.
     */
    if (req.method === 'POST' && url.pathname === '/api/listen') {
      if (!stt) return json(res, 503, { error: 'no speech-to-text configured' });

      const mime = (req.headers['content-type'] ?? 'audio/wav').split(';')[0].trim();
      if (!mime.startsWith('audio/')) return json(res, 415, { error: `expected audio, got ${mime}` });

      const langParam = url.searchParams.get('lang') ?? 'en';
      const lang = ['en', 'hi', 'kn'].includes(langParam) ? langParam : 'en';

      const started = Date.now();
      const audio = await readAudio(req);
      if (audio.length < 1000) return json(res, 400, { error: 'nothing was recorded' });

      try {
        const text = await stt.transcribe(audio, mime, lang);
        json(res, 200, { text, ms: Date.now() - started, bytes: audio.length });
      } catch (err) {
        // The console shows this to the tester verbatim. A transcription that failed is
        // worth seeing the reason for; it is almost always a quota or a model name.
        json(res, 502, { error: (err as Error).message });
      }
      return;
    }

    /**
     * Forget this thread and start again, without reloading the page. "Ask about
     * something else" is a real thing visitors do, and carrying the last topic into an
     * unrelated question is worse than having no memory at all.
     */
    if (req.method === 'POST' && url.pathname === '/api/conversation/reset') {
      const body = await readBody(req);
      const existing = asId(body.conversationId);
      if (existing) conversations.clear(existing);
      return json(res, 200, { conversationId: conversations.open(existing) });
    }

    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const body = await readBody(req);
      const question = String(body.question ?? '').slice(0, 1000).trim();
      if (!question) return json(res, 400, { error: 'ask something' });

      const lang = ['en', 'hi', 'kn'].includes(body.lang) ? String(body.lang) : 'en';
      // Transcribed input fails in ways typed input does not, so triage is told which
      // it is. Anything but 'voice' is treated as typed, which is the stricter case.
      const source = body.source === 'voice' ? 'voice' : 'text';

      // An unknown or stale id quietly becomes a new one; the page is told which it
      // got and adopts it. There is nothing a visitor can do with another visitor's id
      // beyond continuing that thread, and no account or personal data sits behind one.
      const conversationId = conversations.open(asId(body.conversationId));
      const history = conversations.recent(conversationId);

      const { memo, ...answer } = await ask(index, llm, question, { lang, embedder, source, history });
      if (memo) {
        conversations.record(conversationId, { question, answer: answer.text, context: memo.context });
      }
      json(res, 200, { ...answer, conversationId, searched: memo?.searched });
      return;
    }

    /**
     * The same answer as /api/ask, as server-sent events, so the console can show and
     * speak each sentence as it is cleared rather than waiting for the whole reply.
     * Every sentence on this stream has already passed the gate in answer.ts - the page
     * is never trusted to decide what is safe to say.
     */
    if (req.method === 'POST' && url.pathname === '/api/ask/stream') {
      const body = await readBody(req);
      const question = String(body.question ?? '').slice(0, 1000).trim();
      if (!question) return json(res, 400, { error: 'ask something' });
      const lang = ['en', 'hi', 'kn'].includes(body.lang) ? String(body.lang) : 'en';
      const source = body.source === 'voice' ? 'voice' : 'text';
      const conversationId = conversations.open(asId(body.conversationId));
      const history = conversations.recent(conversationId);

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Node buffers small writes by default; without this the first sentence can sit
        // in the socket until the reply is finished, which defeats the whole endpoint.
        'x-accel-buffering': 'no',
      });

      // The id goes out first, so the page can adopt it even when the answer is blocked
      // halfway through or the listener closes the tab before the end.
      res.write(`data: ${JSON.stringify({ type: 'conversation', conversationId })}\n\n`);

      for await (const event of askStream(index, llm, question, { lang, embedder, source, history })) {
        if (res.writableEnded) break;          // the listener navigated away mid-answer
        // `memo` is this server's note to itself - the full passage text the turn was
        // gated against. It is recorded here and never written to the wire.
        const { memo, ...wire } = event as StreamEventWithMemo;
        if (memo) {
          conversations.record(conversationId, {
            question,
            answer: typeof wire.text === 'string' ? wire.text : '',
            context: memo.context,
          });
        }
        res.write(`data: ${JSON.stringify(wire)}\n\n`);
      }
      res.end();
      return;
    }

    /**
     * Speech, proxied rather than called from the page, for two reasons: the TTS box is
     * not public, and the agent's own normaliser (services/tts/spoken.py) runs inside
     * that service - so "35,000" becomes words correctly in Hindi and Kannada, which a
     * browser voice cannot do. Without TTS_BASE_URL this 503s and the page uses its own.
     */
    if (req.method === 'POST' && url.pathname === '/api/speak') {
      if (!TTS_BASE_URL) return json(res, 503, { error: 'no TTS service configured' });
      const body = await readBody(req);
      const input = String(body.text ?? '').slice(0, 2000).trim();
      if (!input) return json(res, 400, { error: 'nothing to say' });
      const voice = ['en', 'hi', 'kn'].includes(body.lang) ? String(body.lang) : 'en';

      const upstream = await fetch(`${TTS_BASE_URL.replace(/\/+$/, '')}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input, voice, response_format: 'wav' }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!upstream.ok) {
        return json(res, 502, { error: `tts returned ${upstream.status}` });
      }
      const audio = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length });
      res.end(audio);
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: (err as Error).message });
  }
});

/**
 * Without this, a port already in use throws an unhandled 'error' event: a stack trace
 * through node:net, and on Windows a libuv assertion after it. None of that says the one
 * thing worth knowing, which is that something else is already on the port - usually an
 * earlier run of this same file that outlived its terminal.
 */
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`\nport ${PORT} is already in use - most likely an earlier 'node serve.ts'.`);
  console.error('\n  free it:   npx kill-port ' + PORT);
  console.error('  Windows:   Get-NetTCPConnection -LocalPort ' + PORT +
                " -State Listen | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }");
  console.error(`  or:        PORT=${PORT + 1} node --env-file=.env serve.ts\n`);
  console.error('Check which build is answering before you trust it:');
  console.error(`  curl http://127.0.0.1:${PORT}/api/status\n`);
  // Not process.exit(): on Windows that runs while the failed handle is still closing and
  // libuv aborts with an assertion, which puts a crash on screen after a clean message.
  // Nothing is listening, so the loop empties and the process leaves with this code.
  process.exitCode = 1;
});

server.on('listening', () => console.log(`\n  http://127.0.0.1:${PORT}\n`));

server.listen(PORT, '127.0.0.1');
