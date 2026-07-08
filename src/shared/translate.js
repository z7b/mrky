/**
 * Mrky Translation Utility
 * Uses the free MyMemory Translation API (no API key required).
 * Translates English → Arabic by default.
 * 
 * Rate limit: ~5 requests/second, 1000/day for anonymous users.
 * For higher limits, users can register a free key.
 */

const API_BASE = 'https://api.mymemory.translated.net/get';
const CACHE_KEY = 'mrky_translation_cache';
const MAX_CACHE_SIZE = 2000; // Maximum cached translations before eviction

// In-memory cache to avoid redundant API calls
let translationCache = {};

/**
 * Initialize cache from chrome.storage.local (persists across sessions).
 */
async function loadCache() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      const data = await chrome.storage.local.get(CACHE_KEY);
      translationCache = data[CACHE_KEY] || {};
    }
  } catch {
    translationCache = {};
  }
}

/**
 * Save cache to chrome.storage.local.
 */
async function saveCache() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      await chrome.storage.local.set({ [CACHE_KEY]: translationCache });
    }
  } catch {
    // Silently fail if storage is unavailable
  }
}

// Load cache on module init
loadCache();

export async function translateWord(text, sourceLang = 'en', targetLang = 'ar', context = '') {
  const cacheKey = `${sourceLang}|${targetLang}|${text.toLowerCase().trim()}|${context.toLowerCase().trim()}`;

  // Check cache first
  if (translationCache[cacheKey]) {
    return translationCache[cacheKey];
  }

  let translation = null;
  let match = 0;

  // 1. Try MyMemory API
  try {
    const query = context ? `${text} (in context: ${context})` : text;
    const params = new URLSearchParams({
      q: query,
      langpair: `${sourceLang}|${targetLang}`,
    });

    const response = await fetch(`${API_BASE}?${params.toString()}`);
    if (response.ok) {
      const data = await response.json();
      if (data.responseStatus === 200) {
        let rawTrans = data.responseData.translatedText;
        if (context && rawTrans.includes('(')) {
          const parsed = rawTrans.split('(')[0].trim();
          if (parsed) rawTrans = parsed;
        }
        // Verify it didn't just echo the English word
        if (rawTrans && rawTrans.toLowerCase().trim() !== text.toLowerCase().trim()) {
          translation = rawTrans;
          match = data.responseData.match || 1;
        }
      }
    }
  } catch (error) {
    console.warn('[Mrky] MyMemory fetch failed, trying Google Translate...', error);
  }

  // 2. Try Google Translate Fallback
  if (!translation) {
    try {
      const params = new URLSearchParams({
        client: 'gtx',
        sl: sourceLang,
        tl: targetLang,
        dt: 't',
        q: text
      });
      const response = await fetch(`https://translate.googleapis.com/translate_a/single?${params.toString()}`);
      if (response.ok) {
        const data = await response.json();
        if (data && data[0] && data[0][0] && data[0][0][0]) {
          translation = data[0][0][0];
          match = 1;
        }
      }
    } catch (error) {
      console.error('[Mrky] Google Translate fallback failed:', error);
    }
  }

  // Final check
  if (translation) {
    const result = { translation, match };
    translationCache[cacheKey] = result;

    // Evict oldest 25% when cache exceeds maximum size
    const keys = Object.keys(translationCache);
    if (keys.length > MAX_CACHE_SIZE) {
      const evictCount = Math.floor(MAX_CACHE_SIZE * 0.25);
      for (let i = 0; i < evictCount; i++) {
        delete translationCache[keys[i]];
      }
    }

    saveCache();
    return result;
  }

  return {
    translation: text, // Fall back to the word itself instead of showing a generic error
    match: 0,
  };
}

/**
 * Translate a word via the background service worker (avoids CORS in content scripts).
 */
export async function translateViaBackground(text, context = '') {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      try {
        chrome.runtime.sendMessage(
          { type: 'TRANSLATE', payload: { text, context } },
          (response) => {
            if (chrome.runtime.lastError) {
              console.warn('[Mrky] Context invalidated, using direct translation...');
              translateWord(text, 'en', 'ar', context).then(resolve);
            } else {
              resolve(response || { translation: text, match: 0 });
            }
          }
        );
      } catch (err) {
        console.warn('[Mrky] Error sending message, using direct translation...', err);
        translateWord(text, 'en', 'ar', context).then(resolve);
      }
    } else {
      // Fallback for development/testing outside extension context
      translateWord(text, 'en', 'ar', context).then(resolve);
    }
  });
}

/**
 * Clear the translation cache.
 */
export async function clearTranslationCache() {
  translationCache = {};
  await saveCache();
}
