import type { FoodType } from './food_types.ts';
import type { Language } from './i18n.ts';
import type {
  Allergen,
  BasicTaste,
  Course,
  DietaryTag,
  FlavorNote,
  RequestKind,
  SortOption,
  TasteLevel,
  Weight,
} from './taxonomy.ts';

/** One menu item, exactly as stored in the outlet's menu JSON. Never synthesised. */
export interface MenuItem {
  id: string;
  name: string;
  description: string;
  /**
   * Filled by the backend at deployment: an absolute CDN URL, or a path relative to
   * the web root such as "/images/M001.jpg". null means no image yet, and the client
   * renders a placeholder rather than a broken one.
   */
  image_url: string | null;
  /**
   * Per-language name and description, merged from menu_i18n.json at load. A missing
   * language falls back to the English fields, so a half-translated menu still reads.
   */
  i18n: Partial<Record<Language, { name: string; description: string }>>;
  price_paise: number;
  course: Course;
  category: string;
  dietary: DietaryTag[];
  /**
   * What the dish is made of, read from its own name and description at load time
   * (src/food_types.ts). A dish may carry several: "Chicken Fried Rice" is both.
   */
  food_types: FoodType[];
  basic_tastes: Partial<Record<BasicTaste, number>>;
  flavor_notes: FlavorNote[];
  allergens: Allergen[];
  /** false = taste/dietary/allergen data missing or unverified. Invisible to tag-dependent queries. */
  tags_complete: boolean;
  is_bestseller: boolean;
  rank_this_week: number | null;
}

export interface Menu {
  outlet_id: string;
  outlet_name: string;
  currency: string;
  menu: MenuItem[];
}

/**
 * Taste wanted, in the flat shape eval_dataset.json uses: a basic taste carries an
 * intensity, a flavour note carries true (wanted) or false (avoided).
 *
 *   { "sweet": "high", "spicy_warm": false }
 */
export type TastePreferences = Partial<Record<BasicTaste, TasteLevel>> &
  Partial<Record<FlavorNote, boolean>>;

/**
 * Stage 1's output. Every value is drawn from the fixed taxonomy - an invented tag
 * never reaches Stage 2.
 *
 * The first six fields are the contract eval_dataset.json scores against. The rest
 * are extensions this build needs and the dataset does not exercise; they are scored
 * only when an expected filter declares them.
 *
 * Note on `dietary_exclude`: it accepts both dietary tags and allergens, because a
 * guest says "no dairy" and "no meat" the same way. Stage 2 routes each value to the
 * item field that owns it (`allergens` vs `dietary`); they are never conflated.
 */
export interface ParsedFilter {
  dietary_include: DietaryTag[];
  dietary_exclude: Array<DietaryTag | Allergen>;
  course: Course | null;
  taste_preferences: TastePreferences;
  sort_by: SortOption | null;
  max_price_paise: number | null;

  /** "something light" / "something heavy". Defined over real fields in taxonomy.ts. */
  weight: Weight | null;
  /** "seafood", "something with paneer". A dish must carry every one of these. */
  food_types: FoodType[];
  /** "for two of us". Shapes how much is recommended, never what is eligible. */
  party_size: number | null;
  /**
   * How the guest said they feel, as a word from the feelings wheel (src/emotions.ts), or null.
   * Only a handful of feelings imply anything about food, and a mood may never reach a dietary
   * field or an allergen - see the rules at the top of emotions.ts.
   */
  mood: string | null;
  /** Anything but MENU short-circuits the pipeline with a fixed reply. */
  request_kind: RequestKind;
  /**
   * The language to answer and list in. Hinglish resolves to hi and Kanglish to kn,
   * so a guest who types "thoda teekha chahiye" is answered in Hindi. The client can
   * override it with an explicit choice.
   */
  language: Language;
  /**
   * Parts of the request the taxonomy cannot express ("cold", "eggs are okay").
   * Never used to filter - only to admit, in the answer, that it was not applied.
   */
  unexpressed: string[];
}

/** Which constraint a relaxation step gave up, for honest reporting to the guest. */
export type RelaxableConstraint =
  | 'price'
  | 'weight'
  | 'basic_tastes'
  | 'flavor_notes_wanted'
  | 'course'
  | 'flavor_notes_avoided';

export interface ScoredItem {
  item: MenuItem;
  /** 0-1. 1 = satisfies every soft preference in the original request. */
  similarity: number;
  /** Plain-language notes on how this item differs from what was asked for. */
  shortfalls: string[];
}

/** Matches for one course, so the answer can span the menu rather than one shelf. */
export interface MenuSection {
  course: Course;
  /** The shortlist shown for this course. */
  items: ScoredItem[];
  /** How many matched in this course in total, so a client can say "and 9 more". */
  totalMatches: number;
}

export type MatchType =
  /** The filter as written found dishes. */
  | 'exact'
  /** Nothing matched exactly; these are the nearest, with constraints given up. */
  | 'relaxed'
  /** Nothing matched, even after giving up everything negotiable. */
  | 'empty'
  /** The guest asked for a recommendation without constraints. */
  | 'fallback_default'
  /** Something in the request could not be expressed, so the answer asks. */
  | 'clarification'
  /** Not about the menu. */
  | 'off_topic'
  /** Abusive. */
  | 'abusive';

export interface MatchResult {
  matchType: MatchType;
  /** Flat shortlist, in section order. What Stage 3 may name. */
  items: ScoredItem[];
  /** The same items grouped by course. One entry when the guest named a course. */
  sections: MenuSection[];
  /** How many items the filter matched before any relaxation. 0 means nothing matched. */
  exactCount: number;
  /** Constraints dropped to find these items. Empty when matchType is 'exact'. */
  relaxed: RelaxableConstraint[];
  /** The filter actually applied after relaxation. */
  appliedFilter: ParsedFilter;
  /** Constraints that were never up for relaxation (dietary and allergen safety). */
  enforced: { dietary_include: DietaryTag[]; dietary_exclude: Array<DietaryTag | Allergen> };
}

export type IntentParseResult =
  | { ok: true; filter: ParsedFilter; attempts: number; raw: unknown }
  | {
      ok: false;
      reason: 'invalid_output' | 'llm_error';
      errors: string[];
      attempts: number;
      raw: unknown;
    };

export interface ConciergeResult {
  /** What the guest is shown. */
  message: string;
  /** Items the message is allowed to mention. */
  items: MenuItem[];
  /** The same items grouped by course, for a sectioned UI. */
  sections: Array<{ course: Course; label: string; items: MenuItem[]; totalMatches: number }>;
  matchType: MatchType;
  /** True when the message came from the deterministic template, not the LLM. */
  usedFallback: boolean;
  /** Populated when the guardrail rejected an LLM draft. */
  guardrailFailures: string[];
  filter: ParsedFilter | null;
  relaxed: RelaxableConstraint[];
  exactCount: number;
  shortfalls: string[];
  stage1Attempts: number;
}
