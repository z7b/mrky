/**
 * Mrky Translation Tooltip
 * Renders the floating popup that appears when hovering over a word.
 * Shows: word, POS tag, Arabic translation, and "Add Card" button.
 */
import { translateViaBackground } from '../shared/translate.js';
import { addCard, markAsKnown } from '../shared/db.js';
import { playPronunciation } from '../shared/audio.js';
import { mrkyEnabled } from './enabled-state.js';
import { analyzeText } from '../shared/nlp-processor.js';
import { getKnownWordsSet } from '../shared/db.js';

let tooltipEl = null;
let currentWord = null;
let isTooltipHovered = false;
let selectionAnchor = null;

/**
 * Initialize the tooltip container (called once on content script load).
 */
export function initTooltip() {
  if (tooltipEl) return;

  tooltipEl = document.createElement('div');
  tooltipEl.id = 'mrky-tooltip';
  tooltipEl.className = 'mrky-tooltip';
  tooltipEl.innerHTML = `
    <div class="mrky-tooltip-inner">
      <div class="mrky-tooltip-header">
        <span class="mrky-tooltip-pos"></span>
        <span class="mrky-tooltip-word"></span>
        <button class="mrky-btn-speak" title="انطق الكلمة">🔊</button>
      </div>
      <div class="mrky-tooltip-translation">
        <span class="mrky-tooltip-loading">جاري الترجمة...</span>
      </div>
      <div class="mrky-tooltip-actions">
        <button class="mrky-btn-add" title="أضف بطاقة">+ أضف بطاقة</button>
        <button class="mrky-btn-known" title="أعرف هذي الكلمة">✓ أعرفها</button>
      </div>
    </div>
    <div class="mrky-tooltip-arrow"></div>
  `;

  // Prevent tooltip from closing when hovering over it
  tooltipEl.addEventListener('mouseenter', () => {
    isTooltipHovered = true;
  });
  tooltipEl.addEventListener('mouseleave', () => {
    isTooltipHovered = false;
    hideTooltip();
  });

  // "Add Card" button
  tooltipEl.querySelector('.mrky-btn-add').addEventListener('click', handleAddCard);

  // "I know this" button
  tooltipEl.querySelector('.mrky-btn-known').addEventListener('click', handleMarkKnown);

  // "Speak" button
  tooltipEl.querySelector('.mrky-btn-speak').addEventListener('click', handleSpeak);

  // Close tooltip when clicking outside (essential for click-to-select in PDF mode)
  document.addEventListener('click', (e) => {
    if (tooltipEl && !tooltipEl.contains(e.target) && !e.target.classList.contains('mrky-word')) {
      hideTooltip(true);
    }
  });

  // Drag select listener for PDF Mode
  document.addEventListener('mouseup', handleMouseSelection);

  document.body.appendChild(tooltipEl);
}

/**
 * Helper to extract the exact English word under the mouse cursor.
 * Uses Chrome's caretRangeFromPoint to bypass misaligned transparent text layer boundaries.
 */
function getWordAtPoint(x, y) {
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range) {
      const textNode = range.startContainer;
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        const offset = range.startOffset;
        const text = textNode.nodeValue;
        
        // Find word boundaries (letters, numbers, apostrophes, hyphens)
        const leftMatch = text.slice(0, offset).match(/[a-zA-Z0-9'-]+$/);
        const rightMatch = text.slice(offset).match(/^[a-zA-Z0-9'-]+/);
        
        const left = leftMatch ? leftMatch[0] : '';
        const right = rightMatch ? rightMatch[0] : '';
        
        return (left + right).trim();
      }
    }
  }
  return null;
}

/**
 * Handle drag-to-select text event (mouse selection translation).
 * Dedicated to PDF Reader or pages where the user highlights text with mouse.
 */
async function handleMouseSelection(e) {
  if (!mrkyEnabled) return;

  // Skip if clicking inside tooltip
  if (tooltipEl && tooltipEl.contains(e.target)) return;

  // Verify if we are inside the PDF reader context
  const isPdfReader = window.location.pathname.includes('pdf-reader') || document.querySelector('.pdf-viewer') !== null;
  if (!isPdfReader) return;

  setTimeout(async () => {
    const selection = window.getSelection();
    if (!selection) return;

    let selectedText = selection.toString().trim();
    if (!selectedText) return;

    // Detect double click (single word selection) vs drag selection
    const isDoubleClick = (e.detail === 2);

    if (isDoubleClick) {
      const wordAtPoint = getWordAtPoint(e.clientX, e.clientY);
      if (wordAtPoint && /[a-zA-Z]/.test(wordAtPoint)) {
        selectedText = wordAtPoint;
      } else {
        // Fallback: take the first word of the selection
        const words = selectedText.split(/\s+/);
        if (words.length > 0) {
          selectedText = words[0];
        }
      }
    } else {
      // For drag selections, if it looks like a single word but has trailing spaces/artifacts, clean it.
      const words = selectedText.split(/\s+/);
      if (words.length === 2 && words[1].length <= 2) {
        // e.g. "Results an" -> if the second word is very short, it's likely a PDF.js overlap artifact
        selectedText = words[0];
      }
    }

    // Clean up selection text constraints
    if (selectedText.length > 0 && selectedText.length < 150 && /[a-zA-Z]/.test(selectedText)) {
      const range = selection.getRangeAt(0);
      let rect = range.getBoundingClientRect();
      
      // Fallback for PDF.js text layer (where selection ranges might return empty rects due to transparent elements)
      if (rect.width === 0 || rect.height === 0) {
        const anchorNode = selection.anchorNode;
        if (anchorNode && anchorNode.parentElement && anchorNode.parentElement.getBoundingClientRect) {
          rect = anchorNode.parentElement.getBoundingClientRect();
        } else {
          return;
        }
      }
      
      if (rect.width === 0 && rect.height === 0) return;

      const knownWords = await getKnownWordsSet();
      const analyzed = analyzeText(selectedText, knownWords);

      // Get POS info
      const posInfo = (analyzed && analyzed[0]?.posInfo) || { label: 'select', color: 'rgba(255,255,255,0.4)', class: 'mrky-other' };

      // Create temporary target element to position tooltip relative to selected bounding box
      if (selectionAnchor) selectionAnchor.remove();

      selectionAnchor = document.createElement('div');
      selectionAnchor.style.position = 'absolute';
      // Offset for scroll position
      selectionAnchor.style.left = `${window.scrollX + rect.left}px`;
      selectionAnchor.style.top = `${window.scrollY + rect.top}px`;
      selectionAnchor.style.width = `${rect.width}px`;
      selectionAnchor.style.height = `${rect.height}px`;
      selectionAnchor.style.pointerEvents = 'none';
      document.body.appendChild(selectionAnchor);

      // Show tooltip above the selection!
      showTooltip(selectionAnchor, selectedText, posInfo, selectedText);
    }
  }, 30);
}

/**
 * Show the tooltip for a specific word.
 * @param {HTMLElement} wordEl - The word span element in the overlay
 * @param {string} word - The English word
 * @param {Object} posInfo - POS info object from nlp-processor
 * @param {string} sentence - Full subtitle sentence for context
 */
export async function showTooltip(wordEl, word, posInfo, sentence) {
  if (!mrkyEnabled) return; // Blocked — extension is OFF
  if (!tooltipEl) initTooltip();

  currentWord = { word, posInfo, sentence };

  // Fill in the word and POS
  const posEl = tooltipEl.querySelector('.mrky-tooltip-pos');
  const wordElInner = tooltipEl.querySelector('.mrky-tooltip-word');
  const translationEl = tooltipEl.querySelector('.mrky-tooltip-translation');
  const addBtn = tooltipEl.querySelector('.mrky-btn-add');

  posEl.textContent = posInfo.label;
  posEl.style.background = posInfo.color;
  posEl.style.color = posInfo.label === 'verb' ? '#1A1A2E' : '#fff';
  wordElInner.textContent = word;

  // Show loading state and disable add button
  translationEl.innerHTML = '<span class="mrky-tooltip-loading">جاري الترجمة...</span>';
  if (addBtn) {
    addBtn.disabled = true;
    addBtn.textContent = '⏳ جاري الترجمة...';
  }

  // Position the tooltip above the word
  positionTooltip(wordEl);
  tooltipEl.classList.add('mrky-tooltip-visible');

  // Pause the video
  pauseVideo();

  // Fetch translation — try with context first, fall back to word-only
  try {
    const shortContext = extractContext(word, sentence, 120);
    let result = await translateViaBackground(word, shortContext);

    // If contextual translation failed, retry with just the word (no context)
    if (!result || !result.translation || result.translation === '⚠ خطأ' || result.translation === '⚠ خطأ في الترجمة') {
      console.warn('[Mrky] Context translation failed, retrying word-only...');
      result = await translateViaBackground(word, '');
    }

    // Bail out if the tooltip was dismissed while we were awaiting translation
    if (!currentWord) return;

    // Final check
    if (result && result.translation && result.translation !== '⚠ خطأ' && result.translation !== '⚠ خطأ في الترجمة') {
      translationEl.textContent = result.translation;
      currentWord.translation = result.translation;
      if (addBtn) {
        addBtn.disabled = false;
        addBtn.textContent = '+ أضف بطاقة';
      }
    } else {
      translationEl.textContent = '⚠ خطأ في الترجمة';
      if (addBtn) {
        addBtn.textContent = '⚠ فشل الترجمة';
      }
    }
  } catch (err) {
    console.error('[Mrky] Translation error:', err);
    if (!currentWord) return;
    translationEl.textContent = '⚠ خطأ في الترجمة';
    if (addBtn) {
      addBtn.textContent = '⚠ فشل الترجمة';
    }
  }
}

/**
 * Hide the tooltip.
 * @param {boolean} force - Force hide even if tooltip is hovered
 */
export function hideTooltip(force = false) {
  if (!force && isTooltipHovered) return; // Don't hide if user is hovering over tooltip
  if (!tooltipEl) return;

  tooltipEl.classList.remove('mrky-tooltip-visible');
  currentWord = null;
  document.querySelectorAll('.mrky-word-hover').forEach(el => el.classList.remove('mrky-word-hover'));

  if (selectionAnchor) {
    selectionAnchor.remove();
    selectionAnchor = null;
  }

  // Resume video playback
  resumeVideo();
}

/**
 * Check if tooltip is currently visible.
 * @returns {boolean}
 */
export function isTooltipVisible() {
  return tooltipEl && tooltipEl.classList.contains('mrky-tooltip-visible');
}

/**
 * Position the tooltip above the target word element.
 * @param {HTMLElement} wordEl
 */
function positionTooltip(wordEl) {
  const rect = wordEl.getBoundingClientRect();
  const tooltipRect = tooltipEl.getBoundingClientRect();

  let left = rect.left + rect.width / 2 - 130; // Tooltip is ~260px wide
  let top = rect.top - 10; // 10px gap above the word

  // Prevent going off-screen left/right
  if (left < 10) left = 10;
  if (left + 260 > window.innerWidth - 10) left = window.innerWidth - 270;

  // If no room above, show below
  if (top < 100) {
    top = rect.bottom + 10;
    tooltipEl.classList.add('mrky-tooltip-below');
  } else {
    tooltipEl.classList.remove('mrky-tooltip-below');
  }

  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
  tooltipEl.style.transform = 'translateY(-100%)';
}

/**
 * Handle "Add Card" button click.
 */
async function handleAddCard() {
  if (!currentWord) return;

  const btn = tooltipEl.querySelector('.mrky-btn-add');
  btn.disabled = true;
  btn.textContent = '⏳ جاري الحفظ...';

  try {
    // Request screenshot from background script
    const screenshot = await captureScreenshot();

    await addCard({
      word: currentWord.word,
      translation: currentWord.translation || '',
      pos: currentWord.posInfo.label,
      sentence: currentWord.sentence,
      contextUrl: window.location.href,
      screenshot: screenshot,
    });

    btn.textContent = '✅ تم الحفظ!';
    btn.classList.add('mrky-btn-saved');

    setTimeout(() => {
      btn.textContent = '+ أضف بطاقة';
      btn.disabled = false;
      btn.classList.remove('mrky-btn-saved');
      hideTooltip();
    }, 1200);
  } catch (error) {
    console.error('[Mrky] Error saving card:', error);
    btn.textContent = '⚠ خطأ';
    btn.disabled = false;
  }
}

/**
 * Handle "I know this" button click.
 */
async function handleMarkKnown() {
  if (!currentWord) return;

  const btn = tooltipEl.querySelector('.mrky-btn-known');
  btn.disabled = true;

  try {
    await markAsKnown(currentWord.word);
    btn.textContent = '✅ تم!';

    // Dispatch event so the overlay can update the word's style
    document.dispatchEvent(new CustomEvent('mrky-word-known', {
      detail: { word: currentWord.word.toLowerCase() },
    }));

    setTimeout(() => {
      btn.textContent = '✓ أعرفها';
      btn.disabled = false;
      hideTooltip();
    }, 800);
  } catch (error) {
    console.error('[Mrky] Error marking word as known:', error);
    btn.disabled = false;
  }
}

/**
 * Handle "Speak" button click — pronounce the word using real human/neural audio.
 */
function handleSpeak() {
  if (!currentWord) return;

  const btn = tooltipEl.querySelector('.mrky-btn-speak');
  playPronunciation(currentWord.word, {
    onStart: () => btn.classList.add('mrky-btn-speak-active'),
    onEnd: () => btn.classList.remove('mrky-btn-speak-active'),
    onError: () => btn.classList.remove('mrky-btn-speak-active'),
  });
}

/**
 * Find and pause the video player on the current page.
 */
function pauseVideo() {
  const video = document.querySelector('video');
  if (video && !video.paused) {
    video.pause();
    video.dataset.mrkyPaused = 'true';
  }
}

/**
 * Resume the video player (only if we paused it).
 */
function resumeVideo() {
  const video = document.querySelector('video');
  if (video && video.dataset.mrkyPaused === 'true') {
    video.play();
    delete video.dataset.mrkyPaused;
  }
}

/**
 * Request a screenshot capture from the background service worker.
 * @returns {Promise<string>} Base64 screenshot data URL
 */
function captureScreenshot() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (response) => {
        resolve(response?.screenshot || null);
      });
    } else {
      resolve(null);
    }
  });
}

/**
 * Extract a short context snippet around the target word from a long text.
 * Keeps the result within maxLen characters to avoid API query limits.
 * @param {string} word - The target word
 * @param {string} text - The full text (could be a whole paragraph)
 * @param {number} maxLen - Max context length
 * @returns {string} A short snippet centered around the word
 */
function extractContext(word, text, maxLen = 120) {
  if (!text || text.length <= maxLen) return text || '';

  const idx = text.toLowerCase().indexOf(word.toLowerCase());
  if (idx === -1) return text.slice(0, maxLen);

  const half = Math.floor(maxLen / 2);
  let start = Math.max(0, idx - half);
  let end = Math.min(text.length, idx + word.length + half);

  // Try to snap to word boundaries
  if (start > 0) {
    const spaceAfterStart = text.indexOf(' ', start);
    if (spaceAfterStart !== -1 && spaceAfterStart < idx) start = spaceAfterStart + 1;
  }
  if (end < text.length) {
    const spaceBeforeEnd = text.lastIndexOf(' ', end);
    if (spaceBeforeEnd > idx + word.length) end = spaceBeforeEnd;
  }

  return text.slice(start, end).trim();
}

