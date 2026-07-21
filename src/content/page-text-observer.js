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
  const elements = Array.from(document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, div, span, a, td, th, dt, dd, figcaption, [data-mrky-pdf-text]'))
    .filter(el => {
      if (el.dataset.mrkyProcessed || el.classList.contains('mrky-word') || el.closest('.mrky-word')) return false;
      // Safeguard: ignore massive layout containers to prevent freezing, but process small ones
      if ((el.tagName === 'DIV' || el.tagName === 'SPAN' || el.tagName === 'TD') && el.children.length > 5) return false;
      return true;
    });

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
 * Extract a bounded sentence around a word from a larger text.
 * Prevents passing entire-page content (e.g. Wikipedia) as the
 * "sentence" parameter to showTooltip.
 */
function extractSentenceContext(text, word, maxLen = 300) {
  if (text.length <= maxLen) return text;

  const lower = text.toLowerCase();
  const idx = lower.indexOf(word.toLowerCase());
  if (idx === -1) return text.slice(0, maxLen);

  // Walk backward to sentence start (. ! ? or newline)
  let start = idx;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;

  // Walk forward to sentence end
  let end = idx + word.length;
  while (end < text.length && !/[.!?\n]/.test(text[end])) end++;
  if (end < text.length) end++; // include the punctuation

  let sentence = text.slice(start, end).trim();

  // If still too long (no punctuation found), fall back to a
  // character window centred on the word.
  if (sentence.length > maxLen) {
    const half = Math.floor(maxLen / 2);
    sentence = text.slice(Math.max(0, idx - half), Math.min(text.length, idx + word.length + half)).trim();
  }
  return sentence;
}

/**
 * Process text nodes inside a container individually to preserve links and HTML tags.
 */
function processElementTextNodes(el) {
  const textNodes = getTextNodes(el);
  const parentText = el.textContent; // Full container text — extractSentenceContext bounds it per-word

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
              showTooltip(wordSpan, item.word, item.posInfo, extractSentenceContext(parentText, item.word));
            });
          } else {
            wordSpan.addEventListener('mouseenter', () => {
              if (!mrkyEnabled) return;
              clearTimeout(hideTimeout);
              wordSpan.classList.add('mrky-word-hover');
              showTooltip(wordSpan, item.word, item.posInfo, extractSentenceContext(parentText, item.word));
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
