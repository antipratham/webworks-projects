/**
 * The fixed taxonomy. This is the ONLY vocabulary the intent parser (Stage 1) is
 * allowed to emit, and the only vocabulary the deterministic filter (Stage 2)
 * knows how to apply.
 *
 * Menu data conforms to this taxonomy, never the other way round: if an outlet's
 * JSON carries a value that is not listed here, that is a data bug, surfaced by
 * `auditMenuVocabulary()` rather than silently accepted.
 *
 * Field names and value sets match eval_dataset.json, which is the validation
 * contract for the parser.
 */

export const DIETARY_TAGS = ['veg', 'non_veg', 'vegan', 'jain', 'gluten_free'] as const;
export type DietaryTag = (typeof DIETARY_TAGS)[number];

export const ALLERGENS = [
  'dairy',
  'gluten',
  'shellfish',
  'fish',
  'egg',
  'peanut',
  'tree_nut',
  'soy',
  'sesame',
  'mustard',
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const COURSES = [
  'starter',
  'main',
  'dessert',
  'beverage',
  'bread',
  'soup',
  'salad',
] as const;
export type Course = (typeof COURSES)[number];

/** The order sections are shown in - the order a meal is eaten, not alphabetical. */
export const COURSE_ORDER: Course[] = [
  'starter',
  'soup',
  'salad',
  'main',
  'bread',
  'dessert',
  'beverage',
];

/** Plural labels for section headings shown to a guest. */
export const COURSE_LABEL: Record<Course, string> = {
  starter: 'Starters',
  soup: 'Soups',
  salad: 'Salads',
  main: 'Mains',
  bread: 'Breads',
  dessert: 'Desserts',
  beverage: 'Drinks',
};

/**
 * Spice is a taste here, not only a flavour note: guests ask for "very spicy" and
 * "mildly spicy", which needs a level, not a yes/no. The `spicy_warm` note stays in
 * the data as the warming-spice character of a dish; the word "spicy" from a guest
 * maps to this taste.
 */
export const BASIC_TASTES = ['sweet', 'sour', 'salty', 'bitter', 'umami', 'spicy'] as const;
export type BasicTaste = (typeof BASIC_TASTES)[number];

export const FLAVOR_NOTES = [
  'fruity',
  'sweet_creamy',
  'spicy_warm',
  'floral_herbal',
  'savory_pungent',
] as const;
export type FlavorNote = (typeof FLAVOR_NOTES)[number];

/** Guest-facing intensity, mapped to the 0-3 scores stored on items. */
export const TASTE_LEVELS = ['high', 'low'] as const;
export type TasteLevel = (typeof TASTE_LEVELS)[number];

export const WEIGHTS = ['light', 'heavy'] as const;
export type Weight = (typeof WEIGHTS)[number];

export const SORT_OPTIONS = ['bestseller', 'price_asc', 'price_desc'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

/** What the guest is actually doing. Anything but MENU short-circuits the pipeline. */
export const REQUEST_KINDS = ['MENU', 'OFF_TOPIC', 'ABUSIVE'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/**
 * The one place the intensity words are given numeric meaning. Stage 2 reads this;
 * no other module may reinterpret "low" or "high".
 */
export const TASTE_LEVEL_RANGE: Record<TasteLevel, { min: number; max: number }> = {
  low: { min: 0, max: 1 },
  high: { min: 2, max: 3 },
};

/** Midpoint of each range - used only by the similarity scorer (Stage 2b). */
export const TASTE_LEVEL_TARGET: Record<TasteLevel, number> = { low: 0.5, high: 2.5 };

/**
 * "Light" and "heavy" are not fields on an item, so they are defined here, once,
 * over fields that are. Nothing is inferred from a dish name.
 *
 *   tag weight  = richness the dish carries regardless of course (0-3)
 *   course weight = how substantial the course itself is (0-3)
 *
 * When the guest names a course, only the tag weight counts - "a light main" means
 * the lighter end of the mains, not a contradiction. When no course is named, both
 * count, so "something light" reaches the soups and salads first.
 */
export const COURSE_WEIGHT: Record<Course, number> = {
  soup: 0,
  salad: 0,
  beverage: 0,
  starter: 1,
  dessert: 2,
  main: 3,
  bread: 3,
};

/** Tag-weight thresholds, used when a course is pinned. */
export const TAG_WEIGHT_LIGHT_MAX = 0;
export const TAG_WEIGHT_HEAVY_MIN = 2;
/** Combined thresholds, used when the guest named no course. */
export const TOTAL_WEIGHT_LIGHT_MAX = 1;
export const TOTAL_WEIGHT_HEAVY_MIN = 4;
/** A dish whose basic tastes sum to this or more counts as intense. */
export const INTENSE_TASTE_SUM = 6;

const DIETARY_SET: ReadonlySet<string> = new Set(DIETARY_TAGS);
const ALLERGEN_SET: ReadonlySet<string> = new Set(ALLERGENS);
const COURSE_SET: ReadonlySet<string> = new Set(COURSES);
const BASIC_TASTE_SET: ReadonlySet<string> = new Set(BASIC_TASTES);
const FLAVOR_NOTE_SET: ReadonlySet<string> = new Set(FLAVOR_NOTES);
const TASTE_LEVEL_SET: ReadonlySet<string> = new Set(TASTE_LEVELS);
const SORT_SET: ReadonlySet<string> = new Set(SORT_OPTIONS);
const WEIGHT_SET: ReadonlySet<string> = new Set(WEIGHTS);
const REQUEST_KIND_SET: ReadonlySet<string> = new Set(REQUEST_KINDS);

export const isDietaryTag = (v: unknown): v is DietaryTag =>
  typeof v === 'string' && DIETARY_SET.has(v);
export const isAllergen = (v: unknown): v is Allergen =>
  typeof v === 'string' && ALLERGEN_SET.has(v);
export const isCourse = (v: unknown): v is Course => typeof v === 'string' && COURSE_SET.has(v);
export const isBasicTaste = (v: unknown): v is BasicTaste =>
  typeof v === 'string' && BASIC_TASTE_SET.has(v);
export const isFlavorNote = (v: unknown): v is FlavorNote =>
  typeof v === 'string' && FLAVOR_NOTE_SET.has(v);
export const isTasteLevel = (v: unknown): v is TasteLevel =>
  typeof v === 'string' && TASTE_LEVEL_SET.has(v);
export const isSortOption = (v: unknown): v is SortOption =>
  typeof v === 'string' && SORT_SET.has(v);
export const isWeight = (v: unknown): v is Weight => typeof v === 'string' && WEIGHT_SET.has(v);
export const isRequestKind = (v: unknown): v is RequestKind =>
  typeof v === 'string' && REQUEST_KIND_SET.has(v);

/**
 * A value in `dietary_exclude` may name either a dietary tag ("no meat" -> non_veg)
 * or an allergen ("no dairy" -> dairy). These live in different item fields and must
 * never be conflated, so every excluded value is routed to the field that owns it.
 */
export function classifyExclusion(
  value: string,
): { kind: 'dietary'; value: DietaryTag } | { kind: 'allergen'; value: Allergen } | null {
  if (isAllergen(value)) return { kind: 'allergen', value };
  if (isDietaryTag(value)) return { kind: 'dietary', value };
  return null;
}

/** Human-readable taxonomy block injected into the Stage 1 prompt. */
export function taxonomyPromptBlock(): string {
  return [
    `dietary tags: ${DIETARY_TAGS.join(', ')}`,
    `allergens: ${ALLERGENS.join(', ')}`,
    `courses: ${COURSES.join(', ')}`,
    `basic tastes (each scored 0-3 on an item): ${BASIC_TASTES.join(', ')}`,
    `taste levels: ${TASTE_LEVELS.join(', ')}`,
    `flavour notes (an item either carries one or does not): ${FLAVOR_NOTES.join(', ')}`,
    `weight: ${WEIGHTS.join(', ')}`,
    `sort options: ${SORT_OPTIONS.join(', ')}`,
    `request kinds: ${REQUEST_KINDS.join(', ')}`,
  ].join('\n');
}
