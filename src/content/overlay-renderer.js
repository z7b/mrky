/**
 * Mrky Subtitle Overlay Renderer
 * Takes NLP-analyzed word data and renders color-coded interactive subtitles
 * over the original YouTube/Netflix subtitles.
 */
import { showTooltip, hideTooltip } from './tooltip.js';
import { mrkyEnabled } from './enabled-state.js';

let overlayContainer = null;
let legendContainer = null;
let hideTimeout = null;

/**
 * Initialize the overlay container positioned over the video player.
 */
export function initOverlay(customParent = null) {
  if (overlayContainer) {
    // If the overlay exists but is attached to body and we now have a player, re-parent it
    if (customParent && overlayContainer.parentElement !== customParent) {
      customParent.appendChild(overlayContainer);
      if (legendContainer) {
        customParent.appendChild(legendContainer);
      }
    }
    return;
  }

  // Create the subtitle overlay container
  overlayContainer = document.createElement('div');
  overlayContainer.id = 'mrky-overlay';
  overlayContainer.className = 'mrky-overlay';
  overlayContainer.setAttribute('role', 'region');
  overlayContainer.setAttribute('aria-label', 'ترجمة تفاعلية');
  overlayContainer.setAttribute('aria-live', 'polite');

  // Create the color legend
  legendContainer = document.createElement('div');
  legendContainer.id = 'mrky-legend';
  legendContainer.className = 'mrky-legend';
  legendContainer.innerHTML = `
    <div class="mrky-legend-item">
      <span class="mrky-legend-dot" style="background:#4299E1"></span>
      <span>أسماء</span>
    </div>
    <div class="mrky-legend-item">
      <span class="mrky-legend-dot" style="background:#ECC94B"></span>
      <span>أفعال</span>
    </div>
    <div class="mrky-legend-item">
      <span class="mrky-legend-dot" style="background:#48BB78"></span>
      <span>صفات</span>
    </div>
  `;

  if (customParent) {
    customParent.appendChild(overlayContainer);
    customParent.appendChild(legendContainer);
  } else {
    document.body.appendChild(overlayContainer);
    document.body.appendChild(legendContainer);
  }

  // Listen for "word known" events to update styles in real-time
  document.addEventListener('mrky-word-known', (e) => {
    const word = e.detail.word;
    const spans = overlayContainer.querySelectorAll('.mrky-word');
    spans.forEach((span) => {
      if (span.dataset.word.toLowerCase() === word) {
        span.classList.add('mrky-known');
      }
    });
  });
}

/**
 * Render analyzed words as color-coded interactive subtitle overlay.
 * @param {Array} analyzedWords - Output from nlp-processor.analyzeText()
 * @param {string} fullSentence - The full original sentence
 * @param {DOMRect} videoRect - Bounding rect of the video element
 */
export function renderSubtitles(analyzedWords, fullSentence, videoRect) {
  if (!mrkyEnabled) return; // Blocked — extension is OFF
  if (!overlayContainer) initOverlay();

  // Build entire subtitle tree off-DOM using DocumentFragment (single reflow on insert)
  const fragment = document.createDocumentFragment();

  // Create sentence container
  const sentenceEl = document.createElement('div');
  sentenceEl.className = 'mrky-sentence';

  for (const item of analyzedWords) {
    // Add leading whitespace/punctuation
    if (item.pre) {
      const preSpan = document.createElement('span');
      preSpan.className = 'mrky-pre';
      preSpan.textContent = item.pre;
      sentenceEl.appendChild(preSpan);
    }

    // Create the word span
    const wordSpan = document.createElement('span');
    wordSpan.className = `mrky-word ${item.posInfo.class}`;
    wordSpan.textContent = item.word;
    wordSpan.dataset.word = item.word;
    wordSpan.dataset.pos = item.pos;
    wordSpan.style.color = item.posInfo.color;

    // Make stop words / known words semi-transparent
    if (item.isStop) {
      wordSpan.classList.add('mrky-stop');
    }
    if (item.isKnown) {
      wordSpan.classList.add('mrky-known');
    }

    // Hover + keyboard interaction (only for non-stop words)
    if (!item.isStop) {
      wordSpan.setAttribute('tabindex', '0');
      wordSpan.setAttribute('role', 'button');
      wordSpan.setAttribute('aria-label', `${item.word} — ${item.posInfo.label}`);

      wordSpan.addEventListener('mouseenter', () => {
        if (!mrkyEnabled) return; // Blocked
        clearTimeout(hideTimeout);
        wordSpan.classList.add('mrky-word-hover');
        showTooltip(wordSpan, item.word, item.posInfo, fullSentence);
      });

      wordSpan.addEventListener('mouseleave', () => {
        wordSpan.classList.remove('mrky-word-hover');
        hideTimeout = setTimeout(() => {
          hideTooltip();
        }, 300); // Small delay to let user move to tooltip
      });

      // Keyboard accessibility: Enter/Space to show tooltip
      wordSpan.addEventListener('keydown', (e) => {
        if (!mrkyEnabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          clearTimeout(hideTimeout);
          wordSpan.classList.add('mrky-word-hover');
          showTooltip(wordSpan, item.word, item.posInfo, fullSentence);
        }
      });
    }

    sentenceEl.appendChild(wordSpan);

    // Add trailing whitespace/punctuation
    if (item.post) {
      const postSpan = document.createElement('span');
      postSpan.className = 'mrky-post';
      postSpan.textContent = item.post;
      sentenceEl.appendChild(postSpan);
    }
  }

  fragment.appendChild(sentenceEl);

  // Swap old subtitles with new ones in a single atomic DOM operation (1 reflow only)
  overlayContainer.replaceChildren(fragment);

  // Position overlay at the bottom of the video
  positionOverlay(videoRect);

  // Show the overlay
  overlayContainer.classList.add('mrky-overlay-visible');

  // Position the legend
  positionLegend(videoRect);
  legendContainer.classList.add('mrky-legend-visible');
}

/**
 * Clear the subtitle overlay.
 */
export function clearOverlay() {
  if (overlayContainer) {
    overlayContainer.innerHTML = '';
    overlayContainer.classList.remove('mrky-overlay-visible');
  }
}

/**
 * Position the overlay at the bottom-center of the video player.
 * @param {DOMRect} videoRect
 */
function positionOverlay(videoRect) {
  if (!overlayContainer) return;

  if (overlayContainer.parentElement === document.body) {
    overlayContainer.style.position = 'absolute';
    overlayContainer.style.left = `${window.scrollX + videoRect.left}px`;
    overlayContainer.style.width = `${videoRect.width}px`;
    overlayContainer.style.top = `${window.scrollY + videoRect.bottom - 60}px`;
    overlayContainer.style.transform = 'translateY(-100%)';
  } else {
    overlayContainer.style.removeProperty('left');
    overlayContainer.style.removeProperty('width');
    overlayContainer.style.removeProperty('top');
    overlayContainer.style.removeProperty('transform');
  }
}

/**
 * Position the color legend at the top-left of the video.
 * @param {DOMRect} videoRect
 */
function positionLegend(videoRect) {
  if (!legendContainer) return;

  if (legendContainer.parentElement === document.body) {
    legendContainer.style.position = 'absolute';
    legendContainer.style.left = `${window.scrollX + videoRect.left + 12}px`;
    legendContainer.style.top = `${window.scrollY + videoRect.top + 12}px`;
  } else {
    legendContainer.style.removeProperty('left');
    legendContainer.style.removeProperty('top');
  }
}

/**
 * Destroy and clean up the overlay.
 */
export function destroyOverlay() {
  if (overlayContainer) {
    overlayContainer.remove();
    overlayContainer = null;
  }
  if (legendContainer) {
    legendContainer.remove();
    legendContainer = null;
  }
}
