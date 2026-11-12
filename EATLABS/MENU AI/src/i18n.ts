/**
 * Guest-facing language.
 *
 * Three display languages - English, Hindi, Kannada - and five ways a guest may
 * type: any of the three plus Hinglish and Kanglish (Hindi or Kannada written in
 * Latin letters, which is how most people actually type on a phone).
 *
 * Nothing here is generated at runtime. Every guest-facing string is written down,
 * so what a guest reads never depends on what a model felt like saying, and a
 * translator can work on this file without touching any logic.
 *
 * The taxonomy itself stays in English: `spicy_warm` is a tag, not a word. Only its
 * label changes per language, which is why Stages 2 and 2b need no translation at all.
 */

import type { Allergen, BasicTaste, Course, DietaryTag, FlavorNote } from './taxonomy.ts';

export const LANGUAGES = ['en', 'hi', 'kn'] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_NAME: Record<Language, string> = {
  en: 'English',
  hi: 'हिंदी',
  kn: 'ಕನ್ನಡ',
};

export const isLanguage = (v: unknown): v is Language =>
  typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);

/**
 * Script is decisive when it is present: Devanagari is Hindi, Kannada script is
 * Kannada. Latin text is ambiguous (English, Hinglish or Kanglish), so it is left
 * to Stage 1 to judge from the words.
 */
export function detectScript(text: string): Language | null {
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  if (/[ಀ-೿]/.test(text)) return 'kn';
  return null;
}

// ---------------------------------------------------------------------------
// Taxonomy labels
// ---------------------------------------------------------------------------

export const COURSE_LABELS: Record<Language, Record<Course, string>> = {
  en: {
    starter: 'Starters', soup: 'Soups', salad: 'Salads', main: 'Mains',
    bread: 'Breads', dessert: 'Desserts', beverage: 'Drinks',
  },
  hi: {
    starter: 'स्टार्टर',
    soup: 'सूप',
    salad: 'सलाद',
    main: 'मुख्य व्यंजन',
    bread: 'रोटी और नान',
    dessert: 'मिठाई',
    beverage: 'पेय',
  },
  kn: {
    starter: 'ಸ್ಟಾರ್ಟರ್‌ಗಳು',
    soup: 'ಸೂಪ್‌ಗಳು',
    salad: 'ಸಲಾಡ್‌ಗಳು',
    main: 'ಮುಖ್ಯ ಖಾದ್ಯಗಳು',
    bread: 'ರೊಟ್ಟಿಗಳು',
    dessert: 'ಸಿಹಿತಿಂಡಿಗಳು',
    beverage: 'ಪಾನೀಯಗಳು',
  },
};

export const DIETARY_LABELS: Record<Language, Record<DietaryTag, string>> = {
  en: { veg: 'veg', non_veg: 'non-veg', vegan: 'vegan', jain: 'jain', gluten_free: 'gluten-free' },
  hi: {
    veg: 'शाकाहारी',
    non_veg: 'मांसाहारी',
    vegan: 'वीगन',
    jain: 'जैन',
    gluten_free: 'ग्लूटन-मुक्त',
  },
  kn: {
    veg: 'ಸಸ್ಯಾಹಾರಿ',
    non_veg: 'ಮಾಂಸಾಹಾರಿ',
    vegan: 'ವೀಗನ್',
    jain: 'ಜೈನ',
    gluten_free: 'ಗ್ಲುಟೆನ್ ರಹಿತ',
  },
};

export const ALLERGEN_LABELS: Record<Language, Record<Allergen, string>> = {
  en: {
    dairy: 'dairy', gluten: 'gluten', shellfish: 'shellfish', fish: 'fish', egg: 'egg',
    peanut: 'peanut', tree_nut: 'tree nuts', soy: 'soy', sesame: 'sesame', mustard: 'mustard',
  },
  hi: {
    dairy: 'डेयरी', gluten: 'ग्लूटन',
    shellfish: 'शेलफ़िश', fish: 'मछली',
    egg: 'अंडा', peanut: 'मूंगफली',
    tree_nut: 'मेवा', soy: 'सोया',
    sesame: 'तिल', mustard: 'सरसों',
  },
  kn: {
    dairy: 'ಹಾಲಿನ ಪದಾರ್ಥ',
    gluten: 'ಗ್ಲುಟೆನ್',
    shellfish: 'ಚಿಪ್ಪುಮೀನು',
    fish: 'ಮೀನು', egg: 'ಮೋಟ್ಟೆ',
    peanut: 'ಕಡಲೆಕಾಯಿ',
    tree_nut: 'ಡ್ರೈಫ್ರೂಟ್ಸ್',
    soy: 'ಸೋಯಾ', sesame: 'ಎಳ್ಳು',
    mustard: 'ಸಾಸಿವೆ',
  },
};

export const TASTE_LABELS: Record<Language, Record<BasicTaste, string>> = {
  en: { sweet: 'sweet', sour: 'sour', salty: 'salty', bitter: 'bitter', umami: 'umami', spicy: 'spicy' },
  hi: {
    sweet: 'मीठा', sour: 'खट्टा',
    salty: 'नमकीन', bitter: 'कड़वा',
    umami: 'उमामी',
    spicy: 'तीखा',
  },
  kn: {
    sweet: 'ಸಿಹಿ', sour: 'ಹುಳಿ',
    salty: 'ಉಪ್ಪು', bitter: 'ಕಹಿ',
    umami: 'ಉಮಾಮಿ',
    spicy: 'ಖಾರ',
  },
};

export const FLAVOR_LABELS: Record<Language, Record<FlavorNote, string>> = {
  en: {
    fruity: 'fruity', sweet_creamy: 'creamy', spicy_warm: 'spicy',
    floral_herbal: 'floral', savory_pungent: 'savoury',
  },
  hi: {
    fruity: 'फलों जैसा',
    sweet_creamy: 'मलाईदार',
    spicy_warm: 'तीखा',
    floral_herbal: 'फूलों जैसा',
    savory_pungent: 'चटपटा',
  },
  kn: {
    fruity: 'ಹಣ್ಣಿನ ರುಚಿ',
    sweet_creamy: 'ಕೆನೆಭರಿತ',
    spicy_warm: 'ಖಾರ',
    floral_herbal: 'ಹೂವಿನ ಸುವಾಸನೆ',
    savory_pungent: 'ಘಾಟು',
  },
};

// ---------------------------------------------------------------------------
// Fixed replies
// ---------------------------------------------------------------------------

export const CANNED: Record<Language, { ABUSIVE: string; OFF_TOPIC: string; UNPARSEABLE: string }> = {
  en: {
    ABUSIVE: "I'm here to help you order. Tell me what you feel like eating and I'll find it.",
    OFF_TOPIC:
      'I can only help with this menu — dishes, drinks, flavours, prices and dietary needs. What are you in the mood for?',
    UNPARSEABLE:
      'I could not quite follow that — could you tell me again what you feel like eating?',
  },
  hi: {
    ABUSIVE:
      'मैं ऑर्डर में मदद के लिए हूँ। बताइए आप क्या खाना चाहेंगे।',
    OFF_TOPIC:
      'मैं सिर्फ इस मेन्यू में मदद कर सकता हूँ — व्यंजन, पेय, स्वाद, कीमत और खान-पान संबंधी जरूरतें। आपका क्या मन है?',
    UNPARSEABLE:
      'मैं ठीक से समझ नहीं पाया — क्या आप फिर से बताएंगे कि आप क्या खाना चाहते हैं?',
  },
  kn: {
    ABUSIVE:
      'ನಾನು ಆರ್ಡರ್ ಮಾಡಲು ಸಹಾಯ ಮಾಡಲು ಇದ್ದೇನೆ. ನಿಮಗೆ ಏನು ತಿನ್ನಬೇಕು ಎಂದು ಹೇಳಿ.',
    OFF_TOPIC:
      'ನಾನು ಈ ಮೆನುಬಗ್ಗೆ ಮಾತ್ರ ಸಹಾಯ ಮಾಡಬಲ್ಲೆ — ಖಾದ್ಯ, ಪಾನೀಯ, ರುಚಿ, ಬೆಲೆ ಮತ್ತು ಆಹಾರ ಅಗತ್ಯಗಳು. ನಿಮಗೆ ಏನು ಬೇಕು?',
    UNPARSEABLE:
      'ನನಗೆ ಸರಿಯಾಗಿ ಅರ್ಥವಾಗಲಿಲ್ಲ — ನಿಮಗೆ ಏನು ತಿನ್ನಬೇಕೆಂದು ಮತ್ತೆ ಹೇಳಿರಾ?',
  },
};

// ---------------------------------------------------------------------------
// Sentences the deterministic fallback builds
// ---------------------------------------------------------------------------

export interface Phrases {
  /** "A few things fit that: X." */
  fits: (listed: string) => string;
  fitsOne: (listed: string) => string;
  /** "That runs across the menu: X." */
  spread: (listed: string) => string;
  /** "Nothing matches exactly. The closest I have is X." */
  closest: (listed: string) => string;
  worthKnowing: (caveats: string) => string;
  /** The empty-result lines. */
  noneTagged: string;
  none: string;
  /** "in Starters, X" */
  inSection: (label: string, listed: string) => string;
  /** "You also mentioned "cold" - the menu data does not record that..." */
  unexpressed: (quoted: string) => string;
  and: string;
  each: string;
  contains: (list: string) => string;
  rank: (n: number) => string;
  bestseller: string;
}

export const PHRASES: Record<Language, Phrases> = {
  en: {
    fits: (l) => `A few things fit that: ${l}.`,
    fitsOne: (l) => `One thing fits that: ${l}.`,
    spread: (l) => `That runs across the menu: ${l}.`,
    closest: (l) => `Nothing on the menu matches that exactly. The closest I have is ${l}.`,
    worthKnowing: (c) => ` Worth knowing — ${c}.`,
    noneTagged: 'I cannot confirm that from our menu data — please ask your server.',
    none: 'I could not find anything on our menu for that — please ask your server.',
    inSection: (label, l) => `in ${label}, ${l}`,
    unexpressed: (q) =>
      ` You also mentioned ${q} — the menu data does not record that, so please check with your server.`,
    and: 'and',
    each: 'each',
    contains: (l) => `contains ${l}`,
    rank: (n) => `#${n} this week`,
    bestseller: 'a bestseller',
  },
  hi: {
    fits: (l) => `इसके लिए ये ठीक रहेंगे: ${l}।`,
    fitsOne: (l) => `इसके लिए यह ठीक रहेगा: ${l}।`,
    spread: (l) => `यह पूरे मेन्यू में मिलेगा: ${l}।`,
    closest: (l) =>
      `मेन्यू में ठीक वैसा कुछ नहीं है। सबसे करीब यह है: ${l}।`,
    worthKnowing: (c) => ` ध्यान दें — ${c}।`,
    noneTagged:
      'मैं इसकी पुष्टि नहीं कर सकता — कृपया अपने सर्वर से पूछें।',
    none: 'इसके लिए मेन्यू में कुछ नहीं मिला — कृपया अपने सर्वर से पूछें।',
    inSection: (label, l) => `${label} में ${l}`,
    unexpressed: (q) =>
      ` आपने ${q} भी कहा — मेन्यू डेटा में यह दर्ज नहीं है, इसलिए अपने सर्वर से पूछ लें।`,
    and: 'और',
    each: 'प्रति',
    contains: (l) => `${l} है`,
    rank: (n) => `इस हफ्ते #${n}`,
    bestseller: 'लोकप्रिय',
  },
  kn: {
    fits: (l) => `ಇದಕ್ಕೆ ಇವು ಸೂಕ್ತ: ${l}.`,
    fitsOne: (l) => `ಇದಕ್ಕೆ ಇದು ಸೂಕ್ತ: ${l}.`,
    spread: (l) => `ಇದು ಮೆನುವಿನೆಲ್ಲೆಡೆ ಸಿಗುತ್ತದೆ: ${l}.`,
    closest: (l) =>
      `ಮೆನುವಲ್ಲಿ ಹಾಗೆಯೇ ಏನೂ ಇಲ್ಲ. ಅತ್ಯಂತ ಹತ್ತಿರದದ್ದು: ${l}.`,
    worthKnowing: (c) => ` ಗಮನಿಸಿ — ${c}.`,
    noneTagged:
      'ನಮ್ಮ ಮೆನು ಡೇಟಾದಿಂದ ನಾನು ಇದನ್ನು ಖಚಿತಪಡಿಸಲಾಗುವುದಿಲ್ಲ — ದಯವಿಟ್ಟು ಸರ್ವರ್ ಅವರನ್ನು ಕೇಳಿ.',
    none: 'ಇದಕ್ಕೆ ಮೆನುವಲ್ಲಿ ಏನೂ ಸಿಗಲಿಲ್ಲ — ದಯವಿಟ್ಟು ಸರ್ವರ್ ಅವರನ್ನು ಕೇಳಿ.',
    inSection: (label, l) => `${label}ನಲ್ಲಿ ${l}`,
    unexpressed: (q) =>
      ` ನೀವು ${q} ಎಂದೂ ಹೇಳಿದಿರಿ — ಮೆನು ಡೇಟಾದಲ್ಲಿ ಅದು ದಾಖಲಾಗಿಲ್ಲ, ದಯವಿಟ್ಟು ಸರ್ವರ್ ಅವರನ್ನು ಕೇಳಿ.`,
    and: 'ಮತ್ತು',
    each: 'ಪ್ರತಿ',
    contains: (l) => `${l} ಇದೆ`,
    rank: (n) => `ಈ ವಾರ #${n}`,
    bestseller: 'ಜನಪ್ರಿಯ',
  },
};

// ---------------------------------------------------------------------------
// Web app strings
// ---------------------------------------------------------------------------

export const UI: Record<Language, Record<string, string>> = {
  en: {
    heading: 'What are you in the mood for?',
    placeholder: 'something spicy, no dairy…',
    ask: 'Ask',
    matching: 'matching',
    item: 'item', items: 'items',
    inYourOrder: 'in your order',
    contains: 'Contains:',
    noAllergens: 'No allergens listed',
    notTagged: 'Not fully tagged.',
    notTaggedHelp: 'Please ask your server about ingredients and allergens.',
    forThisDish: 'for this dish.',
    close: 'Close', add: 'Add',
    yourOrder: 'Your order', nothingAdded: 'Nothing added yet.',
    total: 'Total', placeOrder: 'Place order', keepBrowsing: 'Keep browsing',
    view: 'View', each: 'each',
    orderPlaced: 'Order placed', sentToKitchen: 'sent to the kitchen.', done: 'Done',
    serverNote: 'The total is recalculated by the server from the menu when you place the order.',
    showMenu: 'Show the menu',
    p1: 'the bestseller', p2: 'something spicy', p3: 'vegan options',
    p4: 'something light', p5: 'under ₹200',
    nothingToShow: 'Nothing to show.',
  },
  hi: {
    heading: 'आज क्या खाने का मन है?',
    placeholder: 'कुछ तीखा, बिना डेयरी…',
    ask: 'पूछें',
    matching: 'मिलते हैं',
    item: 'व्यंजन', items: 'व्यंजन',
    inYourOrder: 'आपके ऑर्डर में',
    contains: 'इसमें है:',
    noAllergens: 'कोई एलर्जेन दर्ज नहीं',
    notTagged: 'पूरी जानकारी नहीं।',
    notTaggedHelp:
      'सामग्री और एलर्जेन के बारे में अपने सर्वर से पूछें।',
    forThisDish: 'इस व्यंजन के लिए।',
    close: 'बंद करें', add: 'जोड़ें',
    yourOrder: 'आपका ऑर्डर',
    nothingAdded: 'अभी कुछ नहीं जोड़ा।',
    total: 'कुल', placeOrder: 'ऑर्डर करें',
    keepBrowsing: 'और देखें', view: 'देखें',
    each: 'प्रति',
    orderPlaced: 'ऑर्डर हो गया',
    sentToKitchen: 'रसोई में भेज दिया गया।',
    done: 'ठीक है',
    serverNote:
      'ऑर्डर करते समय कुल राशि सर्वर पर मेन्यू से दोबारा गिनी जाती है।',
    showMenu: 'पूरा मेन्यू',
    p1: 'सबसे लोकप्रिय',
    p2: 'कुछ तीखा',
    p3: 'वीगन विकल्प',
    p4: 'कुछ हल्का',
    p5: '₹200 से कम',
    nothingToShow: 'दिखाने को कुछ नहीं।',
  },
  kn: {
    heading: 'ನಿಮಗೆ ಇಂದು ಏನು ತಿನ್ನಬೇಕು?',
    placeholder: 'ಏನಾದರೂ ಖಾರ, ಹಾಲಿಲ್ಲದೆ…',
    ask: 'ಕೇಳಿ',
    matching: 'ಹೊಂದುತ್ತವೆ',
    item: 'ಖಾದ್ಯ', items: 'ಖಾದ್ಯಗಳು',
    inYourOrder: 'ನಿಮ್ಮ ಆರ್ಡರ್‌ನಲ್ಲಿ',
    contains: 'ಒಳಗೊಂಡಿದೆ:',
    noAllergens: 'ಯಾವುದೇ ಅಲರ್ಜಿ ದಾಖಲಾಗಿಲ್ಲ',
    notTagged: 'ಪೂರ್ಣ ಮಾಹಿತಿ ಇಲ್ಲ.',
    notTaggedHelp:
      'ಪದಾರ್ಥಗಳು ಮತ್ತು ಅಲರ್ಜಿ ಬಗ್ಗೆ ದಯವಿಟ್ಟು ಸರ್ವರ್ ಅವರನ್ನು ಕೇಳಿ.',
    forThisDish: 'ಈ ಖಾದ್ಯಕ್ಕೆ.',
    close: 'ಮುಚ್ಚಿ', add: 'ಸೇರಿಸಿ',
    yourOrder: 'ನಿಮ್ಮ ಆರ್ಡರ್',
    nothingAdded: 'ಇನ್ನೂ ಏನೂ ಸೇರಿಸಿಲ್ಲ.',
    total: 'ಒಟ್ಟು', placeOrder: 'ಆರ್ಡರ್ ಮಾಡಿ',
    keepBrowsing: 'ಮತ್ತೆ ನೋಡಿ', view: 'ನೋಡಿ',
    each: 'ಪ್ರತಿ',
    orderPlaced: 'ಆರ್ಡರ್ ಆಯಿತು',
    sentToKitchen: 'ಅಡುಗೆಗೆ ಕಳುಹಿಸಲಾಗಿದೆ.',
    done: 'ಸರಿ',
    serverNote:
      'ಆರ್ಡರ್ ಮಾಡುವಾಗ ಒಟ್ಟು ಮೊತ್ತವನ್ನು ಸರ್ವರ್ ಮೆನುವಿಂದ ಮತ್ತೆ ಲೆಕ್ಕ ಹಾಕುತ್ತದೆ.',
    showMenu: 'ಸಂಪೂರ್ಣ ಮೆನು',
    p1: 'ಅತ್ಯಂತ ಜನಪ್ರಿಯ',
    p2: 'ಏನಾದರೂ ಖಾರ',
    p3: 'ವೀಗನ್ ಆಯ್ಕೆಗಳು',
    p4: 'ಏನಾದರೂ ಹಗುರ',
    p5: '₹200 কಕ್ಕಿಂತ ಕಡಿಮೆ',
    nothingToShow: 'ತೋರಿಸಲು ಏನೂ ಇಲ್ಲ.',
  },
};

/**
 * The dish name and description a guest should see. English is the fallback for any
 * language not yet translated, which is what makes a partly translated menu usable.
 */
export function displayName(
  item: { name: string; i18n: Partial<Record<Language, { name: string; description: string }>> },
  lang: Language,
): string {
  return item.i18n[lang]?.name?.trim() || item.name;
}

export function displayDescription(
  item: {
    description: string;
    i18n: Partial<Record<Language, { name: string; description: string }>>;
  },
  lang: Language,
): string {
  return item.i18n[lang]?.description?.trim() || item.description;
}

/** "a, b and c", in the guest's language. */
export function joinWordsIn(parts: string[], lang: Language): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(', ')} ${PHRASES[lang].and} ${parts[parts.length - 1]}`;
}
