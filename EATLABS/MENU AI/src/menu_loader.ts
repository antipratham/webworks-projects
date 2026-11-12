/**
 * Menu loading, kept behind a function so the pipeline never reaches for a file path
 * of its own. One process serves many outlets; each request brings its own menu.
 */

import { foodTypesOf } from './food_types.ts';
import { readFile } from 'node:fs/promises';
import type { Menu, MenuItem } from './types.ts';
import {
  ALLERGENS,
  BASIC_TASTES,
  COURSES,
  DIETARY_TAGS,
  FLAVOR_NOTES,
  isAllergen,
  isBasicTaste,
  isCourse,
  isDietaryTag,
  isFlavorNote,
} from './taxonomy.ts';

/** Shape check with a clear error - a malformed menu should fail loudly at load. */
export function parseMenu(raw: unknown): Menu {
  if (typeof raw !== 'object' || raw === null) throw new Error('menu: expected an object');
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.menu)) throw new Error('menu: missing "menu" array');

  const items: MenuItem[] = obj.menu.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`menu[${index}]: expected an object`);
    }
    const item = entry as Record<string, unknown>;
    for (const field of ['id', 'name', 'course'] as const) {
      if (typeof item[field] !== 'string') throw new Error(`menu[${index}].${field}: expected a string`);
    }
    if (typeof item.price_paise !== 'number') {
      throw new Error(`menu[${index}].price_paise: expected a number (money is stored in paise)`);
    }
    return {
      id: item.id as string,
      name: item.name as string,
      description: typeof item.description === 'string' ? item.description : '',
      // Absent or not a string means "no image yet": the client shows a placeholder.
      image_url: typeof item.image_url === 'string' && item.image_url.trim() !== '' ? item.image_url : null,
      i18n: {},
      price_paise: item.price_paise,
      course: item.course as MenuItem['course'],
      category: typeof item.category === 'string' ? item.category : '',
      dietary: Array.isArray(item.dietary) ? (item.dietary as MenuItem['dietary']) : [],
      // Derived once, here, so everything downstream reads a field the dish carries rather
      // than guessing from its name at question time.
      food_types: foodTypesOf(
        item.name as string,
        typeof item.description === 'string' ? item.description : '',
      ),
      basic_tastes:
        typeof item.basic_tastes === 'object' && item.basic_tastes !== null
          ? (item.basic_tastes as MenuItem['basic_tastes'])
          : {},
      flavor_notes: Array.isArray(item.flavor_notes)
        ? (item.flavor_notes as MenuItem['flavor_notes'])
        : [],
      allergens: Array.isArray(item.allergens) ? (item.allergens as MenuItem['allergens']) : [],
      // Absent or non-boolean means "not verified": treat as incomplete, never as complete.
      tags_complete: item.tags_complete === true,
      is_bestseller: item.is_bestseller === true,
      rank_this_week: typeof item.rank_this_week === 'number' ? item.rank_this_week : null,
    };
  });

  return {
    outlet_id: typeof obj.outlet_id === 'string' ? obj.outlet_id : 'unknown',
    outlet_name: typeof obj.outlet_name === 'string' ? obj.outlet_name : 'unknown',
    currency: typeof obj.currency === 'string' ? obj.currency : 'INR',
    menu: items,
  };
}

export async function loadMenuFromFile(path: string): Promise<Menu> {
  const menu = parseMenu(JSON.parse(await readFile(path, 'utf8')));
  // Translations live in their own file so a translator never edits the menu data,
  // and a menu with no translation file still loads and reads in English.
  const i18nPath = path.replace(/[^/\\]+$/, 'menu_i18n.json');
  try {
    const raw = JSON.parse(await readFile(i18nPath, 'utf8')) as Record<string, unknown>;
    mergeTranslations(menu.menu, raw.items ?? raw);
  } catch {
    /* no translation file: English only */
  }
  return menu;
}

/** Copies translated name/description onto the items, ignoring anything malformed. */
export function mergeTranslations(items: MenuItem[], raw: unknown): number {
  if (typeof raw !== 'object' || raw === null) return 0;
  const table = raw as Record<string, Record<string, { name?: unknown; description?: unknown }>>;
  let merged = 0;
  for (const item of items) {
    const entry = table[item.id];
    if (!entry) continue;
    for (const lang of ['hi', 'kn'] as const) {
      const value = entry[lang];
      if (!value) continue;
      const name = typeof value.name === 'string' ? value.name.trim() : '';
      const description = typeof value.description === 'string' ? value.description.trim() : '';
      if (!name && !description) continue;
      item.i18n[lang] = { name: name || item.name, description: description || item.description };
      merged++;
    }
  }
  return merged;
}

export interface VocabularyIssue {
  itemId: string;
  field: string;
  value: string;
}

/**
 * Reports menu values that fall outside the taxonomy. The filter silently ignores
 * such values, which is safe but invisible - this is how a manager finds out that an
 * item was tagged with something the platform does not understand.
 *
 * Also reports items with `tags_complete: false`, which the spec requires the
 * manager to be told about: they are invisible to every dietary answer.
 */
export function auditMenuVocabulary(menu: MenuItem[]): {
  unknownValues: VocabularyIssue[];
  incompleteItems: MenuItem[];
} {
  const unknownValues: VocabularyIssue[] = [];
  const checks: Array<{ field: keyof MenuItem; guard: (v: unknown) => boolean }> = [
    { field: 'dietary', guard: isDietaryTag },
    { field: 'allergens', guard: isAllergen },
    { field: 'flavor_notes', guard: isFlavorNote },
  ];

  for (const item of menu) {
    for (const { field, guard } of checks) {
      for (const value of item[field] as string[]) {
        if (!guard(value)) unknownValues.push({ itemId: item.id, field: String(field), value });
      }
    }
    if (!isCourse(item.course)) {
      unknownValues.push({ itemId: item.id, field: 'course', value: item.course });
    }
    for (const taste of Object.keys(item.basic_tastes)) {
      if (!isBasicTaste(taste)) {
        unknownValues.push({ itemId: item.id, field: 'basic_tastes', value: taste });
      }
    }
  }

  return { unknownValues, incompleteItems: menu.filter((i) => !i.tags_complete) };
}

/** The vocabulary an outlet's menu is checked against, for reference in tooling. */
export const TAXONOMY_SUMMARY = {
  dietary: DIETARY_TAGS,
  allergens: ALLERGENS,
  courses: COURSES,
  basic_tastes: BASIC_TASTES,
  flavor_notes: FLAVOR_NOTES,
};
