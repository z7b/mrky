/**
 * Mrky Content Script — Entry Point
 * Initializes all Mrky features when injected into web pages.
 * Controls global ON/OFF state via chrome.storage.local['mrkyEnabled'].
 */
import { initTooltip, hideTooltip } from './tooltip.js';
import { initOverlay, clearOverlay, destroyOverlay } from './overlay-renderer.js';
import { startVideoObserver, stopVideoObserver, refreshKnownWords } from './subtitle-observer.js';
import { startPageTextObserver } from './page-text-observer.js';
import { initOCR } from './ocr-handler.js';
import { mrkyEnabled, setMrkyEnabled } from './enabled-state.js';

(function mrkyInit() {
  // Prevent double-initialization
  if (window.__mrkyInitialized) return;
  window.__mrkyInitialized = true;

  console.log('[Mrky] 🎓 Initializing Mrky — Learn English Through Content You Love');

  const hostname = window.location.hostname;

  // Initialize shared components (they always exist, but check mrkyEnabled before acting)
  initTooltip();
  initOverlay();
  initOCR();

  /**
   * Start the appropriate observer based on the current site.
   */
  function startObservers() {
    if (hostname.includes('youtube.com')) {
      console.log('[Mrky] 📺 YouTube detected');
      startVideoObserver('youtube');

      // Re-initialize observer on YouTube SPA navigation
      // Use <title> observation instead of document.body to avoid CPU waste
      // YouTube updates the title on every navigation
      if (!window.__mrkyYTObserver) {
        let lastUrl = location.href;
        window.__mrkyYTObserver = new MutationObserver(() => {
          if (location.href !== lastUrl) {
            lastUrl = location.href;
            console.log('[Mrky] YouTube navigation detected, re-initializing...');
            if (mrkyEnabled) {
              setTimeout(() => startVideoObserver('youtube'), 1500);
            }
          }
        });
        // Observe <title> element — lightweight SPA navigation detection
        const titleEl = document.querySelector('title');
        const observeTarget = titleEl || document.body;
        window.__mrkyYTObserver.observe(observeTarget, {
          childList: true,
          subtree: !titleEl, // Only use subtree if falling back to body
        });
      }

    } else if (hostname.includes('netflix.com')) {
      console.log('[Mrky] 🎬 Netflix detected');
      startVideoObserver('netflix');

    } else if (hostname.includes('disneyplus.com')) {
      console.log('[Mrky] 🏰 Disney+ detected');
      startVideoObserver('disneyplus');

    } else {
      console.log('[Mrky] 🌐 General Web Page detected');
      startPageTextObserver();
    }
  }

  /**
   * Fully disable Mrky — hide all UI, stop all observers, block all interactions.
   */
  function disableMrky() {
    setMrkyEnabled(false);
    document.documentElement.classList.add('mrky-disabled-mode');

    // Force-hide tooltip immediately
    hideTooltip(true);

    // Clear subtitle overlay
    clearOverlay();

    // Stop video subtitle observers
    stopVideoObserver();

    // Restore original platform captions that Mrky had hidden
    document.querySelectorAll('[data-mrky-hidden]').forEach(el => {
      el.style.removeProperty('opacity');
      el.style.removeProperty('pointer-events');
      delete el.dataset.mrkyHidden;
    });

    console.log('[Mrky] ⏸️ Mrky is now FULLY DISABLED.');
  }

  /**
   * Re-enable Mrky — restart observers and restore all interactions.
   */
  function enableMrky() {
    setMrkyEnabled(true);
    document.documentElement.classList.remove('mrky-disabled-mode');

    // Re-start observers to resume processing
    startObservers();

    console.log('[Mrky] ▶️ Mrky is now FULLY ENABLED.');
  }

  // Listen for "word known" events to refresh the known words cache
  document.addEventListener('mrky-word-known', (e) => {
    refreshKnownWords(e.detail?.word);
  });

  // ─── Load initial state and listen for real-time changes ───
  chrome.storage.local.get(['mrkyEnabled'], (res) => {
    const isEnabled = res.mrkyEnabled !== false;
    if (isEnabled) {
      enableMrky();
    } else {
      // Still need to set the flag before first observer run
      disableMrky();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.mrkyEnabled !== undefined) {
      const newState = changes.mrkyEnabled.newValue !== false;
      if (newState && !mrkyEnabled) {
        enableMrky();
      } else if (!newState && mrkyEnabled) {
        disableMrky();
      }
    }
  });

  console.log('[Mrky] ✅ Mrky initialized successfully');
})();
