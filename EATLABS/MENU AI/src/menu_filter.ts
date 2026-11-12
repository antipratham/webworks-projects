/**
 * STAGE 2 - Deterministic filter.
 *
 * Pure functions over real menu objects. No LLM, no network, no I/O. Every rule
 * that decides whether a guest may be shown a dish lives here, where it can be
 * unit-tested and where an opinion cannot override a field.
 */

import type { MenuItem, ParsedFilter } from './types.ts';
import {
  COURSE_WEIGHT,
  INTENSE_TASTE_SUM,
  TAG_WEIGHT_HEAVY_MIN,
  TAG_WEIGHT_LIGHT_MAX,
  TASTE_LEVEL_RANGE,
  TOTAL_WEIGHT_HEAVY_MIN,
  TOTAL_WEIGHT_LIGHT_MAX,
  classifyExclusion,
  isBasicTaste,
  isFlavorNote,
} from './taxonomy.ts';
import type { Allergen, DietaryTag } from './taxonomy.ts';

/**
 * Splits `dietary_exclude` into the two item fields that own the values. "No dairy"
 * is an allergen exclusion and must be checked against `allergens`; "no meat" is a
 * dietary exclusion checked against `dietary`. Conflating them is how a guest with
 * an allergy gets handed the wrong plate.
 */
export function splitExclusions(filter: ParsedFilter): {
  allergens: Allergen[];
  dietary: DietaryTag[];
} {
  const allergens: Allergen[] = [];
  const dietary: DietaryTag[] = [];
  for (const value of filter.dietary_exclude) {
    const classified = classifyExclusion(value);
    if (!classified) continue; // unreachable for a validated filter
    if (classified.kind === 'allergen') allergens.push(classified.value);
    else dietary.push(classified.value);
  }
  return { allergens, dietary };
}

/** Sum of an item's basic taste scores. Used only by the weight rule. */
export function tasteIntensity(item: MenuItem): number {
  return Object.values(item.basic_tastes).reduce((sum, score) => sum + (score ?? 0), 0);
}

/**
 * How rich a dish is on its own account, ignoring its course (0-3). This is what
 * "light" and "heavy" mean once the guest has already named a course.
 */
export function tagWeight(item: MenuItem): number {
  return (
    (item.flavor_notes.includes('sweet_creamy') ? 1 : 0) +
    (tasteIntensity(item) >= INTENSE_TASTE_SUM ? 1 : 0) +
    ((item.basic_tastes.sweet ?? 0) >= 2 ? 1 : 0)
  );
}

/** Richness including how substantial the course is (0-6). */
export function totalWeight(item: MenuItem): number {
  return COURSE_WEIGHT[item.course] + tagWeight(item);
}

/**
 * "Light" and "heavy" are not fields, so they are decided here from fields that are.
 *
 * With a course named, only the dish's own richness counts, so "a light main" finds
 * the lighter mains rather than nothing. With no course named, the course counts
 * too, so "something light" reaches the soups and salads first.
 */
export function matchesWeight(item: MenuItem, filter: ParsedFilter): boolean {
  if (filter.weight === null) return true;
  const courseNamed = filter.course !== null;
  const score = courseNamed ? tagWeight(item) : totalWeight(item);
  if (filter.weight === 'light') {
    return score <= (courseNamed ? TAG_WEIGHT_LIGHT_MAX : TOTAL_WEIGHT_LIGHT_MAX);
  }
  return score >= (courseNamed ? TAG_WEIGHT_HEAVY_MIN : TOTAL_WEIGHT_HEAVY_MIN);
}

/**
 * True when the filter reads any field that an untagged item does not reliably have.
 * Such a query must not see `tags_complete: false` items at all - a missing tag is
 * unknown, not absent. Weight counts, because it is computed from taste and flavour.
 */
export function dependsOnTaggedFields(filter: ParsedFilter): boolean {
  return (
    filter.dietary_include.length > 0 ||
    filter.dietary_exclude.length > 0 ||
    Object.keys(filter.taste_preferences).length > 0 ||
    filter.weight !== null
  );
}

function matchesTastePreferences(item: MenuItem, filter: ParsedFilter): boolean {
  for (const [key, value] of Object.entries(filter.taste_preferences)) {
    if (isBasicTaste(key)) {
      const score = item.basic_tastes[key];
      if (typeof score !== 'number') return false; // untagged on this taste: not a match
      const range = TASTE_LEVEL_RANGE[value as keyof typeof TASTE_LEVEL_RANGE];
      if (!range || score < range.min || score > range.max) return false;
      continue;
    }
    if (isFlavorNote(key)) {
      const carries = item.flavor_notes.includes(key);
      if (value === true && !carries) return false;
      if (value === false && carries) return false;
    }
  }
  return true;
}

/** Applies every hard constraint in the filter. Exported for per-item testing. */
export function matchesFilter(item: MenuItem, filter: ParsedFilter): boolean {
  if (dependsOnTaggedFields(filter) && !item.tags_complete) return false;

  for (const tag of filter.dietary_include) {
    if (!item.dietary.includes(tag)) return false;
  }

  const excluded = splitExclusions(filter);
  for (const allergen of excluded.allergens) {
    if (item.allergens.includes(allergen)) return false;
  }
  for (const tag of excluded.dietary) {
    if (item.dietary.includes(tag)) return false;
  }

  if (filter.course !== null && item.course !== filter.course) return false;
  // Every named food type must be on the dish: "chicken biryani" is chicken AND rice.
  for (const type of filter.food_types) {
    if (!item.food_types.includes(type)) return false;
  }
  if (!matchesTastePreferences(item, filter)) return false;
  if (!matchesWeight(item, filter)) return false;
  if (filter.max_price_paise !== null && item.price_paise > filter.max_price_paise) return false;

  return true;
}

/**
 * Stable default ordering, so the same query always yields the same shortlist:
 * ranked items first (by rank), then flagged bestsellers, then by id.
 */
export function defaultOrder(a: MenuItem, b: MenuItem): number {
  const ra = a.rank_this_week ?? Number.POSITIVE_INFINITY;
  const rb = b.rank_this_week ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra - rb;
  if (a.is_bestseller !== b.is_bestseller) return a.is_bestseller ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/**
 * Applies `sort_by`. "Bestseller" means the ranking the POS produced
 * (`rank_this_week`, ascending) - never a model's opinion of what is popular. When
 * the guest asks for bestsellers, unranked items are not bestsellers and drop out.
 */
export function applySort(items: MenuItem[], filter: ParsedFilter): MenuItem[] {
  const sorted = [...items];
  switch (filter.sort_by) {
    case 'bestseller': {
      const ranked = sorted.filter((i) => i.rank_this_week !== null);
      if (ranked.length > 0) {
        return ranked.sort((a, b) => (a.rank_this_week ?? 0) - (b.rank_this_week ?? 0));
      }
      const flagged = sorted.filter((i) => i.is_bestseller);
      return (flagged.length > 0 ? flagged : sorted).sort(defaultOrder);
    }
    case 'price_asc':
      return sorted.sort((a, b) => a.price_paise - b.price_paise || defaultOrder(a, b));
    case 'price_desc':
      return sorted.sort((a, b) => b.price_paise - a.price_paise || defaultOrder(a, b));
    default:
      return sorted.sort(defaultOrder);
  }
}

/**
 * Stage 2 proper: the real menu objects that satisfy every constraint, in a
 * deterministic order. Items are returned unmodified, straight from the JSON.
 */
export function filterMenu(menu: MenuItem[], filter: ParsedFilter): MenuItem[] {
  return applySort(
    menu.filter((item) => matchesFilter(item, filter)),
    filter,
  );
}
