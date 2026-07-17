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
      processElementTextNodes(el);
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

/**
 * Recursively find all text nodes within a element, avoiding tags like script, style, pre, etc.
 */
function getTextNodes(node) {
  const textNodes = [];
  function traverse(n) {
    const ignoredTags = ['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'NOSCRIPT', 'IFRAME', 'SVG', 'MATH'];
    if (n.nodeType === Node.ELEMENT_NODE) {
      if (ignoredTags.includes(n.tagName) || n.classList.contains('mrky-word') || n.dataset.mrkyProcessed) {
        return;
      }
      for (const child of Array.from(n.childNodes)) {
        traverse(child);
      }
    } else if (n.nodeType === Node.TEXT_NODE) {
      if (n.textContent.trim().length > 0) {
        textNodes.push(n);
      }
    }
  }
  traverse(node);
  return textNodes;
}

/**
 * Process text nodes inside a container individually to preserve links and HTML tags.
 */
function processElementTextNodes(el) {
  const textNodes = getTextNodes(el);
  const parentText = el.textContent; // Used for full sentence context in tooltips

  for (const node of textNodes) {
    const fullText = node.textContent;
    
    // Skip text without alphabetical characters
    if (!/[a-zA-Z]/.test(fullText)) {
      continue;
    }

    // Skip text that is predominantly non-English
    const strippedText = fullText.replace(/\s/g, '');
    const latinCount = (fullText.match(/[a-zA-Z]/g) || []).length;
    if (strippedText.length > 10 && latinCount / strippedText.length < 0.4) {
      continue;
    }

    // Analyze the text
    const analyzed = analyzeText(fullText, knownWords);
    
    const fragment = document.createDocumentFragment();
    const parentEl = node.parentNode || el;

    // Rebuild text node content with interactive spans and plain text segments
    for (const item of analyzed) {
      if (item.pre) {
        fragment.appendChild(document.createTextNode(item.pre));
      }

      const isLatin = /[a-zA-Z]/.test(item.word);
      if (isLatin) {
        const wordSpan = document.createElement('span');
        wordSpan.className = `mrky-word ${item.posInfo.class}`;
        wordSpan.textContent = item.word;
        wordSpan.dataset.word = item.word;
        wordSpan.dataset.pos = item.pos;

        // Apply visual classes
        if (item.isStop) wordSpan.classList.add('mrky-stop');
        if (item.isKnown) wordSpan.classList.add('mrky-known');

        // Interaction (only for non-stop words)
        if (!item.isStop) {
          const isPdfMode = window.location.pathname.includes('pdf-reader') || parentEl.closest('.textLayer') !== null;
          
          if (isPdfMode) {
            wordSpan.addEventListener('click', (e) => {
              if (!mrkyEnabled) return;
              e.stopPropagation();
              clearTimeout(hideTimeout);
              document.querySelectorAll('.mrky-word-hover').forEach(s => s.classList.remove('mrky-word-hover'));
              wordSpan.classList.add('mrky-word-hover');
              showTooltip(wordSpan, item.word, item.posInfo, parentText);
            });
          } else {
            wordSpan.addEventListener('mouseenter', () => {
              if (!mrkyEnabled) return;
              clearTimeout(hideTimeout);
              wordSpan.classList.add('mrky-word-hover');
              showTooltip(wordSpan, item.word, item.posInfo, parentText);
            });

            wordSpan.addEventListener('mouseleave', () => {
              wordSpan.classList.remove('mrky-word-hover');
              hideTimeout = setTimeout(() => hideTooltip(), 300);
            });
          }
        }

        fragment.appendChild(wordSpan);
      } else {
        // Non-Latin word (Arabic, numbers, emojis) — append as plain text node
        fragment.appendChild(document.createTextNode(item.word));
      }

      if (item.post) {
        fragment.appendChild(document.createTextNode(item.post));
      }
    }

    // Safely replace the text node with our new spans and text nodes
    if (node.parentNode) {
      node.parentNode.replaceChild(fragment, node);
    }
  }

  // Mark container as processed
  el.dataset.mrkyProcessed = 'true';
}
