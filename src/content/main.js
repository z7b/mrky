/**
 * Mrky Content Script — Entry Point
 * Initializes all Mrky features when injected into web pages.
 * Controls global ON/OFF state via chrome.storage.local['mrkyEnabled'].
 * Site governance via chrome.storage.local['mrkySiteMode'] and ['mrkyCustomSites'].
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

  const hostname = window.location.hostname.replace(/^www\./, '').toLowerCase();

  // Initialize shared components (they always exist, but check mrkyEnabled before acting)
  initTooltip();
  initOverlay();
  initOCR();

  /**
   * Check if the current page has primarily English content.
   * Uses the page's lang attribute and a sample of visible text.
   * @returns {boolean}
   */
  function isPageEnglish() {
    // 1. Check <html lang="..."> attribute
    const htmlLang = (document.documentElement.lang || '').toLowerCase();
    if (htmlLang.startsWith('en')) return true;
    // If the page explicitly declares a non-English language, respect it
    if (htmlLang && !htmlLang.startsWith('en') && htmlLang.length >= 2) return false;

    // 2. Sample visible text to detect English content
    const textNodes = document.querySelectorAll('p, h1, h2, h3, article, [role="main"]');
    let sampleText = '';
    for (let i = 0; i < Math.min(textNodes.length, 10); i++) {
      sampleText += ' ' + (textNodes[i].textContent || '').slice(0, 200);
    }
    sampleText = sampleText.trim();
    if (sampleText.length < 20) return true; // Not enough text to judge, allow

    // Count Latin characters vs total
    const latinChars = (sampleText.match(/[a-zA-Z]/g) || []).length;
    const totalChars = sampleText.replace(/\s/g, '').length;
    const latinRatio = totalChars > 0 ? latinChars / totalChars : 0;

    // Split sample text into words and verify existence of English stopwords
    const words = sampleText.toLowerCase().split(/[^a-z]+/);
    const englishStopwords = new Set(['the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'you', 'was', 'for', 'on', 'are', 'as', 'with']);
    const stopwordCount = words.filter(w => englishStopwords.has(w)).length;
    
    // Heuristic: Must be > 65% Latin and contain a minimum number/ratio of English stopwords
    const hasEnglishStopwords = stopwordCount >= 2 || (words.length > 0 && (stopwordCount / words.length) > 0.02);

    return latinRatio > 0.65 && hasEnglishStopwords;
  }

  /**
   * Check if Mrky should activate on the current site based on site governance settings.
   * @param {string} mode - Site mode: 'all', 'custom', or 'english'
   * @param {string[]} customSites - List of allowed custom site domains
   * @returns {boolean}
   */
  function isSiteAllowed(mode, customSites) {
    // Extension internal pages (popup, review, player, pdf-reader) — always allowed
    if (window.location.protocol === 'chrome-extension:') return true;

    // Video platforms — always allowed at site level because they host multilingual videos.
    // We handle English language filtering dynamically at the subtitle & paragraph levels.
    if (
      hostname.includes('youtube.com') ||
      hostname.includes('netflix.com') ||
      hostname.includes('disneyplus.com')
    ) {
      return true;
    }

    switch (mode) {
      case 'all':
        return true;

      case 'custom': {
        if (!customSites || customSites.length === 0) return false;
        return customSites.some(site => {
          // Match exact domain or subdomain (e.g. "youtube.com" matches "www.youtube.com")
          return hostname === site || hostname.endsWith('.' + site);
        });
      }

      case 'english':
        return isPageEnglish();

      default:
        return true;
    }
  }

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

  // ─── Load initial state with site governance ───
  chrome.storage.local.get(['mrkyEnabled', 'mrkySiteMode', 'mrkyCustomSites'], (res) => {
    const isEnabled = res.mrkyEnabled !== false;
    const siteMode = res.mrkySiteMode || 'all';
    const customSites = res.mrkyCustomSites || [];

    if (isEnabled && isSiteAllowed(siteMode, customSites)) {
      enableMrky();
    } else {
      if (!isEnabled) {
        console.log('[Mrky] ⏸️ Extension is disabled by user.');
      } else {
        console.log(`[Mrky] 🚫 Site "${hostname}" is not allowed in mode "${siteMode}". Mrky will not activate.`);
      }
      disableMrky();
    }
  });

  // Listen for real-time changes to enabled state AND site governance settings
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    const hasToggleChange = changes.mrkyEnabled !== undefined;
    const hasModeChange = changes.mrkySiteMode !== undefined;
    const hasSitesChange = changes.mrkyCustomSites !== undefined;

    if (hasToggleChange || hasModeChange || hasSitesChange) {
      // Re-evaluate the full state
      chrome.storage.local.get(['mrkyEnabled', 'mrkySiteMode', 'mrkyCustomSites'], (res) => {
        const isEnabled = res.mrkyEnabled !== false;
        const siteMode = res.mrkySiteMode || 'all';
        const customSites = res.mrkyCustomSites || [];
        const shouldActivate = isEnabled && isSiteAllowed(siteMode, customSites);

        if (shouldActivate && !mrkyEnabled) {
          enableMrky();
        } else if (!shouldActivate && mrkyEnabled) {
          disableMrky();
        }
      });
    }
  });

  console.log('[Mrky] ✅ Mrky initialized successfully');
})();
