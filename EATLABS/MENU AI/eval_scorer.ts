/**
 * eval_scorer.ts
 *
 * Runs eval_dataset.json against the real Stage 1 parser and scores it field by
 * field against the expected filter, per query. The scoring logic is unchanged from
 * the version supplied with the dataset; what has been added is the wiring
 * (parseIntent takes an LlmClient and returns a validated result, not a bare
 * filter), the optional extension fields, and the pipeline behaviour columns.
 *
 *   node eval_scorer.ts                          # label "unlabeled-run", eval_dataset.json
 *   node eval_scorer.ts qwen3-30b                # labelled, for comparing runs
 *   node eval_scorer.ts qwen3-30b eval_dataset_extra.json
 *   node eval_scorer.ts qwen3-30b eval_dataset.json --pipeline
 *
 * --pipeline additionally runs Stage 2, Stage 2b and Stage 3 for every query and
 * reports what the guest would actually have been shown. It costs a second model
 * call per query; without it only Stage 1 runs.
 */

import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { parseIntent, EMPTY_FILTER } from './src/intent_parser.ts';
import { createQwenClient, DEFAULT_MODEL, probeServer } from './src/llm.ts';
import { createConcierge } from './src/concierge.ts';
import { createFileLogger } from './src/logger.ts';
import { loadMenuFromFile } from './src/menu_loader.ts';
import { screenRequest } from './src/safety.ts';
import type { ParsedFilter } from './src/types.ts';

// ---- types (mirror the ParsedFilter shape the dataset was written against) ----
interface EvalQuery {
  id: string;
  category: string;
  query: string;
  expected_filter: Record<string, any>;
  expected_match_type: string;
  notes: string;
}

// ---- scoring ----
function setEqual(a: string[], b: string[]): boolean {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return JSON.stringify(sa) === JSON.stringify(sb);
}

/**
 * Six fields are always scored - the contract the dataset was written against.
 * Any of the extension fields (weight, party_size, request_kind) is scored only
 * when the expected filter declares it, so the original 44 score exactly as before.
 */
function scoreOne(expected: Record<string, any>, actual: ParsedFilter) {
  const fields: { name: string; ok: boolean }[] = [];
  fields.push({ name: 'dietary_include', ok: setEqual(expected.dietary_include ?? [], actual.dietary_include || []) });
  fields.push({ name: 'dietary_exclude', ok: setEqual(expected.dietary_exclude ?? [], actual.dietary_exclude || []) });
  fields.push({ name: 'course', ok: (expected.course ?? null) === (actual.course ?? null) });
  fields.push({ name: 'sort_by', ok: (expected.sort_by ?? null) === (actual.sort_by ?? null) });
  fields.push({ name: 'max_price_paise', ok: (expected.max_price_paise ?? null) === (actual.max_price_paise ?? null) });

  const expTasteKeys = Object.keys(expected.taste_preferences || {}).sort();
  const actTaste = actual.taste_preferences || {};
  const actTasteKeys = Object.keys(actTaste).sort();
  const keysMatch = JSON.stringify(expTasteKeys) === JSON.stringify(actTasteKeys);
  let valuesMatch = true;
  for (const k of expTasteKeys) {
    if ((expected.taste_preferences as any)[k] !== (actTaste as any)[k]) valuesMatch = false;
  }
  fields.push({ name: 'taste_preferences', ok: keysMatch && valuesMatch });

  for (const extra of ['weight', 'party_size', 'request_kind'] as const) {
    if (expected[extra] === undefined) continue;
    fields.push({ name: extra, ok: expected[extra] === (actual[extra] ?? null) });
  }

  const passCount = fields.filter((f) => f.ok).length;
  return { fields, score: passCount / fields.length, perfect: passCount === fields.length };
}

/**
 * The dataset's match-type vocabulary predates the "show similar listings" rule, so
 * it is compared loosely and reported rather than scored. "empty" and "relaxed" both
 * mean the strict filter matched nothing; what differs is what the guest is then
 * shown, and this build always shows the nearest real dishes.
 */
function matchTypeAgrees(expected: string, actual: string, exactCount: number): boolean {
  switch (expected) {
    case 'exact':
      return exactCount > 0;
    case 'empty':
    case 'relaxed':
      return exactCount === 0;
    case 'clarification':
      return actual === 'clarification';
    case 'fallback_default':
      return actual === 'fallback_default' || exactCount > 0;
    case 'guardrail_hold':
      return true; // judged by the guardrail columns, not by the match type
    default:
      return expected === actual;
  }
}

// ---- runner ----
async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
  const modelLabel = args[0] || 'unlabeled-run';
  const datasetPath = args[1] || 'eval_dataset.json';
  const runPipeline = flags.has('--pipeline');

  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
  const queries: EvalQuery[] = dataset.queries;

  const probe = await probeServer();
  if (!probe.reachable) {
    console.error(`Model server unreachable: ${probe.detail}`);
    console.error('Set LLM_BASE_URL (and LLM_MODEL) and try again.');
    process.exit(1);
  }
  const model = process.env.LLM_MODEL ?? DEFAULT_MODEL;
  console.log(`${queries.length} queries from ${datasetPath} against ${model}`);
  console.log(`${probe.detail}\n`);

  // Stage 1 is extraction, so it runs deterministically. Stage 3 is prose.
  const intentLlm = createQwenClient({ temperature: 0 });
  const logger = createFileLogger('logs/intent.jsonl');
  const menuPath = fileURLToPath(new URL('./menu_database_200items.json', import.meta.url));
  const menu = (await loadMenuFromFile(menuPath)).menu;
  const concierge = createConcierge({
    intentLlm,
    responseLlm: createQwenClient({ temperature: 0.3 }),
    logger,
    outletId: 'eval',
  });

  const results: any[] = [];
  const byCategory: Record<string, { total: number; sumScore: number; perfect: number }> = {};

  for (const q of queries) {
    let actual: ParsedFilter = { ...EMPTY_FILTER, taste_preferences: {}, unexpressed: [] };
    let error: string | null = null;
    let attempts = 0;
    let pipeline: Record<string, unknown> | null = null;

    const start = Date.now();
    try {
      // The safety screen runs before Stage 1 in production, so it runs here too:
      // an abusive query is never parsed, and its filter stays empty by design.
      const screened = screenRequest(q.query);
      if (screened.kind === 'ABUSIVE') {
        actual = { ...actual, request_kind: 'ABUSIVE' };
      } else {
        const parsed = await parseIntent({ llm: intentLlm, query: q.query, logger, outletId: 'eval' });
        attempts = parsed.attempts;
        if (parsed.ok) actual = parsed.filter;
        else error = parsed.errors.join('; ');
      }

      if (runPipeline) {
        const result = await concierge(q.query, menu);
        pipeline = {
          match_type: result.matchType,
          exact_count: result.exactCount,
          relaxed: result.relaxed,
          shown: result.items.map((i) => i.name),
          sections: result.sections.map((s) => `${s.label}:${s.items.length}/${s.totalMatches}`),
          used_fallback: result.usedFallback,
          guardrail_failures: result.guardrailFailures,
          match_type_agrees: matchTypeAgrees(q.expected_match_type, result.matchType, result.exactCount),
        };
      }
    } catch (e: any) {
      error = String(e?.message || e);
    }
    const latencyMs = Date.now() - start;
    const { fields, score, perfect } = scoreOne(q.expected_filter, actual);

    if (!byCategory[q.category]) byCategory[q.category] = { total: 0, sumScore: 0, perfect: 0 };
    byCategory[q.category]!.total += 1;
    byCategory[q.category]!.sumScore += score;
    if (perfect) byCategory[q.category]!.perfect += 1;

    results.push({
      id: q.id,
      category: q.category,
      query: q.query,
      expected_match_type: q.expected_match_type,
      score,
      perfect,
      error,
      attempts,
      latencyMs,
      failing_fields: fields.filter((f) => !f.ok).map((f) => f.name),
      expected: q.expected_filter,
      actual,
      pipeline,
      notes: q.notes,
    });

    const flag = perfect ? 'PASS' : error ? 'ERROR' : 'FAIL';
    console.log(`[${flag}] ${q.id} (${q.category}) score=${score.toFixed(2)} "${q.query}"`);
    if (!perfect && !error) {
      console.log(`        failing: ${fields.filter((f) => !f.ok).map((f) => f.name).join(', ')}`);
      for (const f of fields.filter((x) => !x.ok)) {
        const exp = JSON.stringify((q.expected_filter as any)[f.name] ?? null);
        const act = JSON.stringify((actual as any)[f.name] ?? null);
        console.log(`          ${f.name}: expected ${exp}, got ${act}`);
      }
    }
    if (error) console.log(`        error: ${error}`);
    if (pipeline) {
      console.log(
        `        shown: ${(pipeline.shown as string[]).join(', ') || '(nothing)'}` +
          `  [${(pipeline.sections as string[]).join(' ')}]`,
      );
      if ((pipeline.guardrail_failures as string[]).length > 0) {
        console.log(`        guardrail held: ${(pipeline.guardrail_failures as string[]).join('; ')}`);
      }
    }
  }

  // adversarial safety cases get a hard callout regardless of aggregate score
  const adversarialFails = results.filter((r) => r.category === 'adversarial' && !r.perfect);
  const highStakes = results.find((r) => r.id === 'Q040' && !r.perfect);

  console.log('\n=== Summary by category ===');
  for (const [cat, s] of Object.entries(byCategory)) {
    const avg = (s.sumScore / s.total) * 100;
    console.log(`${cat.padEnd(18)} avg_field_score=${avg.toFixed(1)}%  perfect=${s.perfect}/${s.total}`);
  }

  const overallAvg = (results.reduce((sum, r) => sum + r.score, 0) / results.length) * 100;
  const overallPerfect = results.filter((r) => r.perfect).length;
  console.log(`\nOverall: avg_field_score=${overallAvg.toFixed(1)}%  perfect=${overallPerfect}/${results.length}`);

  const retried = results.filter((r) => r.attempts > 1).length;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  console.log(
    `Stage 1 retries: ${retried}/${results.length}   latency p50=${latencies[Math.floor(latencies.length / 2)]}ms p95=${latencies[Math.floor(latencies.length * 0.95)]}ms`,
  );

  if (runPipeline) {
    const agreed = results.filter((r) => r.pipeline?.match_type_agrees).length;
    const guardrailHeld = results.filter((r) => (r.pipeline?.guardrail_failures ?? []).length > 0).length;
    const templated = results.filter((r) => r.pipeline?.used_fallback).length;
    console.log(`Match type agrees: ${agreed}/${results.length}`);
    console.log(`Answers from the template rather than the model: ${templated}/${results.length}`);
    console.log(`Drafts the guardrail rejected: ${guardrailHeld}`);
  }

  if (highStakes) {
    console.log('\n!!! Q040 (dairy-allergy safety case) did not parse perfectly. Do not ship until this is exact. !!!');
  }
  if (adversarialFails.length > 0) {
    console.log(`\n${adversarialFails.length} adversarial case(s) failed - review before comparing model choices on aggregate score alone.`);
  }

  // append a row to a running comparison log so multiple models/prompt versions can be compared over time
  const logLine = {
    timestamp: new Date().toISOString(),
    label: modelLabel,
    model,
    dataset: datasetPath,
    overall_avg_field_score: Number(overallAvg.toFixed(2)),
    overall_perfect: overallPerfect,
    total: results.length,
    by_category: Object.fromEntries(
      Object.entries(byCategory).map(([cat, s]) => [cat, Number(((s.sumScore / s.total) * 100).toFixed(2))]),
    ),
  };
  fs.mkdirSync('logs', { recursive: true });
  fs.appendFileSync('logs/eval_runs.jsonl', JSON.stringify(logLine) + '\n');

  fs.writeFileSync(`logs/eval_detail_${modelLabel}_${Date.now()}.json`, JSON.stringify(results, null, 2));
  console.log(`\nDetail written to logs/eval_detail_${modelLabel}_*.json`);
  console.log('Run summary appended to logs/eval_runs.jsonl (compare across models/prompt versions here)');
}

main();
