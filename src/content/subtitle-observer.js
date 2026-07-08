/**
 * Mrky Video Subtitle Observer
 * Watches for subtitle changes in video players (YouTube, Netflix, Disney+)
 * and replaces them with Mrky's interactive color-coded subtitles.
 */
import { analyzeText } from '../shared/nlp-processor.js';
import { getKnownWordsSet } from '../shared/db.js';
import { renderSubtitles, clearOverlay, initOverlay } from './overlay-renderer.js';
import { mrkyEnabled } from './enabled-state.js';

let observer = null; // Parent observer (watches for container presence)
let subtitleObserver = null; // Target observer (watches for caption text changes)
let lastSubtitleText = '';
let knownWords = new Set();
let currentPlatform = '';
let pendingFrame = null; // RAF debounce handle for batching rapid mutations
let cachedVideoEl = null; // Cached video element reference

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

  // Initialize the overlay inside the video player container for native fullscreen support & zero-lag layout
  initOverlay(player);

  // Cache video element reference to avoid repeated document.querySelector calls
  cachedVideoEl = player.querySelector('video') || document.querySelector('video');

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
 * Uses requestAnimationFrame batching to coalesce rapid mutations into a single
 * processing call per frame (~60fps / 16ms), preventing CPU flooding from
 * YouTube's character-by-character rolling caption updates.
 * @param {HTMLElement} container
 */
function observeSubtitleContainer(container) {
  if (subtitleObserver) {
    subtitleObserver.disconnect();
  }

  console.log('[Mrky] Attaching target observer directly to subtitle container');
  subtitleObserver = new MutationObserver(() => {
    // Batch all mutations within the same animation frame into one processing call
    if (pendingFrame) return; // Already scheduled — skip
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      checkForCaptions();
    });
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

  // Choose platform-specific selectors to avoid duplicate layout overlays or cross-platform text overlaps
  let selectors = [];
  if (currentPlatform === 'youtube') {
    selectors = ['.ytp-caption-segment'];
  } else if (currentPlatform === 'netflix') {
    selectors = ['.player-timedtext-text-container span'];
  } else if (currentPlatform === 'disneyplus') {
    selectors = ['.dss-subtitle-container span', '.dss-subtitle-container p'];
  } else {
    // General fallback
    selectors = [
      '.ytp-caption-segment',
      '.player-timedtext-text-container span',
      '.dss-subtitle-container span'
    ];
  }

  // Find target caption container to restrict DOM querying (huge performance boost)
  let container = subtitleObserver?.targetElement;
  if (!container) {
    let subtitleContainerSelector = '.ytp-caption-window-container';
    if (currentPlatform === 'netflix') subtitleContainerSelector = '.player-timedtext';
    if (currentPlatform === 'disneyplus') subtitleContainerSelector = '.dss-subtitle-container';
    container = document.querySelector(subtitleContainerSelector);
  }

  if (!container) {
    clearOverlay();
    lastSubtitleText = '';
    return;
  }

  // Query only within the active caption container to bypass full document scan
  const allSegments = container.querySelectorAll(selectors.join(', '));

  if (allSegments.length === 0) {
    clearOverlay();
    lastSubtitleText = '';
    return;
  }

  // Filter segments — lightweight checks only (no forced layout reflow):
  // 1. Must have text content
  // 2. Must not be hidden via CSS (display:none or visibility:hidden)
  // IMPORTANT: We avoid offsetWidth/offsetHeight/getClientRects here because they
  // force a synchronous layout reflow which is extremely expensive at 60fps.
  const activeSegments = Array.from(allSegments).filter((seg) => {
    if (!seg.textContent || !seg.textContent.trim()) return false;

    // Lightweight hidden check: walk up the tree to find display:none
    // YouTube hides old caption segments by removing them from DOM (childList mutation),
    // so segments still in the container are virtually always visible.
    // Only check the segment's own style for a definitive hidden state.
    const style = seg.style;
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    return true;
  });

  // Filter out any parent node if its child is also matched (prevents double text duplication)
  const leafSegments = activeSegments.length <= 1 ? activeSegments : activeSegments.filter((seg) => {
    const hasChildMatched = activeSegments.some(other => other !== seg && seg.contains(other));
    return !hasChildMatched;
  });

  if (leafSegments.length === 0) {
    clearOverlay();
    lastSubtitleText = '';
    return;
  }

  // Combine leaf segments texts cleanly using array join (faster than string concatenation)
  const fullText = leafSegments.map(seg => seg.textContent).join(' ').trim().replace(/\s+/g, ' ');

  // Skip if same text as before (avoid redundant processing)
  if (fullText === lastSubtitleText || !fullText) return;
  lastSubtitleText = fullText;

  // Use cached video reference — avoids document.querySelector on every update
  const video = cachedVideoEl || document.querySelector('video');
  if (!video) return;
  if (!cachedVideoEl) cachedVideoEl = video; // Cache for future calls
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

