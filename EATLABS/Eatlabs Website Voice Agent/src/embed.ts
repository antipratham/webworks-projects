/**
 * Dense retrieval: the half of search that reads the question rather than its words.
 *
 * BM25 cannot match "is this worth it if I'm already on Zomato?" to a section about
 * aggregator commissions, because they share no vocabulary. No synonym table fixes that
 * in general - every entry in it is a gap someone already tripped over. An embedding
 * compares meaning, so it closes the gaps nobody has hit yet.
 *
 * It does not replace BM25, and the reason is the same one that made BM25 the first
 * choice: this product's vocabulary is exact strings. "Petpooja", "DPDP", "35,000",
 * "Razorpay". Embeddings blur precisely those, which is why the two are fused rather
 * than swapped - see retrieve.ts.
 *
 * Any OpenAI-compatible /v1/embeddings endpoint serves this: vLLM and Hugging Face TEI
 * both do. Same shape as llm.ts - plain fetch, no SDK, and absent means absent rather
 * than broken.
 */

export const DEFAULT_EMBED_URL = 'http://127.0.0.1:8001/v1';
/** Multilingual on purpose: the agent answers in English, Hindi and Kannada. */
export const DEFAULT_EMBED_MODEL = 'BAAI/bge-m3';

export interface Embedder {
  readonly label: string;
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbedderOptions {
  baseUrl?: string;
  model?: string;
  env?: Record<string, string | undefined>;
}

export function createEmbedder(options: EmbedderOptions = {}): Embedder {
  const env = options.env ?? process.env;
  const baseUrl = (options.baseUrl ?? env.EMBED_BASE_URL ?? DEFAULT_EMBED_URL).replace(/\/+$/, '');
  const model = options.model ?? env.EMBED_MODEL ?? DEFAULT_EMBED_MODEL;

  return {
    label: `${model} @ ${baseUrl}`,
    model,
    async embed(texts: string[]): Promise<number[][]> {
      if (!texts.length) return [];
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`embeddings returned ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ embedding: number[]; index: number }> };
      const data = body.data ?? [];
      if (data.length !== texts.length) {
        throw new Error(`asked for ${texts.length} embeddings, got ${data.length}`);
      }
      // The API does not promise order; it promises an index on each row.
      const out: number[][] = new Array(texts.length);
      for (const row of data) out[row.index] = normalise(row.embedding);
      return out;
    },
  };
}

/**
 * Unit-length vectors, so similarity is a dot product and nothing downstream has to
 * remember to divide. Done once here rather than on every comparison.
 */
export function normalise(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum);
  if (!len) return v;
  return v.map((x) => x / len);
}

/** Cosine similarity of two already-normalised vectors. */
export function similarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export async function probeEmbedder(
  options: EmbedderOptions = {},
): Promise<{ reachable: boolean; detail: string }> {
  const env = options.env ?? process.env;
  const baseUrl = (options.baseUrl ?? env.EMBED_BASE_URL ?? DEFAULT_EMBED_URL).replace(/\/+$/, '');
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { reachable: false, detail: `${baseUrl}: HTTP ${res.status}` };
    return { reachable: true, detail: baseUrl };
  } catch (err) {
    return { reachable: false, detail: `${baseUrl}: ${(err as Error).message}` };
  }
}
