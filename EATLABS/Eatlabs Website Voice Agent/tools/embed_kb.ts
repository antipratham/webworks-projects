/**
 * Embed the knowledge base for dense retrieval.
 *
 *   EMBED_BASE_URL=http://127.0.0.1:8001/v1 node tools/embed_kb.ts
 *
 * Writes kb.vectors.jsonl beside kb.jsonl, one {id, v} per line. Run it after any change
 * that rebuilds kb.jsonl - the vectors are a cache of the text, and a stale cache is a
 * chunk answering as the paragraph it used to be.
 *
 * What gets embedded is the heading, the spoken line and the text together. The heading
 * because it is usually the question restated, and the spoken line because it is the
 * same fact in the words a person would actually use - which is the register a visitor's
 * question arrives in.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEmbedder, probeEmbedder } from '../src/embed.ts';
import { loadChunks, type Chunk } from '../src/retrieve.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const KB = here('../kb.jsonl');
const OUT = here('../kb.vectors.jsonl');

/** Sized to keep a request well inside the timeout on a single modest GPU. */
const BATCH = 32;

function passage(c: Chunk): string {
  return `${c.heading}\n${c.spoken ?? ''}\n${c.text}`.trim();
}

const probe = await probeEmbedder();
if (!probe.reachable) {
  console.error(`no embedding endpoint at ${probe.detail}`);
  console.error('start one, or set EMBED_BASE_URL. Retrieval stays lexical until then.');
  process.exit(2);
}

const embedder = createEmbedder();
const chunks = loadChunks(KB);
console.log(`${chunks.length} chunks -> ${embedder.label}`);

const lines: string[] = [];
for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  const vectors = await embedder.embed(batch.map(passage));
  batch.forEach((c, j) => lines.push(JSON.stringify({ id: c.id, v: vectors[j] })));
  console.log(`  ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
}

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

const dims = JSON.parse(lines[0]).v.length;
console.log(`wrote ${lines.length} vectors of ${dims} dimensions -> ${OUT}`);
console.log('kb.vectors.jsonl is generated. Rebuild it whenever kb.jsonl changes.');
