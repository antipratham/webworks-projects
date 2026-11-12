/**
 * The seam between the pipeline and the model server.
 *
 * Stage 1 and Stage 3 each take an `LlmClient`, so either can be pointed at a
 * different model, given different sampling, or mocked in tests, without the other
 * knowing.
 *
 * The implementation here talks to the same vLLM server the voice agent uses
 * (eatlabs-llm-voice, agent/lk/worker.py): an OpenAI-compatible endpoint serving
 * Qwen/Qwen3-30B-A3B-Instruct-2507-FP8. Plain `fetch`, no SDK - the wire format is
 * small, and a self-hosted server should not drag in a vendor client.
 */

export interface ResponseSchema {
  name: string;
  description: string;
  /** JSON Schema the reply must satisfy. */
  schema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  /**
   * When set, the reply must be JSON matching this schema. Stage 1 uses it; Stage 3
   * returns prose. How it is enforced on the wire is the client's business.
   */
  responseSchema?: ResponseSchema;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<string>;
}

/**
 * How a schema-constrained reply is requested from the server:
 *   json_schema - `response_format`, grammar-constrained decoding. Correct by
 *                 construction, and the default: a 3B-active model benefits most
 *                 from not being able to emit an invalid token in the first place.
 *   tool        - OpenAI function calling. Needs vLLM started with
 *                 `--enable-auto-tool-choice --tool-call-parser hermes`.
 *   prompt      - the schema goes in the prompt and the JSON is parsed out. Works
 *                 against any server; the weakest guarantee.
 */
export type StructuredMode = 'json_schema' | 'tool' | 'prompt';

export interface QwenClientOptions {
  /** OpenAI-compatible base URL, including /v1. Defaults to $LLM_BASE_URL. */
  baseUrl?: string;
  /** Defaults to $LLM_MODEL. */
  model?: string;
  /** vLLM ignores this unless started with --api-key. Defaults to $LLM_API_KEY. */
  apiKey?: string;
  /** 0 for parsing, a little higher for prose. */
  temperature?: number;
  topP?: number;
  structuredMode?: StructuredMode;
  /** Per-request timeout in milliseconds. A guest is waiting. */
  timeoutMs?: number;
  /** Retries on a timeout, a network error, or a 429/5xx. */
  maxRetries?: number;
}

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1';
export const DEFAULT_MODEL = 'Qwen/Qwen3-30B-A3B-Instruct-2507-FP8';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  };
  finish_reason?: string;
}

interface ChatResponse {
  choices?: ChatChoice[];
  error?: { message?: string };
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createQwenClient(options: QwenClientOptions = {}): LlmClient {
  const env = globalThis.process?.env ?? {};
  const baseUrl = (options.baseUrl ?? env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = options.model ?? env.LLM_MODEL ?? DEFAULT_MODEL;
  const apiKey = options.apiKey ?? env.LLM_API_KEY ?? 'none';
  const temperature = options.temperature ?? 0.25;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxRetries = options.maxRetries ?? 2;

  // Downgraded once, for the life of the client, if the server rejects the
  // structured-output field - older vLLM builds do not carry it.
  let structuredMode: StructuredMode = options.structuredMode ?? 'json_schema';
  let downgraded = false;

  function buildBody(req: LlmRequest, mode: StructuredMode): Record<string, unknown> {
    const messages: ChatMessage[] = [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ];

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: req.maxTokens,
      temperature,
      // Matches the voice agent's worker: harmless on an Instruct model, and it keeps
      // a Thinking build from reasoning out loud if LLM_MODEL is ever pointed at one.
      chat_template_kwargs: { enable_thinking: false },
    };
    if (options.topP !== undefined) body.top_p = options.topP;

    if (!req.responseSchema) return body;

    if (mode === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: req.responseSchema.name,
          description: req.responseSchema.description,
          schema: req.responseSchema.schema,
          strict: true,
        },
      };
      return body;
    }

    if (mode === 'tool') {
      body.tools = [
        {
          type: 'function',
          function: {
            name: req.responseSchema.name,
            description: req.responseSchema.description,
            parameters: req.responseSchema.schema,
          },
        },
      ];
      body.tool_choice = {
        type: 'function',
        function: { name: req.responseSchema.name },
      };
      return body;
    }

    // prompt mode: the schema travels in the message, and the reply is parsed out.
    messages[1] = {
      role: 'user',
      content: `${req.user}\n\nReply with JSON only - no prose, no code fence - matching this schema exactly:\n${JSON.stringify(
        req.responseSchema.schema,
      )}`,
    };
    return body;
  }

  async function post(body: Record<string, unknown>): Promise<ChatResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Network error or timeout: worth another go.
        lastError = new Error(`${model} at ${baseUrl}: ${(err as Error).message}`);
        continue;
      }

      if (response.ok) return (await response.json()) as ChatResponse;

      const detail = (await response.text()).slice(0, 500);
      const error = new Error(`${model} at ${baseUrl} returned ${response.status}: ${detail}`);
      (error as Error & { status?: number }).status = response.status;
      if (!RETRYABLE_STATUS.has(response.status)) throw error;
      lastError = error;
    }

    throw lastError ?? new Error('request failed');
  }

  /** A 400 naming the structured-output field means this server build lacks it. */
  function isUnsupportedStructuredOutput(err: unknown): boolean {
    const status = (err as { status?: number }).status;
    if (status !== 400 && status !== 404 && status !== 422) return false;
    return /response_format|json_schema|guided|tool_choice|tools|grammar/i.test(
      (err as Error).message ?? '',
    );
  }

  return {
    async complete(req: LlmRequest): Promise<string> {
      let data: ChatResponse;
      try {
        data = await post(buildBody(req, structuredMode));
      } catch (err) {
        if (req.responseSchema && !downgraded && isUnsupportedStructuredOutput(err)) {
          downgraded = true;
          const previous = structuredMode;
          structuredMode = 'prompt';
          console.warn(
            `[llm] ${baseUrl} rejected ${previous} structured output; falling back to prompt mode. ` +
              'Enable grammar-constrained decoding on the server for a stronger guarantee.',
          );
          data = await post(buildBody(req, structuredMode));
        } else {
          throw err;
        }
      }

      if (data.error?.message) throw new Error(`${model}: ${data.error.message}`);

      const choice = data.choices?.[0];
      if (!choice) throw new Error(`${model} returned no choices`);

      if (choice.finish_reason === 'length') {
        throw new Error(`${model} hit the token limit before finishing its answer`);
      }

      // Tool mode puts the JSON in the call's arguments rather than in the content.
      const toolCall = choice.message?.tool_calls?.[0];
      if (req.responseSchema && toolCall?.function?.arguments) {
        return toolCall.function.arguments;
      }

      const text = (choice.message?.content ?? '').trim();
      if (!text) throw new Error(`${model} returned an empty message`);
      return text;
    },
  };
}

/** Confirms the server is up and serving the expected model. Used by the demo. */
export async function probeServer(
  options: Pick<QwenClientOptions, 'baseUrl' | 'apiKey' | 'timeoutMs'> = {},
): Promise<{ reachable: boolean; models: string[]; detail: string }> {
  const env = globalThis.process?.env ?? {};
  const baseUrl = (options.baseUrl ?? env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = options.apiKey ?? env.LLM_API_KEY ?? 'none';
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    if (!response.ok) {
      return { reachable: false, models: [], detail: `${baseUrl}/models returned ${response.status}` };
    }
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    return { reachable: true, models, detail: `${baseUrl} serving ${models.join(', ') || 'nothing'}` };
  } catch (err) {
    return { reachable: false, models: [], detail: `${baseUrl}: ${(err as Error).message}` };
  }
}
