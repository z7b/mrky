/**
 * Mrky Background Service Worker
 * Handles:
 * 1. Screenshot capture (chrome.tabs.captureVisibleTab)
 * 2. Translation API proxy (avoids CORS in content scripts)
 * 3. OCR processing delegation
 * 4. Smart subscription verification (3-layer: immediate, retry, periodic)
 */
import * as db from '../shared/db.js';
import { checkUserProfileByEmail } from '../shared/supabase.js';
import { getValidFirebaseToken } from '../shared/firebase.js';


// Security: Only these db methods can be invoked via the DB_PROXY message.
// Prevents arbitrary method execution from content scripts or compromised pages.
const ALLOWED_DB_METHODS = [
  'addCard', 'getAllCards', 'getDueCards', 'reviewCard', 'deleteCard',
  'getCardCount', 'markAsKnown', 'isKnown', 'getKnownWordsSet',
  'getKnownWordCount', 'getSetting', 'setSetting',
];

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'TRANSLATE':
      handleTranslation(message.payload, sendResponse);
      return true; // Keep channel open for async response

    case 'CAPTURE_SCREENSHOT':
      handleScreenshot(sender.tab?.id, sendResponse);
      return true;

    case 'RUN_OCR':
      handleOCR(message.payload, sendResponse);
      return true;

    case 'GET_STATS':
      handleGetStats(sendResponse);
      return true;

    case 'DB_PROXY':
      handleDbProxy(message.method, message.args, sendResponse);
      return true;

    case 'GET_AUDIO':
      handleGetAudio(message.payload, sendResponse);
      return true;

    case 'SPEAK_WORD_OFFSCREEN':
      handleSpeakOffscreen(message.payload, sendResponse);
      return true;

    case 'VERIFY_SUBSCRIPTION':
      handleVerifySubscription(message.payload, sendResponse);
      return true;

    case 'SCHEDULE_SUBSCRIPTION_CHECK':
      handleScheduleSubscriptionCheck(message.payload, sendResponse);
      return true;

    case 'CLEAR_SUBSCRIPTION_ALARMS':
      handleClearSubscriptionAlarms(sendResponse);
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

async function handleDbProxy(method, args, sendResponse) {
  try {
    // Security: Reject any method not in the whitelist
    if (!ALLOWED_DB_METHODS.includes(method)) {
      console.warn('[Mrky DB Proxy] Blocked disallowed method:', method);
      sendResponse({ error: `Method not allowed: ${method}` });
      return;
    }
    let result = await db[method](...args);
    // Convert Set to Array for JSON serialization
    if (method === 'getKnownWordsSet' && result instanceof Set) {
      result = Array.from(result);
    }
    sendResponse({ result });
  } catch (error) {
    console.error('[Mrky DB Proxy Error]:', error);
    sendResponse({ error: error.message });
  }
}

// Circuit breaker and caching handled by the unified translate.js engine.
import { translateWord } from '../shared/translate.js';

/**
 * Handle translation requests from content scripts.
 * Delegates to the production-grade translate.js engine
 * which provides LRU cache, request deduplication, circuit breaker,
 * rate limit detection, and offline awareness.
 *
 * @param {{text: string, context?: string, sourceLang?: string, targetLang?: string}} payload
 * @param {Function} sendResponse
 */
async function handleTranslation(payload, sendResponse) {
  const { text, context = '', sourceLang = 'en', targetLang = 'ar' } = payload;
  try {
    const trimmedContext = context.length > 150 ? context.slice(0, 150) : context;
    const result = await translateWord(text, sourceLang, targetLang, trimmedContext);
    sendResponse(result);
  } catch (error) {
    console.error('[PANDA BG] Translation error:', error);
    sendResponse({ translation: text, match: 0 });
  }
}

/**
 * Capture a screenshot of the active tab.
 * @param {number} tabId
 * @param {Function} sendResponse
 */
async function handleScreenshot(tabId, sendResponse) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: 'png',
      quality: 90,
    });
    sendResponse({ screenshot: dataUrl });
  } catch (error) {
    console.error('[Mrky BG] Screenshot error:', error);
    sendResponse({ screenshot: null });
  }
}

/**
 * Handle OCR requests.
 * Routes the image data to the secure offscreen document where Tesseract.js runs.
 */
async function handleOCR(payload, sendResponse) {
  try {
    await setupOffscreenDocument();
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'RUN_OCR',
      payload: { image: payload.image }
    }, (res) => {
      if (chrome.runtime.lastError) {
        console.error('[Mrky BG] OCR forwarding error:', chrome.runtime.lastError.message);
        sendResponse({ text: '', words: [] });
      } else {
        sendResponse(res || { text: '', words: [] });
      }
    });
  } catch (err) {
    console.error('[Mrky BG] handleOCR error:', err);
    sendResponse({ text: '', words: [] });
  }
}

/**
 * Handle stats request from popup.
 * @param {Function} sendResponse
 */
async function handleGetStats(sendResponse) {
  sendResponse({ status: 'ok' });
}

/* ═══════════════════════════════════════════════════════════
   Smart Subscription Verification System (3-Layer Architecture)
   Layer 1: Immediate verification (VERIFY_SUBSCRIPTION message)
   Layer 2: Exponential backoff retry (chrome.alarms)
   Layer 3: Periodic check every 30 minutes
   ═══════════════════════════════════════════════════════════ */

const ALARM_SUBSCRIPTION_RETRY = 'panda-subscription-retry';
const ALARM_SUBSCRIPTION_PERIODIC = 'panda-subscription-periodic';
const RETRY_DELAYS = [0.083, 0.5, 2]; // minutes: ~5s, 30s, 2min

/**
 * Layer 1: Immediate subscription verification.
 * Called by popup/login to get instant status.
 */
async function handleVerifySubscription(payload, sendResponse) {
  const email = payload?.email;
  if (!email) {
    sendResponse({ success: false, error: 'no_email' });
    return;
  }

  try {
    const result = await checkUserProfileByEmail(email);
    if (result && !result.fromCache) {
      // Server responded authoritatively — update storage
      await chrome.storage.local.set({
        isPremium: result.isPro,
        plan: result.plan || 'free',
      });
      console.log(`[PANDA Verify] ✅ Server confirmed: isPro=${result.isPro}, plan=${result.plan}`);
      sendResponse({ success: true, isPro: result.isPro, plan: result.plan });
    } else if (result?.fromCache) {
      // Server unreachable, got cache fallback — schedule retry
      console.warn('[PANDA Verify] ⚠️ Server unreachable, scheduling retry...');
      scheduleRetry(0);
      sendResponse({ success: true, isPro: result.isPro, plan: result.plan, fromCache: true });
    } else {
      sendResponse({ success: false, error: 'no_result' });
    }
  } catch (err) {
    console.error('[PANDA Verify] Verification failed:', err);
    scheduleRetry(0);
    sendResponse({ success: false, error: err.message });
  }
}

/**
 * Layer 2: Schedule a retry with exponential backoff.
 * @param {number} attempt - Current retry attempt index (0, 1, 2)
 */
function scheduleRetry(attempt) {
  if (attempt >= RETRY_DELAYS.length) {
    console.log('[PANDA Verify] Max retries exhausted. Will catch on periodic check.');
    return;
  }
  const delayMinutes = RETRY_DELAYS[attempt];
  const alarmName = `${ALARM_SUBSCRIPTION_RETRY}_${attempt}`;
  chrome.alarms.create(alarmName, { delayInMinutes: delayMinutes });
  console.log(`[PANDA Verify] 🔄 Retry #${attempt + 1} scheduled in ${delayMinutes} min`);
}

/**
 * Set up both immediate verification and periodic checking.
 * Called after login.
 */
async function handleScheduleSubscriptionCheck(payload, sendResponse) {
  const email = payload?.email;
  if (!email) {
    sendResponse?.({ success: false });
    return;
  }

  // Schedule Layer 2: immediate first retry (covers Edge Function cold start)
  scheduleRetry(0);

  // Schedule Layer 3: periodic check every 30 minutes
  chrome.alarms.create(ALARM_SUBSCRIPTION_PERIODIC, {
    delayInMinutes: 30,
    periodInMinutes: 30,
  });
  console.log('[PANDA Verify] 📅 Periodic subscription check scheduled (every 30 min)');

  sendResponse?.({ success: true });
}

/**
 * Clear all subscription alarms (called on logout).
 */
async function handleClearSubscriptionAlarms(sendResponse) {
  // Clear all retry alarms
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    await chrome.alarms.clear(`${ALARM_SUBSCRIPTION_RETRY}_${i}`);
  }
  // Clear periodic alarm
  await chrome.alarms.clear(ALARM_SUBSCRIPTION_PERIODIC);
  console.log('[PANDA Verify] 🧹 All subscription alarms cleared');
  sendResponse?.({ success: true });
}

/**
 * Alarm listener: handles both retry and periodic verification.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Handle retry alarms (panda-subscription-retry_0, _1, _2)
  if (alarm.name.startsWith(ALARM_SUBSCRIPTION_RETRY)) {
    const attempt = parseInt(alarm.name.split('_').pop(), 10);
    console.log(`[PANDA Verify] ⏰ Retry alarm #${attempt + 1} fired`);

    const stored = await chrome.storage.local.get(['userEmail']);
    if (!stored.userEmail) return; // Logged out

    try {
      const result = await checkUserProfileByEmail(stored.userEmail);
      if (result && !result.fromCache) {
        // Server responded authoritatively
        await chrome.storage.local.set({
          isPremium: result.isPro,
          plan: result.plan || 'free',
        });
        console.log(`[PANDA Verify] ✅ Retry succeeded: isPro=${result.isPro}`);
      } else {
        // Still failing — schedule next retry
        scheduleRetry(attempt + 1);
      }
    } catch (err) {
      console.warn(`[PANDA Verify] Retry #${attempt + 1} failed:`, err.message);
      scheduleRetry(attempt + 1);
    }
    return;
  }

  // Handle periodic alarm
  if (alarm.name === ALARM_SUBSCRIPTION_PERIODIC) {
    console.log('[PANDA Verify] ⏰ Periodic subscription check fired');

    const stored = await chrome.storage.local.get(['userEmail']);
    if (!stored.userEmail) {
      // User logged out — clear periodic alarm
      await chrome.alarms.clear(ALARM_SUBSCRIPTION_PERIODIC);
      return;
    }

    try {
      const result = await checkUserProfileByEmail(stored.userEmail);
      if (result && !result.fromCache) {
        await chrome.storage.local.set({
          isPremium: result.isPro,
          plan: result.plan || 'free',
        });
        console.log(`[PANDA Verify] ✅ Periodic check: isPro=${result.isPro}`);
      }
    } catch (err) {
      console.warn('[PANDA Verify] Periodic check failed:', err.message);
    }
  }
});

// Extension install/update event
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Mrky] 🎓 Extension installed! Welcome to Mrky.');
  } else if (details.reason === 'update') {
    console.log('[Mrky] 🔄 Extension updated to version', chrome.runtime.getManifest().version);

    // On update, re-verify subscription for logged-in users
    chrome.storage.local.get(['userEmail'], (stored) => {
      if (stored.userEmail) {
        scheduleRetry(0);
      }
    });
  }
});

// Auto-intercept PDF links and redirect to Mrky PDF Reader
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const url = changeInfo.url;
    // Skip if already inside our pdf-reader or when opening in native viewer/download mode
    if (url.toLowerCase().includes('.pdf') && !url.includes('pdf-reader/index.html') && !url.includes('mrky_native=1') && !url.includes('download=')) {
      const readerUrl = chrome.runtime.getURL(`pdf-reader/index.html?file=${encodeURIComponent(url)}`);
      chrome.tabs.update(tabId, { url: readerUrl });
    }
  }
});

/* ═══════════════════════════════════════════════════════════
   Pronunciation Audio Engine (Human / Neural TTS)
   Bypasses webpage CORS/CSP by fetching in Service Worker
   ═══════════════════════════════════════════════════════════ */
const audioCache = new Map();

async function handleGetAudio(payload = {}, sendResponse) {
  const word = (payload.word || '').trim();
  if (!word) {
    sendResponse({ error: 'No word provided' });
    return;
  }

  // Security & Usability: Allow basic punctuation for phrases/sentences up to 300 chars
  if (!/^[a-z0-9 '.,!?-]+$/i.test(word) || word.length > 300) {
    sendResponse({ error: 'Invalid word or sentence format' });
    return;
  }

  const cacheKey = word.toLowerCase();
  if (audioCache.has(cacheKey)) {
    sendResponse({ audioUrl: audioCache.get(cacheKey) });
    return;
  }

  try {
    let audioBuffer = null;
    let mimeType = 'audio/mp3';

    // ── SOURCE 1: Google Translate Neural TTS (WaveNet — near-human quality) ──
    const ttsUrls = [
      `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en-US&q=${encodeURIComponent(word)}`,
      `https://translate.google.com/translate_tts?ie=UTF-8&client=gtx&tl=en-US&q=${encodeURIComponent(word)}`
    ];
    for (const ttsUrl of ttsUrls) {
      try {
        const ttsRes = await fetch(ttsUrl);
        const ttsContentType = (ttsRes.headers.get('content-type') || '');
        if (ttsRes.ok && (ttsContentType.includes('audio') || ttsContentType.includes('octet-stream'))) {
          audioBuffer = await ttsRes.arrayBuffer();
          console.log(`[Mrky Audio] ✅ Fetched neural TTS for "${word}" from Google Translate`);
          break;
        }
      } catch (err) {
        console.warn('[Mrky Audio] Google TTS endpoint failed for:', word, err);
      }
    }

    // ── SOURCE 2: Free Dictionary API (Real human Wiktionary/Oxford recordings fallback) ──
    if (!audioBuffer) {
      try {
        const dictRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
        if (dictRes.ok) {
          const data = await dictRes.json();
          let audioUrl = '';
          if (Array.isArray(data)) {
            for (const entry of data) {
              if (entry.phonetics && Array.isArray(entry.phonetics)) {
                const us = entry.phonetics.find(p => p.audio && p.audio.includes('-us.mp3'));
                const uk = entry.phonetics.find(p => p.audio && p.audio.includes('-uk.mp3'));
                const any = entry.phonetics.find(p => p.audio && p.audio.length > 0);
                const chosen = us || uk || any;
                if (chosen) {
                  audioUrl = chosen.audio;
                  break;
                }
              }
            }
          }
          if (audioUrl) {
            if (audioUrl.startsWith('//')) audioUrl = 'https:' + audioUrl;
            const audioRes = await fetch(audioUrl);
            const audioContentType = (audioRes.headers.get('content-type') || '');
            if (audioRes.ok && (audioContentType.includes('audio') || audioContentType.includes('octet-stream'))) {
              audioBuffer = await audioRes.arrayBuffer();
              console.log(`[Mrky Audio] ✅ Fetched human audio for "${word}" from Wiktionary`);
            }
          }
        }
      } catch (err) {
        console.warn('[Mrky Audio] Free Dictionary API failed for:', word, err);
      }
    }

    // ── SOURCE 3: Google Dictionary (Real human recordings hosted by Google fallback) ──
    if (!audioBuffer) {
      const safeWord = encodeURIComponent(word);
      const googleDictUrls = [
        `https://ssl.gstatic.com/dictionary/static/sounds/20200429/${safeWord}--_us_1.mp3`,
        `https://ssl.gstatic.com/dictionary/static/sounds/20200429/${safeWord}--_gb_1.mp3`,
        `https://ssl.gstatic.com/dictionary/static/sounds/20200429/${safeWord}--_us_2.mp3`,
      ];
      for (const url of googleDictUrls) {
        try {
          const audioRes = await fetch(url);
          if (audioRes.ok && (audioRes.headers.get('content-type') || '').includes('audio')) {
            audioBuffer = await audioRes.arrayBuffer();
            console.log(`[Mrky Audio] ✅ Fetched human audio for "${word}" from Google Dictionary`);
            break;
          }
        } catch (err) {
          // Silently continue
        }
      }
    }

    if (!audioBuffer) {
      sendResponse({ error: 'Failed to fetch audio from network sources' });
      return;
    }

    // Convert ArrayBuffer to Base64 Data URL safely
    let binary = '';
    const bytes = new Uint8Array(audioBuffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const dataUrl = `data:${mimeType};base64,${base64}`;

    // Cache in memory (max 500 items)
    if (audioCache.size > 500) {
      const firstKey = audioCache.keys().next().value;
      audioCache.delete(firstKey);
    }
    audioCache.set(word, dataUrl);

    sendResponse({ audioUrl: dataUrl });
  } catch (error) {
    console.error('[Mrky Audio] handleGetAudio error:', error);
    sendResponse({ error: error.message });
  }
}

/* ═══════════════════════════════════════════════════════════
   Offscreen Document Management for CSP-Immune Audio Playback
   ═══════════════════════════════════════════════════════════ */
let creatingOffscreen = null;

async function setupOffscreenDocument() {
  if (typeof chrome === 'undefined' || !chrome.offscreen) return;
  const offscreenUrl = chrome.runtime.getURL('offscreen/index.html');
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (existingContexts && existingContexts.length > 0) return;
  } catch (e) {
    // getContexts might not be available in older MV3 implementations
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
  } else {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen/index.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play pronunciation audio for English vocabulary words without webpage CSP interference'
    }).catch(err => {
      if (!err.message.includes('Only a single offscreen')) {
        console.warn('[Mrky BG] createDocument error:', err);
      }
    }).finally(() => {
      creatingOffscreen = null;
    });
    await creatingOffscreen;
  }
}

async function handleSpeakOffscreen(payload = {}, sendResponse) {
  try {
    await setupOffscreenDocument();
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'PLAY_AUDIO',
      payload: { word: payload.word }
    }, (res) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse(res || { success: true });
      }
    });
  } catch (err) {
    console.error('[Mrky BG] handleSpeakOffscreen error:', err);
    sendResponse({ error: err.message });
  }
}
