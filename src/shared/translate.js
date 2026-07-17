/**
 * PANDA Translation Engine — Production-Grade v2.0
 * ═══════════════════════════════════════════════════
 * محرك ترجمة احترافي مصمم لآلاف المستخدمين المتزامنين.
 *
 * الميزات الهندسية:
 * ────────────────
 * 1. LRU Cache        — ذاكرة مخبئية ذكية تحتفظ بالكلمات الأكثر استخداماً (أسرع من Object)
 * 2. Request Coalescing — منع تكرار الطلب لنفس الكلمة أثناء انتظار الرد (Promise dedup)
 * 3. Provider Health   — تتبع صحة كل مزود ترجمة وتجاوز المعطل تلقائياً (Circuit Breaker)
 * 4. Rate Limit Guard  — اكتشاف 429/403 وتفعيل cooldown تلقائي لحماية المستخدم
 * 5. Offline Awareness — فحص الاتصال بالإنترنت قبل إرسال الطلب
 * 6. Batched Persist   — حفظ الكاش للتخزين الدائم كل 5 ثوان بدلاً من كل ترجمة (أداء أعلى)
 * 7. Cross-Browser     — يعمل على Chrome, Edge, Brave, Opera, Firefox (لا يستخدم APIs خاصة)
 *
 * المزودون (بالأولوية):
 *   1. Google Translate (gtx) — الأسرع والأدق
 *   2. MyMemory API — بديل مجاني موثوق
 */

// ══════════════════════════════════════════════════
// Configuration
// ══════════════════════════════════════════════════

const CACHE_KEY = 'mrky_translation_cache';
const MAX_CACHE_SIZE = 2000;
const CACHE_PERSIST_INTERVAL_MS = 5000; // Persist cache every 5 seconds
const PROVIDER_COOLDOWN_MS = 60_000;    // 1 minute cooldown after rate limit
const PROVIDER_MAX_FAILURES = 3;        // Failures before circuit-breaking a provider
const REQUEST_TIMEOUT_MS = 8000;        // 8-second timeout per provider request

// ══════════════════════════════════════════════════
// LRU Cache — Map preserves insertion order, so
// accessing a key moves it to "most recently used"
// by deleting and re-inserting.
// ══════════════════════════════════════════════════

const lruCache = new Map();

/**
 * Get a value from the LRU cache.
 * Accessing a key promotes it to most-recently-used.
 * @param {string} key
 * @returns {Object|undefined}
 */
function cacheGet(key) {
  if (!lruCache.has(key)) return undefined;
  const value = lruCache.get(key);
  // Promote to most-recently-used by re-inserting
  lruCache.delete(key);
  lruCache.set(key, value);
  return value;
}

/**
 * Set a value in the LRU cache.
 * Evicts the least-recently-used entries when over capacity.
 * @param {string} key
 * @param {Object} value
 */
function cacheSet(key, value) {
  // If key already exists, delete first to refresh insertion order
  if (lruCache.has(key)) lruCache.delete(key);
  lruCache.set(key, value);

  // Evict LRU entries if over capacity
  if (lruCache.size > MAX_CACHE_SIZE) {
    const evictCount = Math.floor(MAX_CACHE_SIZE * 0.1); // Evict oldest 10%
    let removed = 0;
    for (const k of lruCache.keys()) {
      if (removed >= evictCount) break;
      lruCache.delete(k);
      removed++;
    }
  }

  // Schedule a debounced persist
  schedulePersist();
}

// ══════════════════════════════════════════════════
// Debounced Cache Persistence
// Instead of writing to chrome.storage on every
// single translation, batch writes every 5 seconds.
// ══════════════════════════════════════════════════

let persistTimer = null;
let cacheLoaded = false;

function schedulePersist() {
  if (persistTimer) return; // Already scheduled
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistCache();
  }, CACHE_PERSIST_INTERVAL_MS);
}

async function persistCache() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const obj = Object.fromEntries(lruCache);
      await chrome.storage.local.set({ [CACHE_KEY]: obj });
    }
  } catch {
    // Storage unavailable — no-op
  }
}

async function loadCache() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const data = await chrome.storage.local.get(CACHE_KEY);
      const saved = data[CACHE_KEY];
      if (saved && typeof saved === 'object') {
        // Restore into LRU Map (oldest first, newest last)
        for (const [k, v] of Object.entries(saved)) {
          lruCache.set(k, v);
        }
      }
    }
  } catch {
    // Ignore load errors
  }
  cacheLoaded = true;
}

// Initialize cache on module load
loadCache();

// ══════════════════════════════════════════════════
// In-Flight Request Deduplication (Promise Coalescing)
// If the same word is requested while a previous
// request is still pending, share the same Promise.
// ══════════════════════════════════════════════════

/** @type {Map<string, Promise<Object>>} */
const inflightRequests = new Map();

// ══════════════════════════════════════════════════
// Provider Health Tracking (Circuit Breaker Pattern)
// Tracks failures and rate limits per provider.
// Auto-recovers after cooldown period.
// ══════════════════════════════════════════════════

const providerHealth = {
  google:   { failures: 0, cooldownUntil: 0 },
  mymemory: { failures: 0, cooldownUntil: 0 },
};

/**
 * Check if a provider is currently healthy (not rate-limited or circuit-broken).
 * @param {'google'|'mymemory'} name
 * @returns {boolean}
 */
function isProviderHealthy(name) {
  const health = providerHealth[name];
  if (!health) return false;

  // Cooldown expired — reset and allow
  if (health.cooldownUntil > 0 && Date.now() >= health.cooldownUntil) {
    health.failures = 0;
    health.cooldownUntil = 0;
    return true;
  }

  // Still in cooldown
  if (health.cooldownUntil > 0) return false;

  // Too many consecutive failures — enter cooldown
  if (health.failures >= PROVIDER_MAX_FAILURES) {
    health.cooldownUntil = Date.now() + PROVIDER_COOLDOWN_MS;
    console.warn(`[PANDA Translate] ⚠️ Provider "${name}" circuit-broken for ${PROVIDER_COOLDOWN_MS / 1000}s`);
    return false;
  }

  return true;
}

/**
 * Record a provider success — resets failure counter.
 * @param {'google'|'mymemory'} name
 */
function recordSuccess(name) {
  const health = providerHealth[name];
  if (health) {
    health.failures = 0;
    health.cooldownUntil = 0;
  }
}

/**
 * Record a provider failure — increments failure counter.
 * @param {'google'|'mymemory'} name
 * @param {number} [httpStatus] - HTTP status code (429/403 triggers immediate cooldown)
 */
function recordFailure(name, httpStatus) {
  const health = providerHealth[name];
  if (!health) return;

  health.failures++;

  // Immediate cooldown on rate limit (429) or forbidden (403)
  if (httpStatus === 429 || httpStatus === 403) {
    health.cooldownUntil = Date.now() + PROVIDER_COOLDOWN_MS;
    console.warn(`[PANDA Translate] 🚫 Provider "${name}" rate-limited (HTTP ${httpStatus}), cooldown activated`);
  }
}

// ══════════════════════════════════════════════════
// Fetch with Timeout (cross-browser)
// AbortController is supported in all modern browsers.
// ══════════════════════════════════════════════════

/**
 * Fetch with a timeout. Aborts the request if it takes too long.
 * @param {string} url
 * @param {number} [timeoutMs=REQUEST_TIMEOUT_MS]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════════
// Translation Providers
// ══════════════════════════════════════════════════

/**
 * Provider 1: Google Translate (unofficial gtx endpoint).
 * @param {string} text
 * @param {string} sourceLang
 * @param {string} targetLang
 * @returns {Promise<{translation: string, match: number}|null>}
 */
async function tryGoogleTranslate(text, sourceLang, targetLang) {
  if (!isProviderHealthy('google')) return null;

  try {
    const params = new URLSearchParams({
      client: 'gtx',
      sl: sourceLang,
      tl: targetLang,
      dt: 't',
      q: text,
    });
    const response = await fetchWithTimeout(
      `https://translate.googleapis.com/translate_a/single?${params}`
    );

    if (!response.ok) {
      recordFailure('google', response.status);
      return null;
    }

    const data = await response.json();
    if (data && data[0]) {
      let fullTranslation = '';
      for (const segment of data[0]) {
        if (segment?.[0]) fullTranslation += segment[0];
      }
      if (fullTranslation && fullTranslation.toLowerCase().trim() !== text.toLowerCase().trim()) {
        recordSuccess('google');
        return { translation: fullTranslation, match: 1 };
      }
    }

    // Response was OK but translation was empty/same — not a failure
    return null;
  } catch (err) {
    // AbortError = timeout, TypeError = network failure
    recordFailure('google');
    return null;
  }
}

/**
 * Provider 2: MyMemory Translation API.
 * @param {string} text
 * @param {string} sourceLang
 * @param {string} targetLang
 * @param {string} context
 * @returns {Promise<{translation: string, match: number}|null>}
 */
async function tryMyMemory(text, sourceLang, targetLang, context) {
  if (!isProviderHealthy('mymemory')) return null;

  try {
    const query = context ? `${text} (in context: ${context})` : text;
    const params = new URLSearchParams({
      q: query,
      langpair: `${sourceLang}|${targetLang}`,
    });
    const response = await fetchWithTimeout(
      `https://api.mymemory.translated.net/get?${params}`
    );

    if (!response.ok) {
      recordFailure('mymemory', response.status);
      return null;
    }

    const data = await response.json();
    if (data.responseStatus === 200) {
      let rawTrans = data.responseData.translatedText;
      // Clean up context artifacts from response
      if (context && rawTrans.includes('(')) {
        const parsed = rawTrans.split('(')[0].trim();
        if (parsed) rawTrans = parsed;
      }
      if (rawTrans && rawTrans.toLowerCase().trim() !== text.toLowerCase().trim()) {
        recordSuccess('mymemory');
        return { translation: rawTrans, match: data.responseData.match || 1 };
      }
    }

    return null;
  } catch (err) {
    recordFailure('mymemory');
    return null;
  }
}

// ══════════════════════════════════════════════════
// Main Translation Function
// ══════════════════════════════════════════════════

/**
 * Translate a word/phrase using the multi-provider fallback chain.
 * Features: LRU cache, request deduplication, circuit breaker, offline check.
 *
 * @param {string} text - Text to translate
 * @param {string} [sourceLang='en'] - Source language
 * @param {string} [targetLang='ar'] - Target language
 * @param {string} [context=''] - Sentence context for better translation
 * @returns {Promise<{translation: string, match: number}>}
 */
export async function translateWord(text, sourceLang = 'en', targetLang = 'ar', context = '') {
  const cleanText = text.trim();
  if (!cleanText) return { translation: text, match: 0 };

  const cacheKey = `${sourceLang}|${targetLang}|${cleanText.toLowerCase()}|${context.toLowerCase().trim()}`;

  // ── Layer 1: LRU Cache (instant, 0ms) ──
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // ── Layer 2: In-flight deduplication ──
  // If an identical request is already pending, reuse its Promise
  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  // ── Layer 3: Network request with provider chain ──
  const requestPromise = executeTranslation(cleanText, sourceLang, targetLang, context, cacheKey);

  // Register the in-flight request
  inflightRequests.set(cacheKey, requestPromise);

  try {
    return await requestPromise;
  } finally {
    // Always clean up, even on error
    inflightRequests.delete(cacheKey);
  }
}

/**
 * Internal: Execute the actual translation request through the provider chain.
 * Separated from translateWord() to keep the deduplication logic clean.
 */
async function executeTranslation(text, sourceLang, targetLang, context, cacheKey) {
  // ── Offline check (cross-browser: navigator.onLine is universally supported) ──
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    console.log('[PANDA Translate] 📡 Offline — returning text as-is');
    return { translation: text, match: 0 };
  }

  // ── Provider chain: try each provider in priority order ──
  let result = null;

  // Provider 1: Google Translate (fastest, most accurate)
  result = await tryGoogleTranslate(text, sourceLang, targetLang);
  if (result) {
    cacheSet(cacheKey, result);
    return result;
  }

  // Provider 2: MyMemory (supports context)
  result = await tryMyMemory(text, sourceLang, targetLang, context);
  if (result) {
    cacheSet(cacheKey, result);
    return result;
  }

  // ── All providers failed — return the word itself as graceful fallback ──
  return { translation: text, match: 0 };
}

// ══════════════════════════════════════════════════
// Background Proxy (Content Script → Service Worker)
// ══════════════════════════════════════════════════

/**
 * Translate a word via the background service worker.
 * Content scripts cannot make cross-origin requests directly (CORS),
 * so we relay through the service worker which has full network access.
 *
 * @param {string} text - Word or phrase to translate
 * @param {string} [context=''] - Sentence context
 * @returns {Promise<{translation: string, match: number}>}
 */
export async function translateViaBackground(text, context = '') {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      try {
        chrome.runtime.sendMessage(
          { type: 'TRANSLATE', payload: { text, context } },
          (response) => {
            if (chrome.runtime.lastError) {
              const errMsg = chrome.runtime.lastError.message || '';
              if (errMsg.includes('context invalidated') || errMsg.includes('invoking')) {
                console.warn('[PANDA Translate] Extension context invalidated. Please refresh the page.');
                resolve({ translation: text, match: 0, error: 'context_invalidated' });
              } else {
                console.warn('[PANDA Translate] Message failed, using direct translation:', errMsg);
                translateWord(text, 'en', 'ar', context).then(resolve);
              }
            } else {
              resolve(response || { translation: text, match: 0 });
            }
          }
        );
      } catch (err) {
        const errMsg = err?.message || String(err);
        if (errMsg.includes('context invalidated') || errMsg.includes('invoking')) {
          console.warn('[PANDA Translate] Extension context invalidated. Please refresh the page.');
          resolve({ translation: text, match: 0, error: 'context_invalidated' });
        } else {
          console.warn('[PANDA Translate] Error sending message, using direct translation:', err);
          translateWord(text, 'en', 'ar', context).then(resolve);
        }
      }
    } else {
      // Fallback for development/testing outside extension context
      translateWord(text, 'en', 'ar', context).then(resolve);
    }
  });
}

// ══════════════════════════════════════════════════
// Cache Management
// ══════════════════════════════════════════════════

/**
 * Clear the translation cache (both in-memory and persisted).
 */
export async function clearTranslationCache() {
  lruCache.clear();
  inflightRequests.clear();
  await persistCache();
}

/**
 * Get diagnostic info about the translation engine.
 * Useful for debugging and monitoring.
 * @returns {Object}
 */
export function getTranslationDiagnostics() {
  return {
    cacheSize: lruCache.size,
    maxCacheSize: MAX_CACHE_SIZE,
    inflightCount: inflightRequests.size,
    providers: {
      google: {
        healthy: isProviderHealthy('google'),
        failures: providerHealth.google.failures,
        cooldownRemaining: Math.max(0, providerHealth.google.cooldownUntil - Date.now()),
      },
      mymemory: {
        healthy: isProviderHealthy('mymemory'),
        failures: providerHealth.mymemory.failures,
        cooldownRemaining: Math.max(0, providerHealth.mymemory.cooldownUntil - Date.now()),
      },
    },
    online: typeof navigator !== 'undefined' ? navigator.onLine : 'unknown',
  };
}
