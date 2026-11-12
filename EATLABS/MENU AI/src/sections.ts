/**
 * Shortlisting and sectioning.
 *
 * A guest who asks for "something spicy" is asking about the whole menu, and should
 * be shown spicy starters and spicy mains under their own headings. A guest who asks
 * for "a spicy main course" has already chosen the shelf, and should be shown that
 * shelf only. This module decides which of those is happening and how much to show.
 *
 * Pure code. It reorders and trims what Stage 2 matched; it never decides
 * eligibility, and it never reaches past the matched set.
 */

import type { MenuSection, ParsedFilter, ScoredItem } from './types.ts';
import { COURSE_ORDER } from './taxonomy.ts';
import type { Course } from './taxonomy.ts';

export interface ShortlistPlan {
  /** True when the answer should span courses rather than stay in one. */
  spread: boolean;
  /** How many dishes per section when spreading. */
  perSection: number;
  /** How many sections at most. */
  maxSections: number;
  /** Hard cap on dishes shown in total. */
  totalCap: number;
}

/**
 * How much to show, and whether to spread it.
 *
 * Party size changes the amount, never the eligibility: four people want more
 * suggestions than one, but the same dishes qualify either way.
 */
export function planShortlist(filter: ParsedFilter): ShortlistPlan {
  const party = filter.party_size ?? null;

  // A named course means one shelf. An explicit ordering ("the bestseller",
  // "cheapest") means the guest wants a ranked list, not a tour of the menu.
  const spread = filter.course === null && filter.sort_by === null;

  if (!spread) {
    return {
      spread: false,
      perSection: Number.POSITIVE_INFINITY,
      maxSections: COURSE_ORDER.length,
      totalCap: party === null ? 3 : Math.min(5, Math.max(2, party)),
    };
  }

  return {
    spread: true,
    perSection: party !== null && party >= 4 ? 3 : 2,
    maxSections: 4,
    totalCap: party === null ? 6 : Math.min(8, Math.max(4, party + 2)),
  };
}

function groupByCourse(items: ScoredItem[]): Map<Course, ScoredItem[]> {
  const groups = new Map<Course, ScoredItem[]>();
  for (const scored of items) {
    const list = groups.get(scored.item.course);
    if (list) list.push(scored);
    else groups.set(scored.item.course, [scored]);
  }
  return groups;
}

/**
 * Turns every match into the shortlist a guest sees, grouped into sections.
 *
 * `all` is the complete matched set, already in the order Stage 2 chose. Section
 * counts are taken from that full set, so a client can honestly say "and 9 more
 * mains" without the shortlist having to carry them.
 */
export function selectSections(
  all: ScoredItem[],
  filter: ParsedFilter,
): { sections: MenuSection[]; items: ScoredItem[] } {
  const plan = planShortlist(filter);
  const grouped = groupByCourse(all);

  if (!plan.spread) {
    // One ranked list. Sections follow the order the items came out in, so a
    // sectioned UI can still render it without disturbing the ranking.
    const picked = all.slice(0, plan.totalCap);
    const sections: MenuSection[] = [];
    for (const scored of picked) {
      const course = scored.item.course;
      const existing = sections.find((s) => s.course === course);
      if (existing) existing.items.push(scored);
      else sections.push({ course, items: [scored], totalMatches: grouped.get(course)?.length ?? 0 });
    }
    return { sections, items: picked };
  }

  // Spread: menu order, but if there are more courses with matches than we will
  // show, keep the ones with the most to offer and put them back in menu order.
  const available = COURSE_ORDER.filter((course) => (grouped.get(course)?.length ?? 0) > 0);
  const chosen =
    available.length <= plan.maxSections
      ? available
      : [...available]
          .sort((a, b) => (grouped.get(b)?.length ?? 0) - (grouped.get(a)?.length ?? 0))
          .slice(0, plan.maxSections)
          .sort((a, b) => COURSE_ORDER.indexOf(a) - COURSE_ORDER.indexOf(b));

  const sections: MenuSection[] = chosen.map((course) => {
    const inCourse = grouped.get(course) ?? [];
    return {
      course,
      items: inCourse.slice(0, plan.perSection),
      totalMatches: inCourse.length,
    };
  });

  // Trim to the overall cap from the last section backwards, so the earlier courses
  // keep their suggestions and no section is left empty.
  let total = sections.reduce((sum, s) => sum + s.items.length, 0);
  for (let i = sections.length - 1; i >= 0 && total > plan.totalCap; i--) {
    const section = sections[i];
    if (!section) continue;
    while (section.items.length > 1 && total > plan.totalCap) {
      section.items.pop();
      total--;
    }
  }
  while (total > plan.totalCap && sections.length > 1) {
    const removed = sections.pop();
    total -= removed?.items.length ?? 0;
  }

  return { sections, items: sections.flatMap((s) => s.items) };
}
