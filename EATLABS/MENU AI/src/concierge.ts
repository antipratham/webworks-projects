/**
 * Orchestrator. Chains the stages and owns the paths between them: an abusive or
 * off-topic request, an unparseable one, a request with no constraints at all, a
 * zero-result filter, and the relax-and-retry that turns "nothing matches" into
 * "here is the closest thing".
 *
 * The menu is a parameter, never a module-level import, so one process serves
 * many outlets.
 */

import type { IntentLogger } from './logger.ts';
import type { LlmClient } from './llm.ts';
import type { ConciergeResult, MatchType, MenuItem, ParsedFilter } from './types.ts';
import { applyMood } from './emotions.ts';
import { EMPTY_FILTER, isEmptyFilter, parseIntent } from './intent_parser.ts';
import { dependsOnTaggedFields } from './menu_filter.ts';
import { findMatches } from './similarity.ts';
import { generateResponse } from './response_generator.ts';
import { screenRequest } from './safety.ts';
import { CANNED, COURSE_LABELS, detectScript } from './i18n.ts';
import type { Language } from './i18n.ts';

export interface ConciergeDeps {
  /** Stage 1 model. */
  intentLlm: LlmClient;
  /** Stage 3 model. Defaults to the Stage 1 client; can be a different model. */
  responseLlm?: LlmClient;
  logger?: IntentLogger;
  outletId?: string;
  /** Forces the reply language, overriding what Stage 1 detected. */
  language?: Language;
}

export type ConciergeFn = (query: string, menu: MenuItem[]) => Promise<ConciergeResult>;

function fixedReply(
  message: string,
  matchType: MatchType,
  filter: ParsedFilter | null,
  attempts: number,
): ConciergeResult {
  return {
    message,
    items: [],
    sections: [],
    matchType,
    usedFallback: true,
    guardrailFailures: [],
    filter,
    relaxed: [],
    exactCount: 0,
    shortfalls: [],
    stage1Attempts: attempts,
  };
}

export function createConcierge(deps: ConciergeDeps): ConciergeFn {
  const { intentLlm, responseLlm = intentLlm, logger, outletId = 'unknown' } = deps;
  const defaultLanguage: Language = deps.language ?? 'en';

  return async function concierge(query: string, menu: MenuItem[]): Promise<ConciergeResult> {
    // Stage 0 - deterministic screen, before any model call. A guest who abuses the
    // terminal is answered by a fixed string, and no prompt of theirs is ever sent.
    const screened = screenRequest(query);
    if (screened.kind === 'ABUSIVE') {
      // Stage 1 never runs here, so the language comes from the script alone.
      const lang: Language = detectScript(query) ?? defaultLanguage;
      await logger?.log({
        ts: new Date().toISOString(),
        outlet_id: outletId,
        query,
        ok: true,
        attempts: 0,
        raw: null,
        filter: { request_kind: 'ABUSIVE', screened_by: 'rule', reason: screened.reason },
      });
      return fixedReply(CANNED[lang].ABUSIVE, 'abusive', { ...EMPTY_FILTER, request_kind: 'ABUSIVE', language: lang }, 0);
    }

    // Stage 1 - taxonomy only, never the menu.
    const parsed = await parseIntent({ llm: intentLlm, query, logger, outletId });
    if (!parsed.ok) {
      const lang: Language = detectScript(query) ?? defaultLanguage;
      return fixedReply(CANNED[lang].UNPARSEABLE, 'empty', null, parsed.attempts);
    }
    const filter = parsed.filter;

    // The model's own read of the request, for what the word list cannot catch.
    // An explicit choice from the client wins over what Stage 1 detected.
    const lang: Language = deps.language ?? filter.language;

    if (filter.request_kind === 'ABUSIVE') {
      return fixedReply(CANNED[lang].ABUSIVE, 'abusive', filter, parsed.attempts);
    }
    if (filter.request_kind === 'OFF_TOPIC') {
      return fixedReply(CANNED[lang].OFF_TOPIC, 'off_topic', filter, parsed.attempts);
    }

    const tagDependent = dependsOnTaggedFields(filter);

    // A filter that asks for nothing would match the entire menu. That is never a
    // useful answer, and for "list every item you have" it is the answer the guest
    // was fishing for. Presentation falls back to the week's ranking - the FILTER is
    // left untouched, so what Stage 1 produced is still what gets logged and scored.
    // A mood the guest described fills the gaps they left - lighter when they are tired,
    // the familiar things when they want comforting - and argues with nothing they did say.
    // Applied here, to the presentation filter, so what Stage 1 produced is still what is
    // logged and scored.
    const emptyRequest = isEmptyFilter(filter);
    const presentationFilter: ParsedFilter = applyMood(
      emptyRequest ? { ...filter, sort_by: 'bestseller' } : filter,
    );

    // Stage 2 (+ 2b) - deterministic. Exact matches, else the nearest real dishes,
    // grouped into the sections the guest will see.
    const matches = findMatches(menu, presentationFilter);

    // Stage 3 - grounded generation, guarded.
    const generated = await generateResponse({
      llm: responseLlm,
      query,
      matches,
      menu,
      tagDependent,
      unexpressed: filter.unexpressed,
      lang,
    });

    // What the guest is really being shown. A clarification outranks the rest,
    // because the answer is incomplete until they confirm the part we could not read.
    let matchType: MatchType = matches.matchType;
    if (matchType !== 'empty' && filter.unexpressed.length > 0) matchType = 'clarification';
    else if (matchType === 'exact' && emptyRequest) matchType = 'fallback_default';

    return {
      message: generated.message,
      items: matches.items.map((s) => s.item),
      sections: matches.sections.map((section) => ({
        course: section.course,
        label: COURSE_LABELS[lang][section.course],
        items: section.items.map((s) => s.item),
        totalMatches: section.totalMatches,
      })),
      matchType,
      usedFallback: generated.usedFallback,
      guardrailFailures: generated.guardrailFailures,
      filter,
      relaxed: matches.relaxed,
      exactCount: matches.exactCount,
      shortfalls: [...new Set(matches.items.flatMap((s) => s.shortfalls))],
      stage1Attempts: parsed.attempts,
    };
  };
}
