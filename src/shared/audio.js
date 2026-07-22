/**
 * Mrky Pronunciation Audio Player
 * Plays real human Oxford / Wiktionary pronunciation or Google WaveNet Neural TTS via Service Worker.
 * Falls back to high-accuracy Web Speech API if offline.
 */

// Keep track of loaded speech synthesis voices for fallback
let cachedVoices = [];
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  cachedVoices = window.speechSynthesis.getVoices();
  if (window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = () => {
      cachedVoices = window.speechSynthesis.getVoices();
    };
  }
}

/**
 * Play pronunciation for an English word.
 * @param {string} word - The English word to pronounce
 * @param {Object} [callbacks] - Optional event callbacks
 * @param {Function} [callbacks.onStart] - Called when audio starts playing
 * @param {Function} [callbacks.onEnd] - Called when audio finishes playing
 * @param {Function} [callbacks.onError] - Called if audio fails completely
 */
export async function playPronunciation(word, { onStart, onEnd, onError } = {}) {
  if (!word) return;
  const cleanWord = word.trim();

  // 0. Require login for audio playback
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const loggedInEmail = await new Promise((resolve) => {
      chrome.storage.local.get(['userEmail'], (res) => resolve(res?.userEmail));
    });
    if (!loggedInEmail) {
      console.warn('[PANDA Audio] Audio playback requires logging in.');
      if (onError) onError('Requires login');
      return;
    }
  }

  // Helper to detect context invalidation
  const isContextInvalidated = (errStr = '') =>
    errStr.includes('Extension context invalidated') || errStr.includes('context invalidated');

  // 1. Try playing via Offscreen Document (Immune to webpage CSP, CORS, and autoplay restrictions)
  if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.runtime.sendMessage) {
    let offscreenRes = null;
    try {
      if (onStart) onStart();
      offscreenRes = await new Promise((resolve) => {
        if (!chrome.runtime?.id) {
          resolve({ error: 'Extension context invalidated.' });
          return;
        }
        try {
          chrome.runtime.sendMessage({ type: 'SPEAK_WORD_OFFSCREEN', payload: { word: cleanWord } }, (response) => {
            if (chrome.runtime.lastError) {
              resolve({ error: chrome.runtime.lastError.message });
            } else {
              resolve(response || {});
            }
          });
        } catch (err) {
          resolve({ error: err.message || String(err) });
        }
      });

      if (offscreenRes && offscreenRes.success) {
        if (onEnd) onEnd();
        return;
      }
    } catch (err) {
      offscreenRes = { error: err?.message || String(err) };
    }

    // If context was invalidated, jump directly to Web Speech API fallback immediately
    if (offscreenRes?.error && isContextInvalidated(offscreenRes.error)) {
      console.warn('[Mrky] Extension context invalidated during audio playback. Falling back directly to Web Speech TTS.');
      fallbackTTS(cleanWord, { onStart: null, onEnd, onError });
      return;
    }

    if (offscreenRes?.error) {
      console.warn('[Mrky] Offscreen audio request failed, trying GET_AUDIO:', offscreenRes.error);
    }

    // 2. Secondary fallback: try playing via GET_AUDIO Data URL in DOM
    let getAudioRes = null;
    try {
      getAudioRes = await new Promise((resolve) => {
        if (!chrome.runtime?.id) {
          resolve({ error: 'Extension context invalidated.' });
          return;
        }
        try {
          chrome.runtime.sendMessage({ type: 'GET_AUDIO', payload: { word: cleanWord } }, (response) => {
            if (chrome.runtime.lastError) {
              resolve({ error: chrome.runtime.lastError.message });
            } else {
              resolve(response || {});
            }
          });
        } catch (err) {
          resolve({ error: err.message || String(err) });
        }
      });

      if (getAudioRes && getAudioRes.audioUrl) {
        const audio = new Audio(getAudioRes.audioUrl);
        if (onEnd) audio.onended = onEnd;
        audio.onerror = (err) => {
          console.warn('[Mrky] Audio DOM playback error, falling back to Web Speech:', err);
          fallbackTTS(cleanWord, { onStart: null, onEnd, onError });
        };
        await audio.play();
        return;
      }
    } catch (err) {
      getAudioRes = { error: err?.message || String(err) };
    }

    if (getAudioRes?.error && isContextInvalidated(getAudioRes.error)) {
      console.warn('[Mrky] Extension context invalidated during GET_AUDIO. Falling back directly to Web Speech TTS.');
      fallbackTTS(cleanWord, { onStart: null, onEnd, onError });
      return;
    }
  }

  // 3. Final fallback to optimized Web Speech API
  fallbackTTS(cleanWord, { onStart: null, onEnd, onError });
}

/**
 * Enhanced Web Speech API Fallback with natural voice selection and speed tuning.
 */
function fallbackTTS(word, { onStart, onEnd, onError } = {}) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    if (onError) onError(new Error('Speech synthesis not supported'));
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'en-US';
  utterance.rate = 0.9; // 0.9 sounds much more natural and articulate than 0.85
  utterance.pitch = 1;

  const voices = cachedVoices.length > 0 ? cachedVoices : window.speechSynthesis.getVoices();
  
  // Rank voices by naturalness (neural/online voices first)
  const bestVoice =
    voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Online') || v.name.includes('Neural'))) ||
    voices.find(v => v.lang.startsWith('en') && v.name.includes('Google')) ||
    voices.find(v => v.lang === 'en-US') ||
    voices.find(v => v.lang.startsWith('en'));

  if (bestVoice) {
    utterance.voice = bestVoice;
  }

  if (onStart) utterance.onstart = onStart;
  if (onEnd) utterance.onend = onEnd;
  if (onError) utterance.onerror = onError;

  window.speechSynthesis.speak(utterance);
}
