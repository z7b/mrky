/**
 * Mrky Video Subtitle Observer
 * Watches for subtitle changes in video players (YouTube, Netflix, Disney+)
 * and replaces them with Mrky's interactive color-coded subtitles.
 */
import { analyzeText } from '../shared/nlp-processor.js';
import { getKnownWordsSet } from '../shared/db.js';
import { renderSubtitles, clearOverlay } from './overlay-renderer.js';
import { mrkyEnabled } from './enabled-state.js';

let observer = null; // Parent observer (watches for container presence)
let subtitleObserver = null; // Target observer (watches for caption text changes)
let lastSubtitleText = '';
let knownWords = new Set();
let currentPlatform = '';

/**
 * Start observing subtitles for a specific platform.
 * @param {string} platform - 'youtube', 'netflix', or 'disneyplus'
 */
export async function startVideoObserver(platform) {
  currentPlatform = platform;
  // Pre-load known words for fast lookup
  knownWords = await getKnownWordsSet();

  let playerSelector = '.html5-video-player';
  if (platform === 'netflix') playerSelector = '.nfp.VideoContainer, .watch-video, video';
  if (platform === 'disneyplus') playerSelector = '#app_body_content, video';

  // Wait for the video player to appear
  const player = await waitForElement(playerSelector);
  if (!player) {
    console.warn(`[Mrky] ${platform} player not found`);
    return;
  }

  console.log(`[Mrky] ${platform} player detected. Starting subtitle observer...`);

  // Target selectors for specific subtitle containers
  let subtitleContainerSelector = '.ytp-caption-window-container';
  if (platform === 'netflix') subtitleContainerSelector = '.player-timedtext';
  if (platform === 'disneyplus') subtitleContainerSelector = '.dss-subtitle-container';

  // Connect child observer to subtitle container if it exists
  const initialContainer = player.querySelector(subtitleContainerSelector);
  if (initialContainer) {
    observeSubtitleContainer(initialContainer);
  }

  // Observe the player container ONLY for adding/removing the subtitle container
  // This avoids running NLP parsing or full checks on progress/timer ticks (no characterData observed on player)
  observer = new MutationObserver(() => {
    const container = player.querySelector(subtitleContainerSelector);
    if (container) {
      if (!subtitleObserver || subtitleObserver.targetElement !== container) {
        observeSubtitleContainer(container);
      }
    } else {
      if (subtitleObserver) {
        subtitleObserver.disconnect();
        subtitleObserver = null;
      }
    }
  });

  observer.observe(player, {
    childList: true,
    subtree: true,
  });

  // Also check for existing captions on load
  checkForCaptions();
}

/**
 * Observe the specific subtitle container.
 * @param {HTMLElement} container
 */
function observeSubtitleContainer(container) {
  if (subtitleObserver) {
    subtitleObserver.disconnect();
  }

  console.log('[Mrky] Attaching target observer directly to subtitle container');
  subtitleObserver = new MutationObserver(() => {
    checkForCaptions();
  });

  subtitleObserver.targetElement = container;
  subtitleObserver.observe(container, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

/**
 * Stop observing.
 */
export function stopVideoObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (subtitleObserver) {
    subtitleObserver.disconnect();
    subtitleObserver = null;
  }
  clearOverlay();
}

/**
 * Extract current caption text and process it.
 */
function checkForCaptions() {
  // Skip ALL processing if extension is disabled
  if (!mrkyEnabled) return;

  const captionSegments = document.querySelectorAll(
    '.ytp-caption-segment, .captions-text span, .caption-visual-line, .player-timedtext-text-container span, .dss-subtitle-container span, .dss-subtitle-container p'
  );

  if (captionSegments.length === 0) {
    clearOverlay();
    lastSubtitleText = '';
    return;
  }

  // Combine all caption segment texts
  let fullText = '';
  captionSegments.forEach((seg) => {
    fullText += seg.textContent + ' ';
  });
  fullText = fullText.trim();

  // Skip if same text as before (avoid re-processing)
  if (fullText === lastSubtitleText || !fullText) return;
  lastSubtitleText = fullText;

  // Get video element for positioning
  const video = document.querySelector('video');
  if (!video) return;
  const videoRect = video.getBoundingClientRect();

  // Hide original captions (make them invisible but keep DOM structure for the observer)
  hidePlatformCaptions();

  // Analyze and render Mrky subtitles
  const analyzed = analyzeText(fullText, knownWords);
  renderSubtitles(analyzed, fullText, videoRect);
}

/**
 * Hide the original platform caption elements.
 */
function hidePlatformCaptions() {
  // YouTube
  const ytCaptions = document.querySelectorAll(
    '.ytp-caption-window-container .caption-window, .ytp-caption-window-container'
  );
  ytCaptions.forEach((el) => {
    if (!el.dataset.mrkyHidden) {
      el.style.setProperty('opacity', '0', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
      el.dataset.mrkyHidden = 'true';
    }
  });

  // Netflix
  const nfCaptions = document.querySelectorAll('.player-timedtext-text-container, .player-timedtext');
  nfCaptions.forEach((el) => {
    if (!el.dataset.mrkyHidden) {
      el.style.setProperty('opacity', '0', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
      el.dataset.mrkyHidden = 'true';
    }
  });

  // Disney+
  const disneyCaptions = document.querySelectorAll('.dss-subtitle-container');
  disneyCaptions.forEach((el) => {
    if (!el.dataset.mrkyHidden) {
      el.style.setProperty('opacity', '0', 'important');
      el.style.setProperty('pointer-events', 'none', 'important');
      el.dataset.mrkyHidden = 'true';
    }
  });
}

/**
 * Wait for a DOM element to appear.
 * @param {string} selector
 * @param {number} timeout - Max wait time in ms
 * @returns {Promise<HTMLElement|null>}
 */
function waitForElement(selector, timeout = 15000) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        obs.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });

    obs.observe(document.body, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, timeout);
  });
}

/**
 * Refresh the known words set (called when a new word is marked as known).
 */
export async function refreshKnownWords(word) {
  if (word) {
    knownWords.add(word.toLowerCase());
  } else {
    knownWords = await getKnownWordsSet();
  }
}

