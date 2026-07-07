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
    let audioUrl = audioCache.get(cleanWord);

    if (!audioUrl) {
      // 1. Try Free Dictionary API (Actual Human recorded Oxford / Wiktionary audio)
      try {
        const dictRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cleanWord)}`);
        if (dictRes.ok) {
          const data = await dictRes.json();
          if (Array.isArray(data)) {
            for (const entry of data) {
              if (entry.phonetics && Array.isArray(entry.phonetics)) {
                // Prefer American English (-us.mp3) or UK (-uk.mp3) or Australian (-au.mp3)
                const us = entry.phonetics.find(p => p.audio && p.audio.includes('-us.mp3'));
                const uk = entry.phonetics.find(p => p.audio && p.audio.includes('-uk.mp3'));
                const au = entry.phonetics.find(p => p.audio && p.audio.includes('-au.mp3'));
                const any = entry.phonetics.find(p => p.audio && p.audio.length > 0);
                const chosen = us || uk || au || any;
                if (chosen) {
                  audioUrl = chosen.audio;
                  if (audioUrl.startsWith('//')) audioUrl = 'https:' + audioUrl;
                  break;
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn('[Mrky Offscreen] Free Dictionary API failed for:', cleanWord, err);
      }

      // 2. Try Google Translate Neural TTS (WaveNet / dict-chrome-ex)
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
              break;
            }
          } catch (err) {
            console.warn('[Mrky Offscreen] Google TTS failed:', err);
          }
        }
      }
    }

    if (audioUrl) {
      audioCache.set(cleanWord, audioUrl);
      const audio = new Audio(audioUrl);
      currentAudio = audio;

      audio.onended = () => {
        currentAudio = null;
        sendResponse({ success: true, source: 'network_audio' });
      };

      audio.onerror = (err) => {
        console.warn('[Mrky Offscreen] Audio element error, falling back to Web Speech:', err);
        currentAudio = null;
        speakFallback(cleanWord, sendResponse);
      };

      await audio.play();
      return;
    }
  } catch (error) {
    console.warn('[Mrky Offscreen] Error during audio play:', error);
  }

  // 3. Fallback to natural Web Speech API if network audio unavailable
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
