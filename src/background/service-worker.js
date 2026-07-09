/**
 * Mrky Background Service Worker
 * Handles:
 * 1. Screenshot capture (chrome.tabs.captureVisibleTab)
 * 2. Translation API proxy (avoids CORS in content scripts)
 * 3. OCR processing delegation
 */
import * as db from '../shared/db.js';

const TRANSLATION_API = 'https://api.mymemory.translated.net/get';

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

// Circuit breaker to avoid spamming MyMemory when rate-limited (HTTP 429)
let myMemoryCooldownUntil = 0;

/**
 * Handle translation requests from content scripts.
 * @param {{text: string, sourceLang?: string, targetLang?: string}} payload
 * @param {Function} sendResponse
 */
async function handleTranslation(payload, sendResponse) {
  const { text, context: rawContext = '', sourceLang = 'en', targetLang = 'ar' } = payload;

  try {
    const context = rawContext.length > 150 ? rawContext.slice(0, 150) : rawContext;
    let translation = null;

    // 1. Prioritize Google Translate (Fastest, most accurate, no 429 rate limits)
    const googleResult = await callGoogleTranslateAPI(text, sourceLang, targetLang);
    if (googleResult && googleResult.toLowerCase().trim() !== text.toLowerCase().trim()) {
      translation = googleResult;
    }

    // 2. Try MyMemory fallback only if Google Translate failed or returned untranslated text
    if (!translation && Date.now() >= myMemoryCooldownUntil) {
      const result = await callTranslationAPI(text, context, sourceLang, targetLang);
      if (result.status === 429 || result.status === 403) {
        // Cooldown MyMemory for 5 minutes when rate-limited
        myMemoryCooldownUntil = Date.now() + 5 * 60 * 1000;
      } else if (result.translation && result.translation.toLowerCase().trim() !== text.toLowerCase().trim()) {
        translation = result.translation;
      }
    }

    // Final check - if everything failed, return the word itself as a last resort
    if (!translation) {
      translation = text;
    }

    sendResponse({ translation, match: 1 });
  } catch (error) {
    console.error('[Mrky BG] Translation error:', error);
    sendResponse({ translation: text, match: 0 });
  }
}

/**
 * Call the free Google Translate API.
 */
async function callGoogleTranslateAPI(text, sourceLang, targetLang) {
  try {
    const params = new URLSearchParams({
      client: 'gtx',
      sl: sourceLang,
      tl: targetLang,
      dt: 't',
      q: text
    });
    const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    
    const data = await response.json();
    if (data && data[0]) {
      let translation = '';
      for (const segment of data[0]) {
        if (segment && segment[0]) {
          translation += segment[0];
        }
      }
      return translation || null;
    }
    return null;
  } catch (err) {
    return null;
  }
}


/**
 * Call MyMemory translation API.
 * @returns {Promise<{translation: string|null, error: boolean, status: number}>}
 */
async function callTranslationAPI(text, context, sourceLang, targetLang) {
  if (Date.now() < myMemoryCooldownUntil) {
    return { translation: null, error: true, status: 429 };
  }

  const query = context ? `${text} (in context: ${context})` : text;
  const params = new URLSearchParams({
    q: query,
    langpair: `${sourceLang}|${targetLang}`,
  });

  try {
    const response = await fetch(`${TRANSLATION_API}?${params.toString()}`);

    if (!response.ok) {
      if (response.status === 429 || response.status === 403) {
        myMemoryCooldownUntil = Date.now() + 5 * 60 * 1000;
      }
      return { translation: null, error: true, status: response.status };
    }

    const data = await response.json();

    if (data.responseStatus !== 200) {
      if (data.responseStatus === 429 || data.responseStatus === 403) {
        myMemoryCooldownUntil = Date.now() + 5 * 60 * 1000;
      }
      return { translation: null, error: true, status: data.responseStatus };
    }

    let translation = data.responseData.translatedText;

    // Extract translated word before the parenthesis (strip context echo)
    if (context && translation.includes('(')) {
      const parsed = translation.split('(')[0].trim();
      if (parsed) {
        translation = parsed;
      }
    }

    return { translation, error: false, status: 200 };
  } catch (err) {
    return { translation: null, error: true, status: 0 };
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

// Extension install/update event
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Mrky] 🎓 Extension installed! Welcome to Mrky.');
  } else if (details.reason === 'update') {
    console.log('[Mrky] 🔄 Extension updated to version', chrome.runtime.getManifest().version);
  }
});

// Auto-intercept PDF links and redirect to Mrky PDF Reader
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const url = changeInfo.url;
    // Skip if it's already inside our pdf-reader or some other internal pages
    if (url.toLowerCase().endsWith('.pdf') && !url.includes('pdf-reader/index.html')) {
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
