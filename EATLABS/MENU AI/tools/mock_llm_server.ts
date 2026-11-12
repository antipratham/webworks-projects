/**
 * A stand-in for the Qwen server, for testing with no GPU and no download.
 *
 *   node tools/mock_llm_server.ts                    # listens on 127.0.0.1:8099
 *   LLM_BASE_URL=http://127.0.0.1:8099/v1 node eval_scorer.ts mock
 *   LLM_BASE_URL=http://127.0.0.1:8099/v1 node demo.ts
 *
 * It speaks vLLM's OpenAI-compatible API and answers Stage 1 with a rule-based
 * parser and Stage 3 with a plain sentence built from the dishes it was handed.
 *
 * Two things it is good for:
 *
 *   1. Proving the harness. The eval runner, the scorer, the logs and the whole
 *      pipeline can be exercised end to end before any GPU time is spent, so a bug
 *      in the plumbing is not mistaken for a bad model.
 *   2. A floor. The rules below are a few dozen regexes written from the same prompt
 *      the model is given. Whatever they score is the number a real model has to
 *      beat; if Qwen cannot, the problem is the prompt or the wiring, not the model.
 *
 * It is NOT a model and not a substitute for one. It cannot generalise, and it knows
 * only the phrasings written into it.
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { LlmClient, LlmRequest } from '../src/llm.ts';

const PORT = Number(process.env.MOCK_PORT ?? 8099);
const MODEL = 'mock-rule-parser';

// ---------------------------------------------------------------------------
// Stage 1: a rule-based parser, written from the same prompt the model gets
// ---------------------------------------------------------------------------

interface Filter {
  request_kind: string;
  language: string;
  dietary_include: string[];
  dietary_exclude: string[];
  course: string | null;
  basic_tastes: Array<{ taste: string; level: string }>;
  flavor_notes: Array<{ note: string; wanted: boolean }>;
  weight: string | null;
  party_size: number | null;
  sort_by: string | null;
  max_price_paise: number | null;
  unexpressed: string[];
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/**
 * Script decides Hindi and Kannada outright. For Latin text the anchor words decide:
 * a Hinglish or Kanglish sentence is not English just because its food words are.
 */
const HINGLISH = /\b(?:chahiye|chaahiye|kuch|thoda|zyada|bahut|meetha|khatta|namkeen|kadwa|teekha|tikha|masaledar|halka|bhari|bina|sasta|mehenga|khana|khane|mujhe|hai|hain|nahi|accha|batao|dijiye|wala|lokpriya|mashhoor|mithai|shakahari|mansahari)\b/i;
const KANGLISH = /\b(?:beku|yenu|swalpa|jaasti|tumba|sihi|huli|uppu|kahi|khaara|khara|hagura|bhaara|illade|idhe|ide|kodi|thindi|sihitindi|paaneeya|rotti|aggada|dubaari|janapriya|sasyahari|mamsahari|olle|chennagide)\b/i;

function detectLanguage(text: string): string {
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  if (/[ಀ-೿]/.test(text)) return 'kn';
  if (KANGLISH.test(text)) return 'kn';
  if (HINGLISH.test(text)) return 'hi';
  return 'en';
}

/**
 * Hindi and Kannada words, in both scripts, folded into the same English keys the
 * English rules use. Everything downstream sees only taxonomy values.
 */
const TRANSLATIONS: Array<[RegExp, string]> = [
  // sweet
  [/\bmeetha\b|मीठा|\bsihi\b|ಸಿಹಿ/i, ' sweet '],
  // sour
  [/\bkhatta\b|खट्टा|\bhuli\b|ಹುಳಿ/i, ' sour '],
  // salty
  [/\bnamkeen\b|नमकीन|\buppu\b|ಉಪ್ಪು/i, ' salty '],
  // bitter
  [/\bkadwa\b|कड़वा|\bkahi\b|ಕಹಿ/i, ' bitter '],
  // spicy
  [/\bteekha\b|\btikha\b|\bmasaledar\b|तीखा|मसालेदार|\bkhaara\b|\bkhara\b|ಖಾರ/i, ' spicy '],
  // light / heavy
  [/\bhalka\b|हल्का|\bhagura\b|ಹಗುರ/i, ' light '],
  [/\bbhari\b|भारी|\bbhaara\b|ಭಾರ/i, ' heavy '],
  // diet
  [/\bshakahari\b|शाकाहारी|\bsasyahari\b|ಸಸ್ಯಾಹಾರಿ/i, ' vegetarian '],
  [/\bmansahari\b|मांसाहारी|\bmamsahari\b|ಮಾಂಸಾಹಾರಿ/i, ' non-veg '],
  // courses
  [/\bmithai\b|मिठाई|\bsihitindi\b|ಸಿಹಿತಿಂಡಿ/i, ' dessert '],
  [/पेय|\bpaaneeya\b|ಪಾನೀಯ/i, ' beverage '],
  [/रोटी|\brotti\b|ರೊಟ್ಟಿ/i, ' bread '],
  [/सूप|ಸೂಪ್/i, ' soup '],
  [/सलाद|ಸಲಾಡ್/i, ' salad '],
  // price and popularity
  [/\bsasta\b|सस्ता|\baggada\b|ಅಗ್ಗದ/i, ' cheapest '],
  [/\bmehenga\b|महंगा|\bdubaari\b|ದುಬಾರಿ/i, ' most expensive '],
  [/\blokpriya\b|\bmashhoor\b|लोकप्रिय|\bjanapriya\b|ಜನಪ್ರಿಯ/i, ' most popular '],
  // intensity and negation
  [/\bthoda\b|थोड़ा|\bswalpa\b/i, ' not too '],
  [/\bzyada\b|\bbahut\b|ज्यादा|बहुत|\bjaasti\b|\btumba\b/i, ' very '],
  [/\bbina\b|बिना|\billade\b|ಇಲ್ಲದೆ/i, ' without '],
  // "something" / "want", so the food-request check still fires
  [/\bkuch\b|कुछ|\byenu\b|ಏನು/i, ' something '],
  [/\bchahiye\b|\bchaahiye\b|चाहिए|\bbeku\b|ಬೇಕು/i, ' want '],
  [/\bkhana\b|\bkhane\b|खाना|\bthindi\b|ತಿಂಡಿ/i, ' food '],
];

/** Folds the other two languages into the English keywords the rules already know. */
function foldToEnglish(text: string): string {
  let out = ` ${text} `;
  for (const [pattern, replacement] of TRANSLATIONS) {
    out = out.replace(new RegExp(pattern.source, 'gi'), replacement);
  }
  return out;
}

const OFF_TOPIC = [
  /\bweather\b/i,
  /\bbook (?:me )?a table\b/i,
  /\breserve a table\b/i,
  /\bpython|javascript|script|code\b/i,
  /\b(?:medicine|stomach|headache|doctor)\b/i,
  /\bwhat time do you (?:close|open)\b/i,
  /\b(?:closing|opening) (?:time|hours)\b/i,
  /\bwho won\b/i,
  /\bdirections?\b/i,
];

/** Ingredients and attributes the taxonomy cannot carry. */
const UNEXPRESSED = [
  /\bpaneer\b/i,
  /\bchicken\b(?!\s*(?:chettinad))/i,
  /\bcold\b/i,
  /\bhot\b(?!\s*chocolate)/i,
  /\bno onion\b/i,
  /\bno garlic\b/i,
  /\begg(?:s)? (?:are|is) ok/i,
  /\bsouth indian\b/i,
  /\bnorth indian\b/i,
];

export function parseQuery(query: string): Filter {
  const q = foldToEnglish(query).toLowerCase();
  const f: Filter = {
    request_kind: 'MENU',
    language: detectLanguage(query),
    dietary_include: [],
    dietary_exclude: [],
    course: null,
    basic_tastes: [],
    flavor_notes: [],
    weight: null,
    party_size: null,
    sort_by: null,
    max_price_paise: null,
    unexpressed: [],
  };

  if (OFF_TOPIC.some((p) => p.test(q))) {
    f.request_kind = 'OFF_TOPIC';
    return f;
  }

  // --- diet -----------------------------------------------------------------
  if (/\bvegan\b/.test(q)) f.dietary_include.push('vegan');
  // "non veg" is checked first: bare "veg" must not fire on the tail of "non-veg".
  const nonVeg = /\bnon[\s-]?veg(?:etarian)?\b/.test(q);
  if (nonVeg) f.dietary_include.push('non_veg');
  else if (/\b(?:veg|vegetarian|pure veg)\b/.test(q) && !/\bvegan\b/.test(q)) {
    f.dietary_include.push('veg');
  }
  if (/\b(?:don'?t|do not) eat meat\b/.test(q) && !f.dietary_include.includes('veg')) {
    f.dietary_include.push('veg');
  }
  if (/\bjain\b/.test(q)) f.dietary_include.push('jain');
  if (/\bgluten[\s-]?free\b/.test(q)) f.dietary_include.push('gluten_free');

  const allergenWords: Array<[RegExp, string]> = [
    [/\b(?:dairy|milk|lactose)\b/, 'dairy'],
    [/\bgluten\b/, 'gluten'],
    [/\b(?:shellfish|prawn|shrimp)\b/, 'shellfish'],
    [/\bfish\b/, 'fish'],
    [/\begg\b/, 'egg'],
    [/\b(?:peanut|nut|nuts)\b/, 'peanut'],
    [/\bsoy\b/, 'soy'],
    [/\bsesame\b/, 'sesame'],
  ];
  for (const [pattern, allergen] of allergenWords) {
    const source = pattern.source;
    const avoid = new RegExp(
      `(?:no|without|avoid|free of|allergic to|nut[\\s-]?free|${allergen}[\\s-]?free)[^.,;]{0,20}${source}|${source}[\\s-]?free`,
      'i',
    );
    if (avoid.test(q) && !f.dietary_exclude.includes(allergen)) f.dietary_exclude.push(allergen);
  }
  if (/\bnut[\s-]?free\b/.test(q) && !f.dietary_exclude.includes('peanut')) f.dietary_exclude.push('peanut');

  // --- course ---------------------------------------------------------------
  const courses: Array<[RegExp, string]> = [
    [/\b(?:main course|mains?|entree)\b/, 'main'],
    [/\b(?:starters?|appetiser|appetizer|small plate)\b/, 'starter'],
    [/\b(?:dessert|sweet dish|pudding)\b/, 'dessert'],
    [/\b(?:drink|beverage|to drink|something to sip)\b/, 'beverage'],
    [/\b(?:bread|breads|naan|roti|paratha|kulcha)\b/, 'bread'],
    [/\bsoups?\b/, 'soup'],
    [/\bsalads?\b/, 'salad'],
  ];
  for (const [pattern, course] of courses) {
    if (pattern.test(q)) {
      f.course = course;
      break;
    }
  }

  // --- taste ----------------------------------------------------------------
  if (/\b(?:really |very |extra )?sweet\b/.test(q) && !/\bsweet dish\b/.test(q)) {
    f.basic_tastes.push({ taste: 'sweet', level: /\b(?:zero|no|not too|less) sweet/.test(q) ? 'low' : 'high' });
  }
  if (/\b(?:tangy|sour|citrus)\b/.test(q)) {
    f.basic_tastes.push({ taste: 'sour', level: /\b(?:not too|less) sour\b/.test(q) ? 'low' : 'high' });
  }
  if (/\bsalty\b|\bsodium\b/.test(q)) {
    f.basic_tastes.push({ taste: 'salty', level: /\b(?:not too|less|watching)\b/.test(q) ? 'low' : 'high' });
  }
  if (/\bbitter\b/.test(q)) f.basic_tastes.push({ taste: 'bitter', level: 'high' });
  if (/\bumami\b/.test(q)) f.basic_tastes.push({ taste: 'umami', level: 'high' });
  if (/\bbland\b/.test(q)) {
    f.basic_tastes.push({ taste: 'sweet', level: 'low' });
    f.basic_tastes.push({ taste: 'spicy', level: 'low' });
  }

  // Spice is a basic taste with a level, like the others. "hot" is left out on
  // purpose: it means temperature at least as often as spice ("hot coffee"), and
  // guessing wrong is worse than leaving it to the unexpressed list.
  const alreadySpicy = () => f.basic_tastes.some((t) => t.taste === 'spicy');
  if (/\bspic(?:y|e)|\bchilli\b|\bheat\b/.test(q)) {
    const negated =
      /\b(?:not|no|nothing|zero|without|never)\b[^.,;]{0,25}(?:spic|heat)|\bmild\b|\bspice tolerance\b/.test(q);
    if (!alreadySpicy()) f.basic_tastes.push({ taste: 'spicy', level: negated ? 'low' : 'high' });
  } else if (/\bmild\b/.test(q) && !alreadySpicy()) {
    f.basic_tastes.push({ taste: 'spicy', level: 'low' });
  }
  if (/\b(?:creamy|rich)\b/.test(q)) f.flavor_notes.push({ note: 'sweet_creamy', wanted: true });
  if (/\bfruity\b/.test(q)) f.flavor_notes.push({ note: 'fruity', wanted: true });
  if (/\b(?:floral|rose|saffron)\b/.test(q)) f.flavor_notes.push({ note: 'floral_herbal', wanted: true });
  if (/\b(?:savou?ry|pungent|garlicky)\b/.test(q)) f.flavor_notes.push({ note: 'savory_pungent', wanted: true });

  // --- weight ---------------------------------------------------------------
  if (/\b(?:light|not too heavy|nothing too heavy|something small)\b/.test(q)) f.weight = 'light';
  else if (/\b(?:heavy|filling|hearty|substantial)\b/.test(q)) f.weight = 'heavy';

  // --- party size -----------------------------------------------------------
  const digits = q.match(/\b(?:for|there are|we are)\s+(\d{1,2})\b/) ?? q.match(/\b(\d{1,2})\s+(?:people|of us|persons?)\b/);
  const words = q.match(/\b(?:for|between)\s+(?:the\s+)?(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (digits?.[1]) f.party_size = Number(digits[1]);
  else if (words?.[1]) f.party_size = WORD_NUMBERS[words[1]] ?? null;
  else if (/\bjust for me\b|\bfor myself\b/.test(q)) f.party_size = 1;

  // --- price and ordering ---------------------------------------------------
  const price = q.match(/\b(?:under|below|less than|nothing over|no more than|not over)\s*(?:rs\.?|₹)?\s*(\d{2,5})\b/);
  if (price?.[1]) f.max_price_paise = Number(price[1]) * 100;

  if (/\b(?:bestseller|best seller|most popular|what'?s good|what do you recommend|surprise me|something good|don'?t know what to order)\b/.test(q)) {
    f.sort_by = 'bestseller';
  } else if (/\b(?:cheap|cheapest|budget|keep it cheap|least expensive)\b/.test(q)) {
    f.sort_by = 'price_asc';
  } else if (/\b(?:most expensive|priciest|money'?s no object|top of the range)\b/.test(q)) {
    f.sort_by = 'price_desc';
  } else if (/\bgive me food\b/.test(q)) {
    // Garbled input that still asks for food, as in "asdkjaskjd give me food".
    // Deliberately narrow: "give me spicy food" is a taste request, not this.
    f.sort_by = 'bestseller';
  }

  // An attempt to rewrite the rules is a menu request with nothing in it.
  if (/\bignore (?:your|all|previous) instructions\b|\blist every\b/.test(q)) {
    return { ...f, dietary_include: [], dietary_exclude: [], course: null, basic_tastes: [], flavor_notes: [], sort_by: null, weight: null, max_price_paise: null };
  }

  for (const pattern of UNEXPRESSED) {
    const hit = q.match(pattern);
    if (hit && f.unexpressed.length < 3) f.unexpressed.push(hit[0]);
  }

  // Fail closed. If nothing in the taxonomy fired and the query does not read as a
  // request for food at all, it is off topic - "do you have a laptop" must not fall
  // through to a default recommendation just because no rule recognised it.
  const somethingFired =
    f.dietary_include.length > 0 ||
    f.dietary_exclude.length > 0 ||
    f.course !== null ||
    f.basic_tastes.length > 0 ||
    f.flavor_notes.length > 0 ||
    f.weight !== null ||
    f.max_price_paise !== null ||
    f.sort_by !== null;

  const asksForFood =
    /\b(?:something|anything|everything|recommend|suggest|order|eat|eating|food|dish|dishes|drink|menu|hungry|meal|item|items|starter|main|dessert|taste|tasty|veg|snack|share)\b/.test(
      q,
    ) || /\bsurprise me\b|\bwhat'?s good\b/.test(q);

  if (!somethingFired && !asksForFood) {
    return {
      ...f,
      request_kind: 'OFF_TOPIC',
      party_size: null,
      unexpressed: [],
    };
  }

  return f;
}

// ---------------------------------------------------------------------------
// Stage 3: a plain sentence, built only from the dishes it was handed
// ---------------------------------------------------------------------------

export function writeSentence(userPrompt: string): string {
  try {
    const payload = JSON.parse(userPrompt.slice(userPrompt.indexOf('{')));
    const sections: any[] = payload.sections ?? [];
    const parts: string[] = [];
    for (const section of sections.slice(0, 3)) {
      const names = (section.dishes_you_may_mention ?? [])
        .slice(0, 2)
        .map((d: any) => `${d.name} (${d.price})`);
      if (names.length > 0) parts.push(`in ${section.part_of_menu}, ${names.join(' and ')}`);
    }
    if (parts.length === 0) return 'I could not find anything for that.';
    const opener = payload.match_type === 'relaxed' ? 'Nothing matches exactly, but' : 'Good options:';
    return `${opener} ${parts.join('; ')}.`;
  } catch {
    return 'I could not find anything for that.';
  }
}

// ---------------------------------------------------------------------------

/**
 * The same rules as an in-process LlmClient, so `try.ts` can run the whole pipeline
 * with no server, no port and no download.
 */
export function createRuleBasedClient(): LlmClient {
  return {
    async complete(req: LlmRequest): Promise<string> {
      if (!req.responseSchema) return writeSentence(req.user);
      const match = req.user.match(/Guest request:\s*("(?:[^"\\]|\\.)*")/);
      let query = req.user;
      try {
        if (match?.[1]) query = JSON.parse(match[1]);
      } catch {
        /* fall back to the raw prompt */
      }
      return JSON.stringify(parseQuery(query));
    },
  };
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const url = req.url ?? '';

    if (url.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
      return;
    }

    if (!url.endsWith('/chat/completions')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    let body: any = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      res.statusCode = 400;
      res.end('{"error":{"message":"bad json"}}');
      return;
    }

    const userMessage: string = body.messages?.[1]?.content ?? '';
    let content: string;

    if (body.response_format || body.tools) {
      // Stage 1. The query arrives JSON-quoted after "Guest request: ".
      const match = userMessage.match(/Guest request:\s*("(?:[^"\\]|\\.)*")/);
      let query = '';
      try {
        query = match?.[1] ? JSON.parse(match[1]) : userMessage;
      } catch {
        query = userMessage;
      }
      content = JSON.stringify(parseQuery(query));
      process.stdout.write(`  stage1  ${JSON.stringify(query).slice(0, 60)}\n`);
    } else {
      content = writeSentence(userMessage);
      process.stdout.write('  stage3  drafted\n');
    }

    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        model: body.model ?? MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
  });
});

// Only listen when this file is run directly; importing it must not open a port.
const runDirectly = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (runDirectly) server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock LLM (rule-based) on http://127.0.0.1:${PORT}/v1`);
  console.log('This is a test double, not a model. It proves the harness and sets a floor.\n');
  console.log(`  LLM_BASE_URL=http://127.0.0.1:${PORT}/v1 node eval_scorer.ts mock`);
  console.log(`  LLM_BASE_URL=http://127.0.0.1:${PORT}/v1 node demo.ts\n`);
});
