/**
 * The guest web app: a menu you can browse, ask questions of, open a dish from, and
 * add to an order.
 *
 *   node serve.ts                 # http://127.0.0.1:3000
 *   PORT=8080 node serve.ts
 *
 * With LLM_BASE_URL set it uses that model; without it, the rule-based stub, so the
 * page is usable with nothing installed.
 *
 * The rule the whole codebase follows applies here too: the browser captures and
 * displays, the server decides. Prices and totals are recomputed here from the menu
 * on every order - a quantity that arrives from the page is the only thing trusted.
 */

import { createServer } from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createConcierge } from './src/concierge.ts';
import { createQwenClient, DEFAULT_MODEL } from './src/llm.ts';
import { createFileLogger } from './src/logger.ts';
import { loadMenuFromFile } from './src/menu_loader.ts';
import { createRuleBasedClient } from './tools/mock_llm_server.ts';
import { applySort, matchesFilter } from './src/menu_filter.ts';
import { EMPTY_FILTER } from './src/intent_parser.ts';
import { FOOD_TYPES } from './src/food_types.ts';
import { ALLERGENS, COURSES, COURSE_ORDER, DIETARY_TAGS, SORT_OPTIONS, WEIGHTS } from './src/taxonomy.ts';
import type { ParsedFilter } from './src/types.ts';
import { COURSE_LABELS, UI, displayDescription, displayName, isLanguage } from './src/i18n.ts';
import type { Language } from './src/i18n.ts';
import type { MenuItem } from './src/types.ts';

const PORT = Number(process.env.PORT ?? 3000);
// The speech-to-text service of the voice agent, reused so the menu can be spoken to as
// well as typed at. Unset means the microphone button has nothing to talk to.
const STT_URL = process.env.STT_URL ?? '';
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const menu = await loadMenuFromFile(here('./menu_database_200items.json'));
const byId = new Map(menu.menu.map((item) => [item.id, item]));

const live = Boolean(process.env.LLM_BASE_URL);
const clients = {
  intentLlm: live ? createQwenClient({ temperature: 0 }) : createRuleBasedClient(),
  responseLlm: live ? createQwenClient({ temperature: 0.3 }) : createRuleBasedClient(),
  logger: createFileLogger('logs/intent.jsonl'),
  outletId: menu.outlet_id,
};
/** Detects the language from the request. */
const concierge = createConcierge(clients);
/** One per forced language, built once. */
const forcedConcierges = new Map<Language, ReturnType<typeof createConcierge>>();
const conciergeIn = (language: Language) => {
  let made = forcedConcierges.get(language);
  if (!made) {
    made = createConcierge({ ...clients, language });
    forcedConcierges.set(language, made);
  }
  return made;
};

/** Items as the browser needs them: translated name and description, everything else as stored. */
function forClient(item: MenuItem, lang: Language) {
  return { ...item, name: displayName(item, lang), description: displayDescription(item, lang) };
}

/** The whole menu, grouped the way the answer screens group it. */
function browseSections(lang: Language) {
  return COURSE_ORDER.map((course) => {
    const items = menu.menu.filter((i) => i.course === course);
    return {
      course,
      label: COURSE_LABELS[lang][course],
      totalMatches: items.length,
      items: items.map((i) => forClient(i, lang)),
    };
  }).filter((section) => section.items.length > 0);
}

/** ?lang=hi, falling back to English for anything unrecognised. */
function langOf(url: URL): Language {
  const value = url.searchParams.get('lang');
  return isLanguage(value) ? value : 'en';
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(here('./web/index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Dish images. The backend drops files into web/images/ at deployment and sets
    // each item's image_url to "/images/<file>"; nothing else needs to change.
    if (req.method === 'GET' && url.pathname.startsWith('/images/')) {
      const name = url.pathname.slice('/images/'.length);
      // No traversal: a filename only, and an extension we are willing to serve.
      if (!/^[A-Za-z0-9._-]+\.(png|jpe?g|webp|avif|gif|svg)$/.test(name)) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad image name');
        return;
      }
      try {
        const file = await readFile(here(`./web/images/${name}`));
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
        const type =
          ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' });
        res.end(file);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no image');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/menu') {
      const lang = langOf(url);
      json(res, 200, {
        outlet: menu.outlet_name,
        model: live ? (process.env.LLM_MODEL ?? DEFAULT_MODEL) : null,
        lang,
        ui: UI[lang],
        sections: browseSections(lang),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const body = await readBody(req);
      const query = typeof body.query === 'string' ? body.query.slice(0, 400).trim() : '';
      if (!query) {
        json(res, 400, { error: 'query is required' });
        return;
      }
      // An explicit ?lang wins; otherwise the concierge answers in whatever the
      // guest typed, and tells us which language that was.
      const requested = url.searchParams.get('lang');
      const forced = isLanguage(requested) ? requested : undefined;
      const result = await (forced ? conciergeIn(forced) : concierge)(query, menu.menu);
      const lang: Language = forced ?? result.filter?.language ?? 'en';
      json(res, 200, {
        // What Stage 1 made of the request. The page shows it only with ?debug, but it is
        // always sent: testing a parser you cannot see is guesswork.
        filter: result.filter ?? null,
        message: result.message,
        matchType: result.matchType,
        relaxed: result.relaxed,
        exactCount: result.exactCount,
        lang,
        ui: UI[lang],
        sections: result.sections.map((s) => ({ ...s, items: s.items.map((i) => forClient(i, lang)) })),
      });
      return;
    }

    // Spoken queries. The page records raw PCM and sends a WAV; this hands the multipart
    // body straight to the speech service without parsing it, so there is nothing here to
    // keep in step with the browser. The audio is forwarded and not written to disk.
    if (req.method === 'POST' && url.pathname === '/api/transcribe') {
      if (!STT_URL) {
        json(res, 503, { error: 'speech to text is not configured (set STT_URL)' });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try {
        const upstream = await fetch(`${STT_URL}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] ?? 'application/octet-stream' },
          body: Buffer.concat(chunks),
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(text);
      } catch (err) {
        json(res, 502, { error: `speech service unreachable: ${(err as Error).message}` });
      }
      return;
    }

    // Browsing, not being recommended. /api/ask shortlists - a concierge names two or three
    // dishes, not fifty-three - but a guest working the filters has asked to see what there is,
    // so this returns every match. No model is involved: the filter arrives already structured,
    // so Stages 1 and 3 have nothing to do and the answer is the same every time.
    if (req.method === 'POST' && url.pathname === '/api/filter') {
      const body = await readBody(req);
      const lang = langOf(url);
      const pick = <T extends readonly string[]>(value: unknown, allowed: T) =>
        typeof value === 'string' && (allowed as readonly string[]).includes(value)
          ? (value as T[number])
          : null;
      const pickMany = <T extends readonly string[]>(value: unknown, allowed: T) =>
        Array.isArray(value)
          ? value.filter((v): v is T[number] => typeof v === 'string' && (allowed as readonly string[]).includes(v))
          : [];

      const filter: ParsedFilter = {
        ...EMPTY_FILTER,
        course: pick(body.course, COURSES),
        dietary_include: pickMany(body.dietary_include, DIETARY_TAGS),
        dietary_exclude: [...pickMany(body.dietary_exclude, DIETARY_TAGS),
                          ...pickMany(body.dietary_exclude, ALLERGENS)],
        weight: pick(body.weight, WEIGHTS),
        food_types: pickMany(body.food_types, FOOD_TYPES),
        sort_by: pick(body.sort_by, SORT_OPTIONS),
        max_price_paise:
          Number.isInteger(body.max_price_paise) && body.max_price_paise > 0
            ? (body.max_price_paise as number)
            : null,
      };

      const matched = applySort(menu.menu.filter((item) => matchesFilter(item, filter)), filter);
      const byCourse = new Map<string, MenuItem[]>();
      for (const item of matched) {
        const list = byCourse.get(item.course) ?? [];
        list.push(item);
        byCourse.set(item.course, list);
      }
      const sections = COURSE_ORDER.filter((c) => byCourse.has(c)).map((course) => ({
        course,
        label: COURSE_LABELS[lang]?.[course] ?? course,
        count: byCourse.get(course)!.length,
        items: byCourse.get(course)!.map((item) => forClient(item, lang)),
      }));
      json(res, 200, { total: matched.length, sections, filter, lang, ui: UI[lang] });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/order') {
      const body = await readBody(req);
      const wanted: Array<{ id?: unknown; qty?: unknown }> = Array.isArray(body.items) ? body.items : [];

      // Only the quantity is taken from the page. The dish and its price come from
      // the menu, so a tampered or stale price in the browser cannot be ordered.
      const lines: Array<{ id: string; name: string; qty: number; price_paise: number; line_paise: number }> = [];
      for (const entry of wanted) {
        const item = typeof entry.id === 'string' ? byId.get(entry.id) : undefined;
        const qty = Math.min(20, Math.max(1, Math.round(Number(entry.qty) || 0)));
        if (!item || !Number.isFinite(qty) || qty < 1) continue;
        lines.push({
          id: item.id,
          name: item.name,
          qty,
          price_paise: item.price_paise,
          line_paise: item.price_paise * qty,
        });
      }

      if (lines.length === 0) {
        json(res, 400, { error: 'no valid items in the order' });
        return;
      }

      const order = {
        order_id: `ORD-${Date.now().toString(36).toUpperCase()}`,
        outlet_id: menu.outlet_id,
        placed_at: new Date().toISOString(),
        lines,
        total_paise: lines.reduce((sum, l) => sum + l.line_paise, 0),
      };

      // Where a real build would hand off to the POS, or to the staff app when POS
      // write-back is unavailable. Here it is recorded and handed back.
      await mkdir('logs', { recursive: true }).catch(() => {});
      await appendFile('logs/orders.jsonl', `${JSON.stringify(order)}\n`, 'utf8').catch(() => {});
      json(res, 200, order);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`${menu.outlet_name} - ${menu.menu.length} items`);
  console.log(
    live
      ? `model: ${process.env.LLM_MODEL ?? DEFAULT_MODEL} at ${process.env.LLM_BASE_URL}`
      : 'model: NONE - Stage 1 is the regex stub. Set LLM_BASE_URL for real understanding.',
  );
  console.log(`\n  open http://127.0.0.1:${PORT}\n`);
});

export type { MenuItem };
