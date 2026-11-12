/**
 * The seam between the pipeline and the model server.
 *
 * Same server, same wire format and same defaults as menu-ai/src/llm.ts and the voice
 * agent's worker: an OpenAI-compatible vLLM endpoint serving Qwen3-30B-A3B. Plain
 * `fetch`, no SDK - the wire format is small and a self-hosted server should not drag
 * in a vendor client.
 *
 * This agent only ever asks for prose, so the structured-output machinery in menu-ai's
 * client is deliberately not carried over.
 */

// The one sentence every fail-closed path in answer.ts lands on. Imported rather than
// written out again here, so there is exactly one wording to keep right.
import { HANDOVER } from './answer.ts';

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<string>;
  /**
   * Token-by-token, for the console's speaker-armed mode where audio starts before the
   * reply is finished. Optional: a client without it is driven through `complete` and
   * the caller gets one chunk at the end, which still works, just not progressively.
   */
  stream?(req: LlmRequest): AsyncIterable<string>;
  readonly label: string;
}

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1';
export const DEFAULT_MODEL = 'Qwen/Qwen3-30B-A3B-Instruct-2507-FP8';

export interface QwenOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** Low: this agent quotes prices. Invention is the failure mode, not dullness. */
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Send vLLM-only request fields. Defaults to true for a local address, false otherwise. */
  vllmExtras?: boolean;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createQwenClient(options: QwenOptions = {}): LlmClient {
  const env = globalThis.process?.env ?? {};
  const baseUrl = (options.baseUrl ?? env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = options.model ?? env.LLM_MODEL ?? DEFAULT_MODEL;
  const apiKey = options.apiKey ?? env.LLM_API_KEY ?? 'none';
  const temperature = options.temperature ?? 0.2;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const maxRetries = options.maxRetries ?? 2;

  /**
   * `chat_template_kwargs` is vLLM's, not part of the OpenAI schema. A hosted
   * OpenAI-compatible endpoint - Gemini's, for instance - rejects the whole request for
   * an unknown field, so it is sent only to a local server. Override with
   * `LLM_VLLM_EXTRAS=1` or `0` when the guess by address is wrong.
   */
  const vllmExtras = options.vllmExtras
    ?? (env.LLM_VLLM_EXTRAS ? env.LLM_VLLM_EXTRAS !== '0' : /\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(baseUrl));

  const requestBody = (req: LlmRequest, stream: boolean) => ({
    model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    max_tokens: req.maxTokens,
    temperature,
    stream,
    // Matches the voice worker: harmless on an Instruct model, and it stops a
    // Thinking build reasoning out loud if LLM_MODEL is ever pointed at one.
    ...(vllmExtras ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  });

  return {
    label: `${model} @ ${baseUrl}`,

    /**
     * Server-sent events off the same endpoint. No retries here on purpose: once the
     * first token has been handed to the caller it may already have been spoken, and
     * retrying would say the opening of the answer twice.
     */
    async *stream(req: LlmRequest): AsyncIterable<string> {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(requestBody(req, true)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok || !response.body) {
        const detail = response.body ? (await response.text()).slice(0, 300) : 'no body';
        throw new Error(`${model} at ${baseUrl} returned ${response.status}: ${detail}`);
      }

      const decoder = new TextDecoder();
      let buffer = '';
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(bytes, { stream: true });
        // An SSE frame ends at a blank line; a chunk boundary can land mid-frame, so the
        // tail stays in the buffer until its terminator shows up.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const delta = (JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string | null } }>;
              }).choices?.[0]?.delta?.content;
              if (delta) yield delta;
            } catch {
              // A malformed frame is not worth failing the whole answer over.
            }
          }
        }
      }
    },

    async complete(req: LlmRequest): Promise<string> {
      const body = requestBody(req, false);

      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));

        let response: Response;
        try {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          lastError = new Error(`${model} at ${baseUrl}: ${(err as Error).message}`);
          continue;
        }

        if (!response.ok) {
          const detail = (await response.text()).slice(0, 300);
          const error = new Error(`${model} at ${baseUrl} returned ${response.status}: ${detail}`);
          if (!RETRYABLE.has(response.status)) throw error;
          lastError = error;
          continue;
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
          error?: { message?: string };
        };
        if (data.error?.message) throw new Error(`${model}: ${data.error.message}`);

        const choice = data.choices?.[0];
        if (!choice) throw new Error(`${model} returned no choices`);
        const text = (choice.message?.content ?? '').trim();
        if (!text) throw new Error(`${model} returned an empty message`);
        return text;
      }
      throw lastError ?? new Error('request failed');
    },
  };
}

/**
 * The no-model fallback, so the page is usable with nothing installed - the same
 * courtesy menu-ai's serve.ts extends with its rule-based stub.
 *
 * It does not try to write prose. It reads back the best passage, which for a KB of
 * answer-shaped chunks is a genuinely serviceable answer and is never invented.
 *
 * The open route (answer.ts) hands it a prompt with no passages at all, and there it
 * has nothing to read back. Small talk and off-topic questions need a model to answer
 * them; with none installed the honest result is the handover, so that is what it gives.
 */
export function createPassageClient(): LlmClient {
  const bestPassage = (system: string): string => {
    const first = system.split('Passages:\n')[1]?.split('\n\n[2]')[0] ?? '';
    const body = first.replace(/^\[\d+\]\s*.*\n/, '').trim();
    return body || HANDOVER;
  };

  return {
    label: 'no model — reading the best passage back',

    async complete(req: LlmRequest): Promise<string> {
      return bestPassage(req.system);
    },

    /**
     * Released a clause at a time, with a short pause between them. The pause is a test
     * aid, not an imitation of model latency: without it the whole answer lands in one
     * frame and the speaker-armed path in the console cannot actually be watched working.
     */
    async *stream(req: LlmRequest): AsyncIterable<string> {
      const parts = bestPassage(req.system).split(/(?<=[.!?,;:])\s+/);
      for (const [i, part] of parts.entries()) {
        if (i > 0) await sleep(110);
        yield i === 0 ? part : ` ${part}`;
      }
    },
  };
}

export async function probeServer(
  options: Pick<QwenOptions, 'baseUrl' | 'apiKey' | 'timeoutMs'> = {},
): Promise<{ reachable: boolean; models: string[]; detail: string }> {
  const env = globalThis.process?.env ?? {};
  const baseUrl = (options.baseUrl ?? env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = options.apiKey ?? env.LLM_API_KEY ?? 'none';
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 4000),
    });
    if (!response.ok) return { reachable: false, models: [], detail: `${baseUrl}/models returned ${response.status}` };
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    // A local vLLM serves one model and listing it is useful. A hosted endpoint lists
    // everything the account can reach - Gemini returns about sixty - and printing that
    // at boot buries the three lines underneath it that actually matter.
    const shown = models.length > 3
      ? `${models.slice(0, 3).join(', ')} and ${models.length - 3} more`
      : models.join(', ') || 'nothing';
    return { reachable: true, models, detail: `${baseUrl} serving ${shown}` };
  } catch (err) {
    return { reachable: false, models: [], detail: `${baseUrl}: ${(err as Error).message}` };
  }
}
