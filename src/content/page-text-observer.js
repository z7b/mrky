/**
 * Mrky Page Text Observer
 * Scans static web pages for readable text and applies Mrky's interactive color-coding.
 */
import { analyzeText } from '../shared/nlp-processor.js';
import { getKnownWordsSet } from '../shared/db.js';
import { showTooltip, hideTooltip } from './tooltip.js';
import { mrkyEnabled } from './enabled-state.js';

let knownWords = new Set();
let hideTimeout = null;

/**
 * Start observing static text on generic web pages.
 */
export async function startPageTextObserver() {
  knownWords = await getKnownWordsSet();
  
  // Process existing text nodes
  processPageText();

  // Listen for new elements (e.g. infinite scroll)
  const observer = new MutationObserver((mutations) => {
    let shouldProcess = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        shouldProcess = true;
        break;
      }
    }
    if (shouldProcess) {
      // Debounce to prevent freezing the page
      clearTimeout(window.__mrkyPageTextTimer);
      window.__mrkyPageTextTimer = setTimeout(() => {
        processPageText();
      }, 1000);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Listen for "word known" events to update styles and local Set in real-time
  document.addEventListener('mrky-word-known', (e) => {
    const word = e.detail.word;
    if (word) {
      knownWords.add(word.toLowerCase());
    }
    const spans = document.querySelectorAll('.mrky-word');
    spans.forEach((span) => {
      if (span.dataset.word && span.dataset.word.toLowerCase() === word) {
        span.classList.add('mrky-known');
      }
    });
  });
}

/**
 * Process common readable elements on the page in batches to prevent UI freezing.
 */
function processPageText() {
  // Skip ALL processing if extension is disabled
  if (!mrkyEnabled) return;

  // Find common readable text containers that are not yet processed
  const elements = Array.from(document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, [data-mrky-pdf-text]'))
    .filter(el => !el.dataset.mrkyProcessed && !el.classList.contains('mrky-word') && !el.closest('.mrky-word'));

  if (elements.length === 0) return;

  let index = 0;
  const batchSize = 15;

  function processBatch() {
    const end = Math.min(index + batchSize, elements.length);
    for (let i = index; i < end; i++) {
      const el = elements[i];

      // Safe mode: Only process elements that contain pure text and NO child elements (like <a> or <strong>)
      if (el.children.length === 0 && el.textContent.trim().length > 0) {
        const fullText = el.textContent;
        
        // Skip text without alphabetical characters
        if (!/[a-zA-Z]/.test(fullText)) {
          el.dataset.mrkyProcessed = 'true';
          continue;
        }

        // Skip text that is predominantly non-English (e.g. Arabic, Chinese, etc.)
        // Only process paragraphs where at least 40% of characters are Latin
        const strippedText = fullText.replace(/\s/g, '');
        const latinCount = (fullText.match(/[a-zA-Z]/g) || []).length;
        if (strippedText.length > 10 && latinCount / strippedText.length < 0.4) {
          el.dataset.mrkyProcessed = 'true';
          continue;
        }

        // Analyze the text
        const analyzed = analyzeText(fullText, knownWords);
        
        // Clear the element and mark it
        el.innerHTML = '';
        el.dataset.mrkyProcessed = 'true';

        // Rebuild the element with interactive spans
        for (const item of analyzed) {
          if (item.pre) {
            el.appendChild(document.createTextNode(item.pre));
          }

          const wordSpan = document.createElement('span');
          wordSpan.className = `mrky-word ${item.posInfo.class}`;
          wordSpan.textContent = item.word;
          wordSpan.dataset.word = item.word;
          wordSpan.dataset.pos = item.pos;
          // Color is applied via CSS class (.mrky-noun, .mrky-verb, etc.)
          // NOT inline style — so page-context overrides for light backgrounds work correctly

          // Apply visual classes
          if (item.isStop) wordSpan.classList.add('mrky-stop');
          if (item.isKnown) wordSpan.classList.add('mrky-known');

          // Interaction (only for non-stop words)
          if (!item.isStop) {
            const isPdfMode = window.location.pathname.includes('pdf-reader') || el.closest('.textLayer') !== null;
            
            if (isPdfMode) {
              // PDF Mode ONLY: Interaction via mouse click (not automatic hover)
              wordSpan.addEventListener('click', (e) => {
                if (!mrkyEnabled) return; // Blocked
                e.stopPropagation();
                clearTimeout(hideTimeout);
                document.querySelectorAll('.mrky-word-hover').forEach(s => s.classList.remove('mrky-word-hover'));
                wordSpan.classList.add('mrky-word-hover');
                showTooltip(wordSpan, item.word, item.posInfo, fullText);
              });
            } else {
              // Standard Web Mode: Automatic hover interaction
              wordSpan.addEventListener('mouseenter', () => {
                if (!mrkyEnabled) return; // Blocked
                clearTimeout(hideTimeout);
                wordSpan.classList.add('mrky-word-hover');
                showTooltip(wordSpan, item.word, item.posInfo, fullText);
              });

              wordSpan.addEventListener('mouseleave', () => {
                wordSpan.classList.remove('mrky-word-hover');
                hideTimeout = setTimeout(() => hideTooltip(), 300);
              });
            }
          }

          el.appendChild(wordSpan);

          if (item.post) {
            el.appendChild(document.createTextNode(item.post));
          }
        }
      } else {
        // Skip formatting element safely but mark it as processed
        el.dataset.mrkyProcessed = 'true';
      }
    }

    index = end;
    if (index < elements.length) {
      if (window.requestIdleCallback) {
        window.requestIdleCallback(() => processBatch());
      } else {
        setTimeout(processBatch, 0);
      }
    }
  }

  processBatch();
}
