/**
 * STAGE -1 - speech to text, so the question can be spoken instead of typed.
 *
 * Two clients, one interface, and the interface is the one the deployment will use:
 *
 *   whisper  - POST /v1/audio/transcriptions, multipart, the OpenAI shape. This is what
 *              faster-whisper-server, whisper.cpp's server and vLLM's audio endpoint all
 *              speak, so the self-hosted box in eatlabs-llm-voice drops straight in by
 *              setting STT_BASE_URL and nothing else changes.
 *   gemini   - the free tier, for testing before that box exists. Gemini's
 *              OpenAI-compatible layer has no transcriptions endpoint, so this one
 *              talks to the native generateContent API with the audio inline. It is a
 *              stand-in and it is written to be deleted.
 *
 * Same decision as llm.ts: plain fetch, no SDK. The whole of each protocol used here is
 * one request.
 *
 * The audio never touches the knowledge base or the model prompt. It becomes text, and
 * that text goes in at the front of the ordinary pipeline - triage first, exactly as if
 * it had been typed. A microphone is an input device, not a second way in.
 */

export interface SttClient {
  /** The spoken words, or '' when there was nothing intelligible on the recording. */
  transcribe(audio: Uint8Array, mime: string, lang?: string): Promise<string>;
  readonly label: string;
}

export const DEFAULT_STT_URL = 'http://127.0.0.1:8010/v1';
export const DEFAULT_WHISPER_MODEL = 'Systran/faster-whisper-large-v3';
export const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_STT_MODEL = 'gemini-3.5-flash-lite';

/**
 * Hindi and Kannada are the reason the language is named at all: both are easy to hear
 * as the other when the speaker code-switches mid-sentence, which people do.
 */
const LANG_NAMES: Record<string, string> = { en: 'English', hi: 'Hindi', kn: 'Kannada' };
const SCRIPTS: Record<string, string> = {
  en: 'Latin script',
  hi: 'Devanagari script',
  kn: 'Kannada script',
};

/** What the model is told to say when it heard nothing. Mapped back to an empty string. */
const SILENCE = '(silence)';

const EXTENSION: Record<string, string> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac',
};

/**
 * A transcript is dictation, not instruction, and it is about to be shown in a page and
 * handed to a prompt. Anything that is clearly the model talking about the job rather
 * than doing it is stripped, and the rest is left exactly as spoken - including the
 * misrecognitions, because triage and retrieval are what decide whether it made sense.
 */
function clean(text: string): string {
  let out = text.trim();
  out = out.replace(/^(?:transcript|transcription)\s*[:\-]\s*/i, '');
  // A verbatim transcript comes back wrapped in quotes often enough to be worth this.
  if (/^["'“”](.*)["'“”]$/s.test(out)) {
    out = out.replace(/^["'“”]|["'“”]$/g, '').trim();
  }
  out = out.replace(/\s+/g, ' ').trim();
  // A reply that is nothing but a parenthetical is the model describing the audio -
  // "(silence)", "(inaudible)", "(music playing)" - rather than transcribing it.
  if (!out || out.toLowerCase() === SILENCE || /^\(.*\)$/.test(out)) return '';
  return out.slice(0, 1000);
}

export interface SttOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * The deployment client. One multipart POST, which is the whole of the protocol.
 *
 * `language` is sent rather than left to detection on purpose: the console already
 * knows which language the visitor picked, and a told language beats a guessed one on
 * a short noisy clip - which is every clip here.
 */
export function createWhisperClient(options: SttOptions = {}): SttClient {
  const env = globalThis.process?.env ?? {};
  const baseUrl = (options.baseUrl ?? env.STT_BASE_URL ?? DEFAULT_STT_URL).replace(/\/+$/, '');
  const model = options.model ?? env.STT_MODEL ?? DEFAULT_WHISPER_MODEL;
  const apiKey = options.apiKey ?? env.STT_API_KEY ?? 'none';
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    label: `${model} @ ${baseUrl}`,

    async transcribe(audio, mime, lang) {
      const form = new FormData();
      const file = new Blob([audio as unknown as BlobPart], { type: mime });
      form.append('file', file, `speech.${EXTENSION[mime] ?? 'wav'}`);
      form.append('model', model);
      form.append('response_format', 'json');
      if (lang && LANG_NAMES[lang]) form.append('language', lang);

      const response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`${model} at ${baseUrl} returned ${response.status}: ${detail}`);
      }
      const data = (await response.json()) as { text?: string };
      return clean(data.text ?? '');
    },
  };
}

/**
 * The testing client.
 *
 * A chat model asked for a transcript will sometimes answer the question it heard
 * instead, so the instruction says verbatim three different ways and the temperature is
 * zero. It still tidies grammar occasionally; that is a real limit of using a chat
 * model as an ASR, and one more reason this is the stand-in rather than the target.
 */
export function createGeminiSttClient(options: SttOptions = {}): SttClient {
  const env = globalThis.process?.env ?? {};
  const baseUrl = (options.baseUrl ?? env.STT_GEMINI_BASE ?? geminiNativeBase(env.LLM_BASE_URL)).replace(/\/+$/, '');
  const model = options.model ?? env.STT_MODEL ?? DEFAULT_GEMINI_STT_MODEL;
  const apiKey = options.apiKey ?? env.STT_API_KEY ?? env.LLM_API_KEY ?? '';
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    label: `${model} @ gemini (testing)`,

    async transcribe(audio, mime, lang) {
      const spoken = LANG_NAMES[lang ?? 'en'] ?? 'English';
      const script = SCRIPTS[lang ?? 'en'] ?? 'Latin script';
      const instruction =
        `Transcribe the speech in this recording word for word. The speaker is most ` +
        `likely speaking ${spoken}, possibly mixing in English words; write what you ` +
        `hear in ${script}. Return only the words spoken - no translation, no summary, ` +
        `no description of the audio, no quotation marks, and no answer to anything ` +
        `asked in it. If there is no intelligible speech, return exactly ${SILENCE}.`;

      const response = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: instruction },
              { inlineData: { mimeType: mime, data: Buffer.from(audio).toString('base64') } },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 512 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`${model} returned ${response.status}: ${detail}`);
      }
      const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        error?: { message?: string };
      };
      if (data.error?.message) throw new Error(`${model}: ${data.error.message}`);
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      return clean(parts.map((p) => p.text ?? '').join(' '));
    },
  };
}

/**
 * The .env already points LLM_BASE_URL at Gemini's OpenAI-compatible layer, which sits
 * one path segment below the native API. Deriving the native base from it keeps the key
 * and the endpoint configured once rather than twice.
 */
function geminiNativeBase(llmBaseUrl?: string): string {
  if (llmBaseUrl && /generativelanguage\.googleapis\.com/.test(llmBaseUrl)) {
    return llmBaseUrl.replace(/\/+$/, '').replace(/\/openai$/, '');
  }
  return DEFAULT_GEMINI_BASE;
}

/**
 * Which client, if any.
 *
 * Self-hosted wins whenever it is configured, because that is the one that will be in
 * production. Gemini is reached only when there is no STT_BASE_URL and a Gemini key
 * happens to be around for the language model already.
 *
 * Returning undefined is a normal outcome rather than an error: the console simply has
 * no microphone button, and typing still works.
 */
export function createSttClient(): SttClient | undefined {
  const env = globalThis.process?.env ?? {};
  const provider = env.STT_PROVIDER?.toLowerCase();

  if (provider === 'off' || provider === 'none') return undefined;
  if (provider === 'whisper' || env.STT_BASE_URL) return createWhisperClient();
  if (provider === 'gemini') return createGeminiSttClient();

  const geminiKey = env.STT_API_KEY
    ?? (/generativelanguage\.googleapis\.com/.test(env.LLM_BASE_URL ?? '') ? env.LLM_API_KEY : undefined);
  return geminiKey ? createGeminiSttClient({ apiKey: geminiKey }) : undefined;
}

/**
 * Reachability at boot - the same bargain probeServer makes. One request now beats a
 * visitor finding out by holding a microphone button down for ten seconds.
 */
export async function probeStt(client?: SttClient): Promise<{ reachable: boolean; detail: string }> {
  if (!client) {
    return { reachable: false, detail: 'no STT configured (set STT_BASE_URL, or a Gemini key for testing)' };
  }
  const env = globalThis.process?.env ?? {};

  if (client.label.endsWith('gemini (testing)')) {
    const base = (env.STT_GEMINI_BASE ?? geminiNativeBase(env.LLM_BASE_URL)).replace(/\/+$/, '');
    const model = env.STT_MODEL ?? DEFAULT_GEMINI_STT_MODEL;
    const apiKey = env.STT_API_KEY ?? env.LLM_API_KEY ?? '';
    try {
      const r = await fetch(`${base}/models/${encodeURIComponent(model)}`, {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(4000),
      });
      if (r.ok) return { reachable: true, detail: client.label };
      return { reachable: false, detail: `${model}: ${r.status} ${(await r.text()).slice(0, 120)}` };
    } catch (err) {
      return { reachable: false, detail: `${base}: ${(err as Error).message}` };
    }
  }

  const baseUrl = (env.STT_BASE_URL ?? DEFAULT_STT_URL).replace(/\/+$/, '');
  try {
    const r = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${env.STT_API_KEY ?? 'none'}` },
      signal: AbortSignal.timeout(4000),
    });
    return r.ok
      ? { reachable: true, detail: client.label }
      : { reachable: false, detail: `${baseUrl}/models returned ${r.status}` };
  } catch (err) {
    return { reachable: false, detail: `${baseUrl}: ${(err as Error).message}` };
  }
}
