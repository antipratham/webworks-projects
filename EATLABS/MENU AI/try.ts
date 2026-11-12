/**
 * Type a request, see the menu listing. One command, nothing to install.
 *
 *   node try.ts                      # runs with the built-in rule parser, no model
 *   node try.ts "something spicy"    # one query and exit
 *
 * Point it at a real model by setting LLM_BASE_URL (and LLM_MODEL); everything else
 * is identical, because only the client changes:
 *
 *   LLM_BASE_URL=http://127.0.0.1:11434/v1 LLM_MODEL=qwen3:4b-instruct node try.ts
 */

import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createConcierge } from './src/concierge.ts';
import { createQwenClient, DEFAULT_MODEL } from './src/llm.ts';
import { loadMenuFromFile } from './src/menu_loader.ts';
import { formatRupees } from './src/format.ts';
import { ALLERGEN_LABELS, DIETARY_LABELS, displayName } from './src/i18n.ts';
import { createRuleBasedClient } from './tools/mock_llm_server.ts';

const menu = await loadMenuFromFile(
  fileURLToPath(new URL('./menu_database_200items.json', import.meta.url)),
);

const live = Boolean(process.env.LLM_BASE_URL);
const intentLlm = live ? createQwenClient({ temperature: 0 }) : createRuleBasedClient();
const responseLlm = live ? createQwenClient({ temperature: 0.3 }) : createRuleBasedClient();
const concierge = createConcierge({ intentLlm, responseLlm, outletId: menu.outlet_id });

console.log(`${menu.outlet_name} - ${menu.menu.length} items`);
if (live) {
  console.log(`model: ${process.env.LLM_MODEL ?? DEFAULT_MODEL} at ${process.env.LLM_BASE_URL}`);
} else {
  console.log('model: NONE. Stage 1 is a stub - a few dozen regexes, not a model.');
  console.log('  It only understands phrasings written into it, so anything it has not');
  console.log('  seen reads as off-topic. Stages 2 and 3 are the real thing.');
  console.log('  For real language understanding, point LLM_BASE_URL at a model:');
  console.log('    ollama pull qwen3:4b-instruct');
  console.log('    LLM_BASE_URL=http://127.0.0.1:11434/v1 LLM_MODEL=qwen3:4b-instruct node try.ts');
}

async function ask(query: string): Promise<void> {
  const started = Date.now();
  const result = await concierge(query, menu.menu);
  const ms = Date.now() - started;

  // The concierge answers in whatever the guest typed; the listing follows it.
  const lang = result.filter?.language ?? 'en';

  console.log(`\n${result.message}\n`);
  for (const section of result.sections) {
    console.log(`${section.label}  (${section.totalMatches} matching)`);
    for (const item of section.items) {
      const tags = [
        ...item.dietary.map((d) => DIETARY_LABELS[lang][d]),
        ...item.allergens.map((a) => `${ALLERGEN_LABELS[lang][a]}`),
        ...(item.rank_this_week !== null ? [`#${item.rank_this_week}`] : []),
      ].join(', ');
      const name = displayName(item, lang);
      // Devanagari and Kannada render wider than Latin, so padding is by hand.
      const pad = ' '.repeat(Math.max(1, 30 - [...name].length));
      console.log(`   ${name}${pad} ${formatRupees(item.price_paise).padStart(6)}   ${tags}`);
    }
  }
  const relaxed = result.relaxed.length > 0 ? `, relaxed: ${result.relaxed.join(', ')}` : '';
  console.log(`\n[${result.matchType}, ${lang}${relaxed}, ${ms}ms]`);
}

const argQuery = process.argv.slice(2).join(' ').trim();
if (argQuery) {
  await ask(argQuery);
} else {
  console.log('\nType a request, or blank to quit. Try: spicy food / the bestseller / a light main for 2\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const query = (await rl.question('> ')).trim();
    if (!query) break;
    try {
      await ask(query);
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
    }
    console.log();
  }
  rl.close();
}
