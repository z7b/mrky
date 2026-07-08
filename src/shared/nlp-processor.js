/**
 * Mrky NLP Processor
 * Uses compromise.js to tokenize text and tag parts of speech (POS).
 * Maps each word to a color category for the subtitle overlay.
 */
import nlp from 'compromise';

/**
 * POS color categories matching the Mrky design:
 * - noun  → Blue   (#4299E1)
 * - verb  → Yellow (#ECC94B)
 * - adj   → Green  (#48BB78)
 * - adv   → Purple (#9F7AEA)
 * - other → Default (semi-transparent white)
 */
export const POS_CATEGORIES = {
  noun:  { label: 'noun',  labelAr: 'اسم',  color: '#4299E1', class: 'mrky-noun' },
  verb:  { label: 'verb',  labelAr: 'فعل',  color: '#ECC94B', class: 'mrky-verb' },
  adj:   { label: 'adj',   labelAr: 'صفة',  color: '#48BB78', class: 'mrky-adj' },
  adv:   { label: 'adv',   labelAr: 'ظرف',  color: '#9F7AEA', class: 'mrky-adv' },
  other: { label: 'other', labelAr: 'أخرى', color: 'rgba(255,255,255,0.5)', class: 'mrky-other' },
};

// Common stop words that should appear transparent
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'am',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours',
  'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers',
  'it', 'its', 'they', 'them', 'their', 'theirs',
  'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'whose',
  'if', 'then', 'than', 'when', 'where', 'how', 'why',
  'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same',
  'just', 'also', 'very', 'too', 'quite',
  'up', 'out', 'about', 'over', 'down',
  'there', 'here', 'now', 'then',
]);
// NLP result cache — avoids re-running compromise.js on repeated/similar sentences
const nlpCache = new Map();
const NLP_CACHE_MAX = 100;

/**
 * Analyze a sentence and return an array of tagged word objects.
 * Each object includes the original word, its POS category, and whether it's a stop word.
 * Results are cached by sentence text for instant retrieval on repeated captions.
 *
 * @param {string} sentence - The English sentence to analyze
 * @param {Set<string>} [knownWords=new Set()] - Set of words the user already knows
 * @returns {Array<{word: string, pos: string, posInfo: Object, isStop: boolean, isKnown: boolean}>}
 */
export function analyzeText(sentence, knownWords = new Set()) {
  // Check cache first — if NLP result exists, only refresh known-word flags
  const cached = nlpCache.get(sentence);
  if (cached) {
    // Update isKnown flags (knownWords set may have changed since cache entry was created)
    return cached.map(item => ({
      ...item,
      isKnown: knownWords.has(item.word.toLowerCase()),
    }));
  }

  const doc = nlp(sentence);
  const terms = doc.termList();
  const results = [];

  for (const term of terms) {
    const word = term.text || '';
    const pre = term.pre || '';   // Whitespace/punctuation before the word
    const post = term.post || ''; // Whitespace/punctuation after the word
    const lower = word.toLowerCase();

    // Determine POS category
    let pos = 'other';
    const tags = term.tags || {};

    if (tags.has('Noun') || tags.has('Singular') || tags.has('Plural') || tags.has('ProperNoun')) {
      pos = 'noun';
    } else if (tags.has('Verb') || tags.has('PastTense') || tags.has('PresentTense') ||
               tags.has('Gerund') || tags.has('Infinitive')) {
      pos = 'verb';
    } else if (tags.has('Adjective') || tags.has('Comparative') || tags.has('Superlative')) {
      pos = 'adj';
    } else if (tags.has('Adverb')) {
      pos = 'adv';
    }

    const isStop = STOP_WORDS.has(lower);
    const isKnown = knownWords.has(lower);

    results.push({
      word,
      pre,
      post,
      pos,
      posInfo: POS_CATEGORIES[pos],
      isStop,
      isKnown,
    });
  }

  // Store in cache for instant retrieval on repeated sentences
  if (nlpCache.size >= NLP_CACHE_MAX) {
    // Evict oldest entry (first key in Map iteration order)
    const oldestKey = nlpCache.keys().next().value;
    nlpCache.delete(oldestKey);
  }
  nlpCache.set(sentence, results);

  return results;
}

/**
 * Get just the POS tag for a single word.
 * @param {string} word
 * @returns {Object} POS info from POS_CATEGORIES
 */
export function getWordPOS(word) {
  const doc = nlp(word);
  const terms = doc.termList();
  if (terms.length === 0) return POS_CATEGORIES.other;

  const tags = terms[0].tags || {};

  if (tags.has('Noun') || tags.has('Singular') || tags.has('Plural')) {
    return POS_CATEGORIES.noun;
  } else if (tags.has('Verb') || tags.has('PastTense') || tags.has('PresentTense')) {
    return POS_CATEGORIES.verb;
  } else if (tags.has('Adjective')) {
    return POS_CATEGORIES.adj;
  } else if (tags.has('Adverb')) {
    return POS_CATEGORIES.adv;
  }

  return POS_CATEGORIES.other;
}
