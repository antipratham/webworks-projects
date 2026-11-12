/**
 * STAGE 2b - Relax and rank ("no direct match, here is the closest thing").
 *
 * Still pure code, still no LLM. When the exact filter returns nothing, the guest
 * should not be told "no" and left there - they should be shown the nearest real
 * dishes, together with an honest account of what those dishes do not satisfy.
 *
 * Two rules govern this file:
 *   1. Dietary requirements and allergen exclusions are NEVER relaxed. An allergy is
 *      not a preference. Only taste, flavour, weight, course and price are negotiable.
 *   2. Every relaxation is recorded and reported, so the answer can say what it gave
 *      up rather than quietly pretending the near-match was what was asked for.
 */

import type { MatchResult, MenuItem, ParsedFilter, RelaxableConstraint, ScoredItem } from './types.ts';
import { filterMenu, tagWeight, totalWeight } from './menu_filter.ts';
import {
  COURSE_LABEL,
  TASTE_LEVEL_RANGE,
  TASTE_LEVEL_TARGET,
  isBasicTaste,
  isFlavorNote,
} from './taxonomy.ts';
import type { BasicTaste, FlavorNote, TasteLevel } from './taxonomy.ts';
import { selectSections } from './sections.ts';
import { formatRupees, humanTag } from './format.ts';

/**
 * The order constraints are given up in: least important to the guest first. Dietary
 * and allergen constraints are deliberately absent - they are not on this ladder.
 */
export const RELAXATION_LADDER: RelaxableConstraint[] = [
  'price',
  'weight',
  'basic_tastes',
  'flavor_notes_wanted',
  'course',
  'flavor_notes_avoided',
];

function splitTastePreferences(filter: ParsedFilter): {
  basic: Array<[BasicTaste, TasteLevel]>;
  wanted: FlavorNote[];
  avoided: FlavorNote[];
} {
  const basic: Array<[BasicTaste, TasteLevel]> = [];
  const wanted: FlavorNote[] = [];
  const avoided: FlavorNote[] = [];
  for (const [key, value] of Object.entries(filter.taste_preferences)) {
    if (isBasicTaste(key)) basic.push([key, value as TasteLevel]);
    else if (isFlavorNote(key)) (value === true ? wanted : avoided).push(key);
  }
  return { basic, wanted, avoided };
}

/** Returns a copy of `filter` with the named constraints removed. */
export function relaxFilter(filter: ParsedFilter, drop: RelaxableConstraint[]): ParsedFilter {
  const { basic, wanted, avoided } = splitTastePreferences(filter);
  const dropped = new Set(drop);

  const taste_preferences: ParsedFilter['taste_preferences'] = {};
  if (!dropped.has('basic_tastes')) for (const [k, v] of basic) taste_preferences[k] = v;
  if (!dropped.has('flavor_notes_wanted')) for (const n of wanted) taste_preferences[n] = true;
  if (!dropped.has('flavor_notes_avoided')) for (const n of avoided) taste_preferences[n] = false;

  return {
    ...filter,
    dietary_include: [...filter.dietary_include],
    dietary_exclude: [...filter.dietary_exclude],
    taste_preferences,
    course: dropped.has('course') ? null : filter.course,
    weight: dropped.has('weight') ? null : filter.weight,
    max_price_paise: dropped.has('price') ? null : filter.max_price_paise,
  };
}

/** Which rungs of the ladder this filter actually uses - dropping an unused one is a no-op. */
function activeConstraints(filter: ParsedFilter): RelaxableConstraint[] {
  const { basic, wanted, avoided } = splitTastePreferences(filter);
  const active = new Set<RelaxableConstraint>();
  if (filter.max_price_paise !== null) active.add('price');
  if (filter.weight !== null) active.add('weight');
  if (basic.length > 0) active.add('basic_tastes');
  if (wanted.length > 0) active.add('flavor_notes_wanted');
  if (filter.course !== null) active.add('course');
  if (avoided.length > 0) active.add('flavor_notes_avoided');
  return RELAXATION_LADDER.filter((c) => active.has(c));
}

interface Criterion {
  weight: number;
  achieved: number;
  shortfall: string | null;
}

/**
 * Scores one item against the guest's ORIGINAL request - not the relaxed one - so
 * the near-matches are ordered by how close they actually are to what was asked.
 */
export function scoreItem(item: MenuItem, filter: ParsedFilter): ScoredItem {
  const criteria: Criterion[] = [];

  if (filter.course !== null) {
    const ok = item.course === filter.course;
    criteria.push({
      weight: 2,
      achieved: ok ? 2 : 0,
      shortfall: ok ? null : `it is a ${item.course}, not ${COURSE_LABEL[filter.course].toLowerCase()}`,
    });
  }

  if (filter.weight !== null) {
    const score = filter.course !== null ? tagWeight(item) : totalWeight(item);
    const max = filter.course !== null ? 3 : 6;
    const wantsLight = filter.weight === 'light';
    const normalized = wantsLight ? 1 - score / max : score / max;
    const ok =
      (wantsLight && score <= (filter.course !== null ? 0 : 1)) ||
      (!wantsLight && score >= (filter.course !== null ? 2 : 4));
    criteria.push({
      weight: 2,
      achieved: ok ? 2 : 2 * Math.max(0, normalized),
      shortfall: ok ? null : `it is on the ${wantsLight ? 'richer' : 'lighter'} side`,
    });
  }

  for (const [key, value] of Object.entries(filter.taste_preferences)) {
    if (isBasicTaste(key)) {
      const score = item.basic_tastes[key];
      if (typeof score !== 'number') {
        criteria.push({ weight: 2, achieved: 0, shortfall: `its ${key} level is not recorded` });
        continue;
      }
      const level = value as TasteLevel;
      const range = TASTE_LEVEL_RANGE[level];
      const inRange = score >= range.min && score <= range.max;
      const distance = Math.abs(score - TASTE_LEVEL_TARGET[level]);
      criteria.push({
        weight: 2,
        achieved: inRange ? 2 : 2 * Math.max(0, 1 - distance / 3),
        shortfall: inRange ? null : `its ${key} is ${score} of 3, and you asked for ${level}`,
      });
      continue;
    }

    if (isFlavorNote(key)) {
      const carries = item.flavor_notes.includes(key);
      const ok = value === true ? carries : !carries;
      criteria.push({
        weight: 2,
        achieved: ok ? 2 : 0,
        shortfall: ok
          ? null
          : value === true
            ? `it is not tagged ${humanTag(key)}`
            : `it is tagged ${humanTag(key)}, which you wanted to avoid`,
      });
    }
  }

  if (filter.max_price_paise !== null) {
    const over = item.price_paise - filter.max_price_paise;
    const ok = over <= 0;
    criteria.push({
      weight: 1,
      achieved: ok ? 1 : Math.max(0, 1 - over / filter.max_price_paise),
      shortfall: ok
        ? null
        : `it is ${formatRupees(item.price_paise)}, above the ${formatRupees(filter.max_price_paise)} you mentioned`,
    });
  }

  const totalWeightOfCriteria = criteria.reduce((sum, c) => sum + c.weight, 0);
  const achieved = criteria.reduce((sum, c) => sum + c.achieved, 0);

  return {
    item,
    similarity: totalWeightOfCriteria === 0 ? 1 : achieved / totalWeightOfCriteria,
    shortfalls: criteria.map((c) => c.shortfall).filter((s): s is string => s !== null),
  };
}

function rankBySimilarity(items: MenuItem[], filter: ParsedFilter): ScoredItem[] {
  return items
    .map((item) => scoreItem(item, filter))
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      const ra = a.item.rank_this_week ?? Number.POSITIVE_INFINITY;
      const rb = b.item.rank_this_week ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      return a.item.id.localeCompare(b.item.id);
    });
}

/**
 * The whole of Stage 2 from the orchestrator's point of view: exact matches if there
 * are any, otherwise the closest real alternatives, otherwise an honest nothing -
 * grouped into the sections the guest will see.
 */
export function findMatches(menu: MenuItem[], filter: ParsedFilter): MatchResult {
  const enforced = {
    dietary_include: [...filter.dietary_include],
    dietary_exclude: [...filter.dietary_exclude],
  };

  const exact = filterMenu(menu, filter);
  if (exact.length > 0) {
    // Exact matches keep the filter's own ordering (e.g. bestseller rank).
    const scored = exact.map((item) => scoreItem(item, filter));
    const { sections, items } = selectSections(scored, filter);
    return {
      matchType: 'exact',
      items,
      sections,
      exactCount: exact.length,
      relaxed: [],
      appliedFilter: filter,
      enforced,
    };
  }

  const ladder = activeConstraints(filter);
  const dropped: RelaxableConstraint[] = [];
  for (const constraint of ladder) {
    dropped.push(constraint);
    const relaxed = relaxFilter(filter, dropped);
    const candidates = filterMenu(menu, relaxed);
    if (candidates.length > 0) {
      const scored = rankBySimilarity(candidates, filter);
      const { sections, items } = selectSections(scored, relaxed);
      return {
        matchType: 'relaxed',
        items,
        sections,
        exactCount: 0,
        relaxed: [...dropped],
        appliedFilter: relaxed,
        enforced,
      };
    }
  }

  // Everything negotiable is gone and the safety-only filter still matches nothing:
  // this outlet genuinely has no dish for this guest.
  return {
    matchType: 'empty',
    items: [],
    sections: [],
    exactCount: 0,
    relaxed: [...dropped],
    appliedFilter: relaxFilter(filter, ladder),
    enforced,
  };
}
