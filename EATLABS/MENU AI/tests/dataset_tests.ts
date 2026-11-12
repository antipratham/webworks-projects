/**
 * Dataset tests.
 *
 * Takes every expected_filter in both eval datasets and runs it through Stage 2 and
 * Stage 2b as if Stage 1 had parsed the query perfectly. Two things fall out:
 *
 *   - the deterministic half of the pipeline is evaluated over ~70 real queries
 *     without a model, a GPU or a network;
 *   - the datasets themselves are checked, so an expected_match_type that no longer
 *     describes what the menu contains fails here rather than silently skewing a
 *     model score later.
 *
 * A failure here means either the filter rules are wrong or the dataset is. Both are
 * worth knowing before any model is blamed.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EMPTY_FILTER } from '../src/intent_parser.ts';
import { loadMenuFromFile } from '../src/menu_loader.ts';
import { findMatches } from '../src/similarity.ts';
import { filterMenu } from '../src/menu_filter.ts';
import { checkResponse, templatedResponse } from '../src/response_generator.ts';
import { screenRequest } from '../src/safety.ts';
import type { MenuItem, ParsedFilter } from '../src/types.ts';

interface EvalQuery {
  id: string;
  category: string;
  query: string;
  expected_filter: Record<string, any>;
  expected_match_type: string;
  notes: string;
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const MENU: MenuItem[] = (await loadMenuFromFile(here('../menu_database_200items.json'))).menu;

const datasets: Array<{ name: string; queries: EvalQuery[] }> = [
  { name: 'eval_dataset.json', queries: JSON.parse(readFileSync(here('../eval_dataset.json'), 'utf8')).queries },
  {
    name: 'eval_dataset_extra.json',
    queries: JSON.parse(readFileSync(here('../eval_dataset_extra.json'), 'utf8')).queries,
  },
];

/** The dataset writes only the fields it cares about; the rest take their defaults. */
function toFilter(expected: Record<string, any>): ParsedFilter {
  return {
    ...EMPTY_FILTER,
    dietary_include: expected.dietary_include ?? [],
    dietary_exclude: expected.dietary_exclude ?? [],
    course: expected.course ?? null,
    taste_preferences: expected.taste_preferences ?? {},
    sort_by: expected.sort_by ?? null,
    max_price_paise: expected.max_price_paise ?? null,
    weight: expected.weight ?? null,
    party_size: expected.party_size ?? null,
    request_kind: expected.request_kind ?? 'MENU',
    unexpressed: [],
  };
}

/**
 * Cases where eval_dataset.json's expected_match_type does not describe this menu.
 *
 * Each was checked against menu_database_200items.json by hand. None of them affects
 * the model's score - the scorer grades expected_filter, and every filter here is
 * correct - but the match-type column would mislead anyone reading a run, so the
 * real count is pinned instead. If a filter rule changes, these fail and get
 * re-examined rather than drifting quietly.
 *
 * These belong to the supplied dataset, so they are recorded here rather than
 * edited there.
 */
const DATASET_DISCREPANCIES: Record<string, { exactCount: number; why: string }> = {
  Q007: {
    exactCount: 21,
    why: 'expects "relaxed", but 21 items are both vegan and gluten_free on this menu',
  },
  Q018: {
    exactCount: 1,
    why: 'expects "empty", but Black Coffee is scored bitter 2, so one item matches bitter high',
  },
  Q031: {
    exactCount: 12,
    why: 'expects "relaxed", but 12 items are vegan, spicy_warm and at or under 350 rupees',
  },
  Q032: {
    exactCount: 1,
    why: 'expects "empty", but Phirni is a ranked dairy-free dessert scored sweet 2',
  },
  Q043: {
    exactCount: 25,
    why: 'expected_filter and expected_match_type disagree: the filter is only "vegan", which matches 25 items. The unsatisfiable part is the dish name, which the taxonomy cannot carry - it belongs in unexpressed, making this a clarification rather than an empty result',
  },
};

/**
 * "empty" and "relaxed" both describe a strict filter that matched nothing; they
 * differ only in what the dataset's author expected to happen next, and this build
 * always shows the nearest real dishes. So both are satisfied by exactCount === 0.
 */
function expectationHolds(expected: string, exactCount: number): boolean {
  switch (expected) {
    case 'exact':
    case 'fallback_default':
    case 'clarification':
    case 'guardrail_hold':
      return exactCount > 0;
    case 'empty':
    case 'relaxed':
      return exactCount === 0;
    default:
      return true;
  }
}

let checked = 0;
let passed = 0;
const failures: string[] = [];
const discrepancies: string[] = [];
const note = (line: string) => console.log(line);

for (const dataset of datasets) {
  note(`\n=== ${dataset.name} (${dataset.queries.length} queries) ===`);

  for (const q of dataset.queries) {
    const filter = toFilter(q.expected_filter);

    // Abusive and off-topic requests never reach Stage 2, so they are checked at the
    // screen instead: the deterministic list must catch everything marked abusive.
    if (q.expected_match_type === 'abusive') {
      checked++;
      const screened = screenRequest(q.query);
      if (screened.kind === 'ABUSIVE') {
        passed++;
        note(`  ok  ${q.id} screened as abusive (${screened.reason})`);
      } else {
        failures.push(`${q.id}: "${q.query}" was not caught by the abuse screen`);
        note(`FAIL  ${q.id} not screened as abusive`);
      }
      continue;
    }
    if (q.expected_match_type === 'off_topic') {
      checked++;
      const screened = screenRequest(q.query);
      if (screened.kind === 'MENU') {
        passed++;
        note(`  ok  ${q.id} left to Stage 1 to classify, as an off-topic request should be`);
      } else {
        failures.push(`${q.id}: "${q.query}" was wrongly flagged as abusive by the word list`);
        note(`FAIL  ${q.id} wrongly screened as abusive`);
      }
      continue;
    }

    checked++;
    const match = findMatches(MENU, filter);

    const discrepancy = DATASET_DISCREPANCIES[q.id];
    if (discrepancy) {
      if (match.exactCount === discrepancy.exactCount) {
        passed++;
        discrepancies.push(`${q.id}: ${discrepancy.why}`);
        note(`  ok  ${q.id} ${'[dataset]'.padEnd(16)} exact=${match.exactCount} - pinned, see the note`);
      } else {
        failures.push(
          `${q.id}: pinned at ${discrepancy.exactCount} exact matches but got ${match.exactCount} - a filter rule changed, re-check the pin`,
        );
        note(`FAIL  ${q.id} pinned count moved: ${discrepancy.exactCount} -> ${match.exactCount}`);
      }
      continue;
    }

    const held = expectationHolds(q.expected_match_type, match.exactCount);

    if (held) {
      passed++;
      const shown = match.items.map((s) => s.item.name).slice(0, 3).join(', ');
      const sections = match.sections.map((s) => `${s.course}:${s.items.length}/${s.totalMatches}`).join(' ');
      note(
        `  ok  ${q.id} ${q.expected_match_type.padEnd(16)} exact=${String(match.exactCount).padEnd(3)} ${sections}  ${shown}`,
      );
    } else {
      failures.push(
        `${q.id} (${q.expected_match_type}): "${q.query}" matched ${match.exactCount} items, which contradicts the dataset`,
      );
      note(`FAIL  ${q.id} expected ${q.expected_match_type}, got ${match.exactCount} exact matches`);
    }

    // Whatever the match type, the deterministic answer must survive the guardrail.
    if (match.items.length > 0) {
      const message = templatedResponse(match, true);
      const guardrail = checkResponse({
        text: message,
        allowed: match.items.map((s) => s.item),
        menu: MENU,
      });
      if (guardrail.length > 0) {
        failures.push(`${q.id}: the templated answer failed its own guardrail - ${guardrail.join('; ')}`);
        note(`FAIL  ${q.id} templated answer failed the guardrail`);
      }
    }

    // A safety constraint must survive relaxation, on every query that has one.
    const excludedAllergens = filter.dietary_exclude;
    for (const scored of match.items) {
      for (const value of excludedAllergens) {
        const violates =
          scored.item.allergens.includes(value as never) || scored.item.dietary.includes(value as never);
        if (violates) {
          failures.push(`${q.id}: ${scored.item.name} violates the excluded "${value}"`);
        }
      }
      for (const tag of filter.dietary_include) {
        if (!scored.item.dietary.includes(tag)) {
          failures.push(`${q.id}: ${scored.item.name} is missing the required "${tag}"`);
        }
      }
    }
  }
}

console.log(`\n${passed}/${checked} dataset expectations hold`);

if (discrepancies.length > 0) {
  console.log(
    `\n${discrepancies.length} case(s) where eval_dataset.json's expected_match_type does not describe this menu.`,
  );
  console.log('The expected_filter is correct in every one, so no model score is affected:');
  for (const d of discrepancies) console.log(`  - ${d}`);
}

if (failures.length > 0) {
  console.error('\nFailures:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
