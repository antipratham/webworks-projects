/**
 * emotions.ts
 *
 * The feelings wheel (emotions.json: 6 primary, 37 secondary, 74 tertiary) turned into two
 * things the parser can use: a vocabulary wide enough to RECOGNISE how a guest describes
 * their state, and a narrow, code-owned table of what a few of those states mean for food.
 *
 * The split matters. Recognising "I've had a rough day" as a feeling is language work and the
 * model is good at it. Deciding that a tired guest wants something light is a judgement about
 * this restaurant, and it belongs in code where it can be read and argued with - the same
 * division as everywhere else here.
 *
 * Today that sentence goes to `unexpressed` and changes nothing about the filter, because the
 * taxonomy has no field for a mood. It still has none: a feeling resolves into the fields that
 * already exist (weight, sort_by, and at most a nudge on taste), so nothing new can be claimed
 * about a dish.
 *
 * TWO RULES, both deliberate:
 *
 *  1. A feeling NEVER touches dietary_include, dietary_exclude or an allergen. A guest's mood is
 *     not a dietary fact, and a filter that relaxed "no nuts" because someone sounded cheerful
 *     would be the worst bug this codebase could have.
 *  2. Most feelings map to nothing, and that is the correct answer. "Humiliated", "Threatened"
 *     and "Disapproving" are real entries on the wheel with no honest implication for a menu.
 *     Only the states below are mapped; everything else is recognised and then ignored.
 */

import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import type { SortOption, Weight } from './taxonomy.ts';

interface WheelNode {
  feeling: string;
  description?: string;
  synonyms?: string[];
  category?: string;
  secondary?: WheelNode[];
  tertiary?: WheelNode[];
}

/** What a feeling is allowed to imply. Never a dietary field - see rule 1. */
export interface MoodHint {
  weight?: Weight;
  sort_by?: SortOption;
  /** A short phrase for the parser, not a claim about any dish. */
  reads_as: string;
}

/**
 * The mapped states. Deliberately short, and the restaurant's to argue with: these are
 * judgements about what a guest in that state tends to want, not facts about the menu.
 */
export const MOOD_HINTS: Readonly<Record<string, MoodHint>> = {
  // Low and wanting comfort: richer, familiar, what other people order.
  sad: { weight: 'heavy', sort_by: 'bestseller', reads_as: 'comfort' },
  lonely: { weight: 'heavy', sort_by: 'bestseller', reads_as: 'comfort' },
  depressed: { weight: 'heavy', sort_by: 'bestseller', reads_as: 'comfort' },
  hurt: { weight: 'heavy', sort_by: 'bestseller', reads_as: 'comfort' },
  stressed: { weight: 'heavy', sort_by: 'bestseller', reads_as: 'comfort' },

  // Flat out: light and quick, nothing to decide.
  tired: { weight: 'light', sort_by: 'bestseller', reads_as: 'easy' },
  busy: { weight: 'light', sort_by: 'bestseller', reads_as: 'quick' },
  weak: { weight: 'light', reads_as: 'gentle' },

  // Celebrating: the better-known things, and no price sort.
  happy: { sort_by: 'bestseller', reads_as: 'celebrating' },
  proud: { sort_by: 'bestseller', reads_as: 'celebrating' },
};

/**
 * NOT mapped, deliberately: playful, interested, bored, curious, excited.
 *
 * All of them read as "show me something I have not had", and the taxonomy cannot say that.
 * SORT_OPTIONS is bestseller, price_asc, price_desc - there is no novelty sort, and the nearest
 * thing (bestseller) is the exact opposite of what a bored guest wants. They stay recognised, so
 * the mood is visible in the log and in `unexpressed` reasoning, and they change nothing until
 * there is a field honest enough to carry them.
 */

function flatten(nodes: WheelNode[], out: WheelNode[] = []): WheelNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.secondary) flatten(n.secondary, out);
    if (n.tertiary) flatten(n.tertiary, out);
  }
  return out;
}

let cache: { words: string[]; byWord: Map<string, string> } | null = null;

function load(): { words: string[]; byWord: Map<string, string> } {
  if (cache) return cache;
  const path = fileURLToPath(new URL('../emotions.json', import.meta.url));
  const wheel: WheelNode[] = JSON.parse(fs.readFileSync(path, 'utf8'));
  const byWord = new Map<string, string>();
  for (const node of flatten(wheel)) {
    const key = node.feeling.toLowerCase().trim();
    byWord.set(key, key);
    for (const syn of node.synonyms ?? []) byWord.set(syn.toLowerCase().trim(), key);
  }
  cache = { words: [...new Set(byWord.keys())].sort(), byWord };
  return cache;
}

/** Every feeling word and synonym on the wheel - 117 feelings, rather more words. */
export function vocabulary(): string[] {
  return load().words;
}

/** The hint for a feeling the model reported, or null. Synonyms resolve to their feeling. */
export function hintFor(feeling: string | null | undefined): MoodHint | null {
  if (!feeling) return null;
  const { byWord } = load();
  const key = byWord.get(String(feeling).toLowerCase().trim()) ?? String(feeling).toLowerCase().trim();
  return MOOD_HINTS[key] ?? null;
}

/**
 * The filter a guest in this state should be shown, derived - never the one that gets logged
 * and scored, which stays exactly as Stage 1 produced it.
 *
 * A mood only ever FILLS A GAP. If the guest said "something light" the mood does not argue
 * with them, and if they asked for the cheapest thing the mood does not re-sort it. Diet,
 * allergens, course and price are untouched by construction: this function does not name them.
 */
export function applyMood<T extends { mood: string | null; weight: Weight | null; sort_by: SortOption | null }>(
  filter: T,
): T {
  const hint = hintFor(filter.mood);
  if (!hint) return filter;
  const next = { ...filter };
  if (next.weight === null && hint.weight !== undefined) next.weight = hint.weight;
  if (next.sort_by === null && hint.sort_by !== undefined) next.sort_by = hint.sort_by;
  return next;
}

/**
 * The prompt block. Only the mapped states are listed: a model told about 117 feelings it
 * cannot act on will reach for one, and a guest who said nothing about how they feel would
 * get a filter built from a mood they never mentioned.
 */
export function emotionPromptBlock(): string {
  const groups = new Map<string, string[]>();
  for (const [feeling, hint] of Object.entries(MOOD_HINTS)) {
    const list = groups.get(hint.reads_as) ?? [];
    list.push(feeling);
    groups.set(hint.reads_as, list);
  }
  const lines = [...groups.entries()].map(([reads, feelings]) => `  ${reads}: ${feelings.join(', ')}`);
  return lines.join('\n');
}

/** Just the words the parser may emit - the mapped ones, which is all that can change a filter. */
export function moodWords(): string {
  return Object.keys(MOOD_HINTS).join(', ');
}
