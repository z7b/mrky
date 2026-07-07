/**
 * Mrky Offscreen Audio Player
 * Runs in a secure extension DOM document (chrome-extension://...)
 * Immune to webpage Content Security Policy (CSP), CORS, and Autoplay restrictions.
 * Plays human Oxford / Wiktionary recordings or Google WaveNet Neural TTS.
 */

import Tesseract from 'tesseract.js';

const audioCache = new Map();
let currentAudio = null;

// Tesseract worker
let tesseractWorker = null;
let workerReady = false;

async function getOCRWorker() {
  if (tesseractWorker && workerReady) return tesseractWorker;

  const basePath = chrome.runtime.getURL('tesseract');
  tesseractWorker = await Tesseract.createWorker('eng', 1, {
    workerPath: `${basePath}/worker.min.js`,
    corePath: `${basePath}/tesseract-core.wasm.js`,
    langPath: basePath, // Will look for eng.traineddata.gz here
    workerBlobURL: false, // CRITICAL FOR MV3 CSP
    logger: m => console.log('[Mrky OCR Offscreen]', m),
  });
  workerReady = true;
  return tesseractWorker;
}

// Listen for messages directed to offscreen document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.type === 'PLAY_AUDIO') {
    playWordAudio(message.payload?.word, sendResponse);
    return true; // Keep message channel open for async response
  }

  if (message.type === 'RUN_OCR') {
    handleOCR(message.payload?.image, sendResponse);
    return true; // Async response
  }

  return false;
});

/**
 * Handle OCR Request.
 */
async function handleOCR(imageSource, sendResponse) {
  try {
    const worker = await getOCRWorker();
    const result = await worker.recognize(imageSource);
    const text = result.data.text?.trim() || '';
    const words = result.data.words || [];
    sendResponse({ text, words });
  } catch (error) {
    console.error('[Mrky OCR Offscreen] OCR Error:', error);
    sendResponse({ text: '', words: [] });
  }
}

/**
 * Fetch and play high-fidelity pronunciation for a word.
 * Priority: Human recordings first, then neural TTS, then browser Speech API.
 *
 * Source priority:
 *   1. Free Dictionary API  → Real human Wiktionary/Oxford recordings
 *   2. Google Dictionary     → Real human recordings (ssl.gstatic.com)
 *   3. Google Translate TTS  → Neural WaveNet synthesis (near-human)
 *   4. Web Speech API        → Browser local voice (last resort)
 *
 * @param {string} word - English vocabulary word
 * @param {Function} sendResponse - Callback when speech ends or fails
 */
async function playWordAudio(word, sendResponse) {
  const cleanWord = (word || '').trim().toLowerCase();
  if (!cleanWord) {
    sendResponse({ error: 'No word provided' });
    return;
  }

  // Stop any currently playing audio
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch (e) {}
    currentAudio = null;
  }
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }

  try {
    let audioUrl = null;
    let audioSource = 'unknown';

    // Check cache first
    const cached = audioCache.get(cleanWord);
    if (cached) {
      audioUrl = cached.url;
      audioSource = cached.source;
    }

    if (!audioUrl) {
      // ── SOURCE 1: Free Dictionary API (Real human Wiktionary/Oxford recordings) ──
      try {
        const dictRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cleanWord)}`);
        if (dictRes.ok) {
          const data = await dictRes.json();
          if (Array.isArray(data)) {
            for (const entry of data) {
              if (entry.phonetics && Array.isArray(entry.phonetics)) {
                // Prefer American English (-us.mp3), then UK (-uk.mp3), then Australian (-au.mp3)
                const us = entry.phonetics.find(p => p.audio && p.audio.includes('-us.mp3'));
                const uk = entry.phonetics.find(p => p.audio && p.audio.includes('-uk.mp3'));
                const au = entry.phonetics.find(p => p.audio && p.audio.includes('-au.mp3'));
                const any = entry.phonetics.find(p => p.audio && p.audio.length > 0);
                const chosen = us || uk || au || any;
                if (chosen) {
                  audioUrl = chosen.audio;
                  if (audioUrl.startsWith('//')) audioUrl = 'https:' + audioUrl;
                  audioSource = 'human_wiktionary';
                  break;
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn('[Mrky Audio] Free Dictionary API failed for:', cleanWord, err);
      }

      // ── SOURCE 2: Google Dictionary (Real human recordings hosted by Google) ──
      if (!audioUrl) {
        const googleDictUrls = [
          `https://ssl.gstatic.com/dictionary/static/sounds/20200429/${cleanWord}--_us_1.mp3`,
          `https://ssl.gstatic.com/dictionary/static/sounds/20200429/${cleanWord}--_gb_1.mp3`,
          `https://ssl.gstatic.com/dictionary/static/sounds/20200429/${cleanWord}--_us_2.mp3`,
        ];
        for (const url of googleDictUrls) {
          try {
            const res = await fetch(url, { method: 'HEAD' });
            if (res.ok) {
              audioUrl = url;
              audioSource = 'human_google_dict';
              break;
            }
          } catch (err) {
            // Silently continue to next URL
          }
        }
      }

      // ── SOURCE 3: Google Translate Neural TTS (WaveNet — near-human quality) ──
      if (!audioUrl) {
        const ttsUrls = [
          `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en-US&q=${encodeURIComponent(cleanWord)}`,
          `https://translate.google.com/translate_tts?ie=UTF-8&client=dict-chrome-ex&tl=en-US&q=${encodeURIComponent(cleanWord)}`
        ];
        for (const url of ttsUrls) {
          try {
            const res = await fetch(url);
            if (res.ok) {
              audioUrl = url;
              audioSource = 'neural_google_tts';
              break;
            }
          } catch (err) {
            console.warn('[Mrky Audio] Google TTS failed:', err);
          }
        }
      }
    }

    if (audioUrl) {
      // Cache with source info (max 500 items)
      if (audioCache.size > 500) {
        const firstKey = audioCache.keys().next().value;
        audioCache.delete(firstKey);
      }
      audioCache.set(cleanWord, { url: audioUrl, source: audioSource });

      const audio = new Audio(audioUrl);
      currentAudio = audio;

      audio.onended = () => {
        currentAudio = null;
        console.log(`[Mrky Audio] ✅ Played "${cleanWord}" from: ${audioSource}`);
        sendResponse({ success: true, source: audioSource });
      };

      audio.onerror = (err) => {
        console.warn(`[Mrky Audio] Audio element error for "${cleanWord}" (${audioSource}), falling back to Web Speech:`, err);
        currentAudio = null;
        // Clear bad cache entry
        audioCache.delete(cleanWord);
        speakFallback(cleanWord, sendResponse);
      };

      await audio.play();
      return;
    }
  } catch (error) {
    console.warn('[Mrky Audio] Error during audio fetch/play:', error);
  }

  // ── SOURCE 4: Web Speech API (browser local voice — last resort) ──
  console.warn(`[Mrky Audio] No network audio found for "${cleanWord}", using Web Speech API fallback`);
  speakFallback(cleanWord, sendResponse);
}

/**
 * Fallback Web Speech API with neural/online voice ranking and natural speech rate.
 */
function speakFallback(word, sendResponse) {
  if (!('speechSynthesis' in window)) {
    sendResponse({ error: 'Speech synthesis not supported' });
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'en-US';
  utterance.rate = 0.9;
  utterance.pitch = 1;

  const voices = window.speechSynthesis.getVoices();
  const bestVoice =
    voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Online') || v.name.includes('Neural'))) ||
    voices.find(v => v.lang.startsWith('en') && v.name.includes('Google')) ||
    voices.find(v => v.lang === 'en-US') ||
    voices.find(v => v.lang.startsWith('en'));

  if (bestVoice) utterance.voice = bestVoice;

  utterance.onend = () => sendResponse({ success: true, source: 'speech_synthesis' });
  utterance.onerror = () => sendResponse({ error: 'Speech synthesis failed' });

  window.speechSynthesis.speak(utterance);
}
