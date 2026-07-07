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
export function initOverlay() {
  if (overlayContainer) return;

  // Create the subtitle overlay container
  overlayContainer = document.createElement('div');
  overlayContainer.id = 'mrky-overlay';
  overlayContainer.className = 'mrky-overlay';
  document.body.appendChild(overlayContainer);

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
  document.body.appendChild(legendContainer);

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

  // Clear previous subtitles
  overlayContainer.innerHTML = '';

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

    // Hover interaction (only for non-stop words)
    if (!item.isStop) {
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

  overlayContainer.appendChild(sentenceEl);

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

  overlayContainer.style.position = 'absolute';
  overlayContainer.style.left = `${window.scrollX + videoRect.left}px`;
  overlayContainer.style.width = `${videoRect.width}px`;
  overlayContainer.style.top = `${window.scrollY + videoRect.bottom - 60}px`;
  overlayContainer.style.transform = 'translateY(-100%)';
}

/**
 * Position the color legend at the top-left of the video.
 * @param {DOMRect} videoRect
 */
function positionLegend(videoRect) {
  if (!legendContainer) return;

  legendContainer.style.position = 'absolute';
  legendContainer.style.left = `${window.scrollX + videoRect.left + 12}px`;
  legendContainer.style.top = `${window.scrollY + videoRect.top + 12}px`;
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
