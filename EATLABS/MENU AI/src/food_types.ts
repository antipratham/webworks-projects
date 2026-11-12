/**
 * food_types.ts
 *
 * What a dish is MADE OF, as a guest asks for it: "seafood", "something with paneer",
 * "chicken starters". This is a different axis from course (a seafood starter and a seafood
 * main are both seafood) and from diet (paneer and mushroom are both veg).
 *
 * Why this file exists: before it, "seafood" could not be expressed at all. The parser sent
 * it to `unexpressed`, the filter came back empty, and the page answered a seafood request
 * with Aloo Gobi and Curd Rice - vegetarian dishes, confidently presented.
 *
 * WHERE THE FACT COMES FROM. Nothing is invented. A dish's food types are read from its own
 * name and description, which is the same text the guest would read on the menu: "Prawn
 * Koliwada" is seafood because it says prawn. The derivation runs once at load and the result
 * is stored on the item, so by the time anything is filtered or spoken, a food type is a field
 * the dish carries - not a guess made at question time.
 *
 * Course words (soup, salad, bread, dessert) are deliberately NOT food types. The taxonomy
 * already has a course, and a second field saying the same thing would let a filter contradict
 * itself.
 */

export const FOOD_TYPES = [
  // proteins and the things a guest asks for by name
  'chicken',
  'mutton',
  'seafood',
  'egg',
  'paneer',
  'cheese',
  'mushroom',
  'beans',
  // staples and forms
  'rice',
  'noodles',
  'pasta',
  'pizza',
  'potato',
  'lentil',
  'vegetable',
  // drinks, which guests ask for by kind rather than by course
  'coffee',
  'tea',
  'juice',
] as const;
export type FoodType = (typeof FOOD_TYPES)[number];

/**
 * The words that put a dish in a type, matched against its own name and description.
 *
 * Word edges matter: "meen" must not fire inside "meenu", and "egg" must not fire inside
 * "eggplant", which is a vegetable and the opposite of what the guest asked for.
 */
const PATTERNS: ReadonlyArray<readonly [FoodType, RegExp]> = [
  ['chicken', /\b(chicken|murg|murgh)\b/i],
  ['mutton', /\b(mutton|lamb|keema|rogan\s*josh|gosht)\b/i],
  [
    'seafood',
    /\b(fish|prawn|prawns|shrimp|crab|squid|calamari|pomfret|sea\s*bass|scallop|scallops|koliwada|meen|anchovy|tuna|salmon)\b/i,
  ],
  // "eggplant" and "egg-free" are not egg dishes.
  ['egg', /\begg(?!plant|\s*free|-free)s?\b|\bomelette\b|\bakuri\b|\bbhurji\b/i],
  ['paneer', /\bpaneer\b/i],
  ['cheese', /\b(cheese|cheesy|mozzarella|burrata|parmesan)\b/i],
  ['mushroom', /\b(mushroom|mushrooms|truffle)\b/i],
  ['beans', /\b(rajma|chole|chana|chickpea|chickpeas|lobia|beans)\b/i],
  ['rice', /\b(rice|biryani|pulao|pulav|khichdi|risotto)\b/i],
  ['noodles', /\b(noodle|noodles|hakka|chowmein|chow\s*mein|ramen)\b/i],
  ['pasta', /\b(pasta|penne|spaghetti|alfredo|lasagne|lasagna|macaroni)\b/i],
  ['pizza', /\bpizza\b/i],
  ['potato', /\b(potato|potatoes|aloo)\b/i],
  ['lentil', /\b(dal|daal|lentil|lentils|sambar|rasam|sambhar)\b/i],
  ['vegetable', /\b(vegetable|vegetables|veg\s*(?:manchurian|korma|kofta)|subzi|sabzi|korma|navratan)\b/i],
  ['coffee', /\b(coffee|latte|espresso|cappuccino|mocha|americano)\b/i],
  ['tea', /\b(tea|chai)\b/i],
  ['juice', /\b(juice|lassi|smoothie|shake|mojito|soda|buttermilk|chaas|jaljeera|sharbat|cooler)\b/i],
];

const FOOD_TYPE_SET: ReadonlySet<string> = new Set(FOOD_TYPES);
export const isFoodType = (v: unknown): v is FoodType =>
  typeof v === 'string' && FOOD_TYPE_SET.has(v);

/**
 * Every food type a dish carries, from its own name and description. A dish may carry
 * several - "Chicken Fried Rice" is chicken and rice, and a guest asking for either should
 * find it.
 */
export function foodTypesOf(name: string, description: string): FoodType[] {
  const text = `${name ?? ''} ${description ?? ''}`;
  const found: FoodType[] = [];
  for (const [type, pattern] of PATTERNS) {
    if (pattern.test(text)) found.push(type);
  }
  return found;
}
