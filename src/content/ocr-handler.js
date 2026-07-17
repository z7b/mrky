/**
 * Mrky OCR Handler — Real Tesseract.js Integration
 * Two modes:
 * 1. Alt+S: Area selection → OCR → floating result panel with NLP coloring
 * 2. Alt+I: Image scan mode → click any image → text overlay with interactive Mrky words
 *
 * Uses Tesseract.js v5 for browser-based OCR (runs in Web Worker).
 */
import { analyzeText } from '../shared/nlp-processor.js';
import { translateViaBackground } from '../shared/translate.js';
import { getKnownWordsSet, addCard } from '../shared/db.js';
import { showTooltip, hideTooltip } from './tooltip.js';
import { mrkyEnabled } from './enabled-state.js';
import { playPronunciation } from '../shared/audio.js';
import { incrementUsageOnServer } from '../shared/supabase.js';

let isOCRMode = false;
let isImageScanMode = false;
let ocrOverlay = null;
let selectionBox = null;
let startX = 0;
let startY = 0;

/**
 * Send image to background script (which forwards to offscreen document) to run OCR.
 * @param {string} imageSource - base64 data URL
 * @returns {Promise<{text: string, words: Array}>} Extracted text and word bounding boxes
 */
async function runTesseractOCR(imageSource) {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage(
        { type: 'RUN_OCR', payload: { image: imageSource } },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ text: '', words: [] });
            return;
          }
          resolve(response || { text: '', words: [] });
        }
      );
    } else {
      resolve({ text: '', words: [] });
    }
  });
}

// ═══════════════════════════════════════════════
// MODE 1: Alt+S — Area Selection OCR
// ═══════════════════════════════════════════════

/**
 * Initialize OCR keyboard shortcuts.
 * Alt+S = Area selection OCR
 * Alt+I = Image scan mode (click image to overlay text)
 */
export function initOCR() {
  document.addEventListener('keydown', (e) => {
    if (!mrkyEnabled) return;

    // Alt+S: Area selection
    if (e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (isOCRMode) {
        exitOCRMode();
      } else if (isImageScanMode) {
        exitImageScanMode();
      } else {
        enterOCRMode();
      }
    }

    // Alt+I: Image scan mode
    if (e.altKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      if (isImageScanMode) {
        exitImageScanMode();
      } else if (isOCRMode) {
        exitOCRMode();
      } else {
        enterImageScanMode();
      }
    }
  });

  // Message listener for popup triggers
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'TRIGGER_OCR_SELECTION') {
        if (isOCRMode) {
          exitOCRMode();
        } else if (isImageScanMode) {
          exitImageScanMode();
        } else {
          enterOCRMode();
        }
        sendResponse({ success: true });
      }
    });
  }

  // DOM event listener for internal page buttons (like PDF Reader toolbar)
  document.addEventListener('mrky-trigger-ocr', () => {
    if (isOCRMode) {
      exitOCRMode();
    } else if (isImageScanMode) {
      exitImageScanMode();
    } else {
      enterOCRMode();
    }
  });
}

/**
 * Enter OCR area-selection mode.
 */
function enterOCRMode() {
  isOCRMode = true;

  ocrOverlay = document.createElement('div');
  ocrOverlay.id = 'mrky-ocr-overlay';
  ocrOverlay.className = 'mrky-ocr-overlay';
  ocrOverlay.setAttribute('role', 'dialog');
  ocrOverlay.setAttribute('aria-label', 'وضع استخراج النص من الصور');
  // The OCR hint banner has been removed per user request

  selectionBox = document.createElement('div');
  selectionBox.className = 'mrky-ocr-selection';
  ocrOverlay.appendChild(selectionBox);

  ocrOverlay.addEventListener('mousedown', handleMouseDown);
  ocrOverlay.addEventListener('mousemove', handleMouseMove);
  ocrOverlay.addEventListener('mouseup', handleMouseUp);

  document.addEventListener('keydown', handleESC);
  document.body.appendChild(ocrOverlay);
}

function exitOCRMode() {
  isOCRMode = false;
  if (ocrOverlay) {
    ocrOverlay.remove();
    ocrOverlay = null;
  }
  selectionBox = null;
  document.removeEventListener('keydown', handleESC);
}

function handleESC(e) {
  if (e.key === 'Escape') {
    exitOCRMode();
    exitImageScanMode();
  }
}

function handleMouseDown(e) {
  e.preventDefault(); // Prevent text selection on the page while drawing the OCR box
  startX = e.clientX;
  startY = e.clientY;
  selectionBox.style.left = `${startX}px`;
  selectionBox.style.top = `${startY}px`;
  selectionBox.style.width = '0px';
  selectionBox.style.height = '0px';
  selectionBox.classList.add('mrky-ocr-selecting');
}

function handleMouseMove(e) {
  if (!selectionBox || !selectionBox.classList.contains('mrky-ocr-selecting')) return;
  const left = Math.min(startX, e.clientX);
  const top = Math.min(startY, e.clientY);
  selectionBox.style.left = `${left}px`;
  selectionBox.style.top = `${top}px`;
  selectionBox.style.width = `${Math.abs(e.clientX - startX)}px`;
  selectionBox.style.height = `${Math.abs(e.clientY - startY)}px`;
}

async function handleMouseUp(e) {
  if (!selectionBox || !selectionBox.classList.contains('mrky-ocr-selecting')) return;
  selectionBox.classList.remove('mrky-ocr-selecting');

  const rect = {
    left: parseInt(selectionBox.style.left),
    top: parseInt(selectionBox.style.top),
    width: parseInt(selectionBox.style.width),
    height: parseInt(selectionBox.style.height),
  };

  if (rect.width < 20 || rect.height < 10) {
    exitOCRMode();
    return;
  }

  selectionBox.innerHTML = '<div class="mrky-ocr-loading">⏳ جاري استخراج النص...</div>';

  try {
    let croppedImage = null;

    // ── Strategy 1: Direct Canvas Crop (for PDF Reader & extension pages) ──
    // On chrome-extension:// pages, captureVisibleTab cannot work.
    // Instead, find the PDF canvas under the selection and crop directly from it.
    const pdfCanvas = document.querySelector('.pdf-page-container canvas');
    if (pdfCanvas) {
      croppedImage = cropFromCanvas(pdfCanvas, rect);
    }

    // ── Strategy 2: Screenshot crop (for normal web pages) ──
    if (!croppedImage) {
      // Temporarily hide OCR overlay and tooltip to get a clean screenshot of the page
      if (ocrOverlay) ocrOverlay.style.setProperty('display', 'none', 'important');
      const tooltip = document.getElementById('mrky-tooltip');
      let originalTooltipDisplay = '';
      if (tooltip) {
        originalTooltipDisplay = tooltip.style.display;
        tooltip.style.display = 'none';
      }

      // Force layout calculation and wait for paint to ensure overlays are hidden before screenshot
      document.body.offsetHeight;
      await new Promise(r => setTimeout(r, 60));

      const screenshot = await captureScreenshot();

      // Restore OCR overlay and tooltip visibility immediately
      if (ocrOverlay) ocrOverlay.style.removeProperty('display');
      if (tooltip) {
        tooltip.style.display = originalTooltipDisplay;
      }

      if (screenshot) {
        croppedImage = await cropImage(screenshot, rect);
      }
    }

    if (!croppedImage) throw new Error('Failed to capture image for OCR');

    const { text } = await runTesseractOCR(croppedImage);

    if (!text || text.trim().length === 0) {
      showOCRResultPanel('❌ لم يتم العثور على نص', []);
      return;
    }

    const knownWords = await getKnownWordsSet();
    const analyzed = analyzeText(text, knownWords);
    showOCRResultPanel(text, analyzed);
  } catch (error) {
    console.error('[Mrky OCR] Error:', error);
    showOCRResultPanel('⚠ حدث خطأ أثناء الاستخراج', []);
  }
}

/**
 * Show OCR result in a floating premium panel.
 */
async function showOCRResultPanel(text, analyzed) {
  exitOCRMode();

  // Remove any existing panel
  document.querySelectorAll('.mrky-ocr-result').forEach(p => p.remove());

  const panel = document.createElement('div');
  panel.className = 'mrky-ocr-panel mrky-tooltip mrky-tooltip-visible';
  panel.style.cssText = `
    position: fixed !important;
    top: 50% !important;
    left: 50% !important;
    transform: translate(-50%, -50%) !important;
    margin: 0 !important;
    z-index: 2147483647 !important;
  `;
  panel.dataset.mrkyProcessed = 'true'; // Force light-theme CSS overrides for text colors

  // Security: Build colored words safely using DOM methods to prevent XSS from OCR output
  const coloredFragment = document.createDocumentFragment();
  for (const item of analyzed) {
    if (item.pre) {
      coloredFragment.appendChild(document.createTextNode(item.pre));
    }
    const span = document.createElement('span');
    span.className = `mrky-word ${item.posInfo.class}${item.isStop ? ' mrky-stop' : ''}${item.isKnown ? ' mrky-known' : ''}`;
    span.style.color = item.posInfo.color;
    span.textContent = item.word;
    coloredFragment.appendChild(span);
    if (item.post) {
      coloredFragment.appendChild(document.createTextNode(item.post));
    }
  }

  panel.innerHTML = `
    <div class="mrky-tooltip-inner" style="min-width: 300px; max-width: 450px;">
      <div class="mrky-tooltip-header">
        <span class="mrky-tooltip-pos" style="background: var(--mrky-red, #EF4444); color: #fff;">📷 OCR</span>
        <div style="margin-left: auto; display: flex; gap: 8px; align-items: center;">
          <button class="mrky-btn-speak mrky-ocr-speak" title="انطق النص" style="margin: 0;">🔊</button>
          <button class="mrky-ocr-close" style="background:transparent; border:none; color:#9ca3af; cursor:pointer; font-size:16px; padding: 0 4px;">✕</button>
        </div>
      </div>
      <div class="mrky-tooltip-word" style="direction: ltr; text-align: left; font-size: 17px; margin-bottom: 15px; line-height: 1.5; max-height: 150px; overflow-y: auto;">
      </div>
      <div class="mrky-tooltip-translation mrky-ocr-result-translation" style="color: #4A5568; margin-bottom: 15px; font-size: 16px; font-weight: 500;">
        <span class="mrky-tooltip-loading" style="color: #718096; font-style: italic;">جاري الترجمة...</span>
      </div>
      <div class="mrky-tooltip-actions">
        <button class="mrky-btn-add" disabled>⏳ جاري الترجمة...</button>
      </div>
    </div>
  `;

  // Insert the safely-built colored words (or fallback plain text) into the word container
  const wordContainer = panel.querySelector('.mrky-tooltip-word');
  if (coloredFragment.childNodes.length > 0) {
    wordContainer.appendChild(coloredFragment);
  } else {
    wordContainer.textContent = text;
  }

  panel.querySelector('.mrky-ocr-close').addEventListener('click', () => panel.remove());

  // Handle Speech
  const speakBtn = panel.querySelector('.mrky-ocr-speak');
  if (speakBtn) {
    speakBtn.addEventListener('click', () => {
      playPronunciation(text, {
        onStart: () => speakBtn.classList.add('mrky-btn-speak-active'),
        onEnd: () => speakBtn.classList.remove('mrky-btn-speak-active'),
        onError: () => speakBtn.classList.remove('mrky-btn-speak-active'),
      });
    });
  }

  panel.querySelector('.mrky-btn-add').addEventListener('click', async () => {
    const btn = panel.querySelector('.mrky-btn-add');
    btn.disabled = true;
    btn.textContent = '⏳ جاري التحقق...';

    // ── Server-side usage gate ──
    const usageResult = await incrementUsageOnServer('word');

    if (!usageResult.allowed) {
      if (usageResult.error === 'unauthenticated') {
        btn.textContent = '🔐 سجّل دخولك أولاً';
      } else {
        btn.textContent = '🔒 وصلت الحد اليومي — ترقّ لـ Pro';
      }
      btn.classList.add('mrky-btn-locked');
      setTimeout(() => {
        btn.textContent = '+ أضف بطاقة';
        btn.disabled = false;
        btn.classList.remove('mrky-btn-locked');
      }, 3000);
      return;
    }

    btn.textContent = '⏳ جاري الحفظ...';
    const translation = panel.querySelector('.mrky-ocr-result-translation').textContent;
    await addCard({
      word: text,
      translation: translation,
      pos: 'ocr',
      sentence: text,
      contextUrl: window.location.href,
    });

    // Show remaining count for free users
    if (!usageResult.is_pro && typeof usageResult.count === 'number') {
      const remaining = 10 - usageResult.count;
      btn.textContent = `✅ تم! (${remaining} متبقية)`;
    } else {
      btn.textContent = '✅ تم!';
    }
  });

  document.body.appendChild(panel);

  // Make individual words in the panel clickable for tooltip
  panel.querySelectorAll('.mrky-word').forEach(wordEl => {
    const matchedItem = analyzed.find(a => a.word === wordEl.textContent);
    if (matchedItem && !matchedItem.isStop) {
      wordEl.style.cursor = 'pointer';
      wordEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
        showTooltip(wordEl, matchedItem.word, matchedItem.posInfo, text);
      });
    }
  });

  // Translate the full extracted text
  const result = await translateViaBackground(text);
  const transEl = panel.querySelector('.mrky-ocr-result-translation');
  const btn = panel.querySelector('.mrky-btn-add');
  if (result && result.error === 'context_invalidated') {
    if (transEl) transEl.innerHTML = '<span style="color: #FF8A8A;">🔄 يرجى تحديث الصفحة لتنشيط الإضافة بعد التحديث.</span>';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'تحديث الصفحة مطلوب';
    }
    return;
  }
  if (transEl && result?.translation && !result.translation.includes('خطأ')) {
    transEl.textContent = result.translation;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '+ أضف بطاقة';
    }
  } else if (transEl) {
    transEl.textContent = '⚠ خطأ في الترجمة';
    if (btn) btn.textContent = '⚠ فشل الترجمة';
  }
}

// ═══════════════════════════════════════════════
// MODE 2: Alt+I — Image Scan Mode (Text Overlay)
// ═══════════════════════════════════════════════

let imageHighlights = [];

function enterImageScanMode() {
  isImageScanMode = true;

  // Show hint banner
  const hint = document.createElement('div');
  hint.id = 'mrky-image-scan-hint';
  hint.className = 'mrky-image-scan-hint';
  hint.setAttribute('role', 'alert');
  hint.innerHTML = `
    <span>🔍</span>
    <span>وضع مسح الصور — انقر على أي صورة لاستخراج النص منها</span>
    <span class="mrky-ocr-hint-key">ESC أو Alt+I للإلغاء</span>
  `;
  document.body.appendChild(hint);

  // Add highlight borders to all images
  const images = document.querySelectorAll('img');
  images.forEach(img => {
    if (img.naturalWidth < 50 || img.naturalHeight < 30) return; // Skip tiny icons
    img.classList.add('mrky-image-scannable');
    img.addEventListener('click', handleImageClick);
    imageHighlights.push(img);
  });

  document.addEventListener('keydown', handleESC);
}

function exitImageScanMode() {
  isImageScanMode = false;

  const hint = document.getElementById('mrky-image-scan-hint');
  if (hint) hint.remove();

  imageHighlights.forEach(img => {
    img.classList.remove('mrky-image-scannable');
    img.removeEventListener('click', handleImageClick);
  });
  imageHighlights = [];
  document.removeEventListener('keydown', handleESC);
}

/**
 * Handle click on an image in scan mode — run OCR and overlay interactive words.
 */
async function handleImageClick(e) {
  e.preventDefault();
  e.stopPropagation();

  const img = e.currentTarget;
  exitImageScanMode();

  // Show loading state on the image
  const imgRect = img.getBoundingClientRect();
  const loadingOverlay = document.createElement('div');
  loadingOverlay.className = 'mrky-img-ocr-loading';
  loadingOverlay.style.cssText = `
    position: fixed;
    left: ${imgRect.left}px;
    top: ${imgRect.top}px;
    width: ${imgRect.width}px;
    height: ${imgRect.height}px;
    z-index: 2147483645;
  `;
  loadingOverlay.innerHTML = '<div class="mrky-img-ocr-spinner">⏳ جاري تحليل الصورة...</div>';
  document.body.appendChild(loadingOverlay);

  try {
    // Get image source for OCR
    let imageSource = img.src;

    // If the image is from another domain, capture screenshot and crop instead
    if (imageSource.startsWith('data:') || isCrossOrigin(img)) {
      // Temporarily hide loading overlay and tooltip to get a clean screenshot of the page
      if (loadingOverlay) loadingOverlay.style.setProperty('display', 'none', 'important');
      const tooltip = document.getElementById('mrky-tooltip');
      let originalTooltipDisplay = '';
      if (tooltip) {
        originalTooltipDisplay = tooltip.style.display;
        tooltip.style.display = 'none';
      }

      // Force layout calculation and wait for paint to ensure overlays are hidden before screenshot
      document.body.offsetHeight;
      await new Promise(r => setTimeout(r, 60));

      const screenshot = await captureScreenshot();

      // Restore loading overlay and tooltip visibility immediately
      if (loadingOverlay) loadingOverlay.style.removeProperty('display');
      if (tooltip) {
        tooltip.style.display = originalTooltipDisplay;
      }

      if (screenshot) {
        imageSource = await cropImage(screenshot, {
          left: imgRect.left,
          top: imgRect.top,
          width: imgRect.width,
          height: imgRect.height,
        });
      }
    }

    const { text, words: ocrWords } = await runTesseractOCR(imageSource);

    loadingOverlay.remove();

    if (!text || text.trim().length === 0) {
      showTemporaryNotice('❌ لم يتم العثور على نص في هذه الصورة');
      return;
    }

    // Create text overlay on top of the image
    await createImageTextOverlay(img, ocrWords, text);
  } catch (err) {
    console.error('[Mrky OCR] Image scan error:', err);
    loadingOverlay.remove();
    showTemporaryNotice('⚠ حدث خطأ أثناء تحليل الصورة');
  }
}

/**
 * Create an interactive text overlay on top of an image using OCR word bounding boxes.
 */
async function createImageTextOverlay(img, ocrWords, fullText) {
  // Remove any existing overlay on this image
  const existingOverlay = img.parentElement?.querySelector('.mrky-img-text-overlay');
  if (existingOverlay) existingOverlay.remove();

  // Ensure the image's parent is positioned
  const parent = img.parentElement;
  if (parent && getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }

  const knownWords = await getKnownWordsSet();

  // Create overlay container matching image dimensions
  const overlay = document.createElement('div');
  overlay.className = 'mrky-img-text-overlay';
  overlay.style.cssText = `
    position: absolute;
    left: ${img.offsetLeft}px;
    top: ${img.offsetTop}px;
    width: ${img.offsetWidth}px;
    height: ${img.offsetHeight}px;
    pointer-events: none;
    z-index: 10;
  `;

  // Calculate scale factors (OCR coordinates are relative to natural image size)
  const scaleX = img.offsetWidth / (img.naturalWidth || img.offsetWidth);
  const scaleY = img.offsetHeight / (img.naturalHeight || img.offsetHeight);

  let hideTimeout = null;

  for (const ocrWord of ocrWords) {
    const wordText = ocrWord.text?.trim();
    if (!wordText || wordText.length < 2 || !/[a-zA-Z]/.test(wordText)) continue;

    // Clean the word (remove punctuation for NLP analysis)
    const cleanWord = wordText.replace(/[^a-zA-Z'-]/g, '');
    if (!cleanWord || cleanWord.length < 2) continue;

    // Analyze this single word
    const analyzed = analyzeText(cleanWord, knownWords);
    if (!analyzed || analyzed.length === 0) continue;

    const item = analyzed[0];
    const bbox = ocrWord.bbox;

    // Create positioned word span
    const wordSpan = document.createElement('span');
    wordSpan.className = `mrky-img-word mrky-word ${item.posInfo.class}`;
    wordSpan.textContent = cleanWord;
    wordSpan.dataset.word = cleanWord;
    wordSpan.dataset.pos = item.pos;

    if (item.isStop) wordSpan.classList.add('mrky-stop');
    if (item.isKnown) wordSpan.classList.add('mrky-known');

    // Position based on OCR bounding box
    wordSpan.style.cssText = `
      position: absolute;
      left: ${bbox.x0 * scaleX}px;
      top: ${bbox.y0 * scaleY}px;
      width: ${(bbox.x1 - bbox.x0) * scaleX}px;
      height: ${(bbox.y1 - bbox.y0) * scaleY}px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: ${Math.max(10, Math.min(18, (bbox.y1 - bbox.y0) * scaleY * 0.7))}px;
      pointer-events: auto;
      cursor: pointer;
      color: transparent;
      border-radius: 3px;
      transition: all 0.15s ease;
    `;

    // Click to show tooltip (not hover — since words are on an image)
    if (!item.isStop) {
      wordSpan.addEventListener('click', (ev) => {
        ev.stopPropagation();
        clearTimeout(hideTimeout);
        document.querySelectorAll('.mrky-img-word.mrky-word-hover').forEach(s => s.classList.remove('mrky-word-hover'));
        wordSpan.classList.add('mrky-word-hover');
        showTooltip(wordSpan, cleanWord, item.posInfo, fullText);
      });

      // Hover visual feedback
      wordSpan.addEventListener('mouseenter', () => {
        wordSpan.style.color = item.posInfo.color;
        wordSpan.style.background = 'rgba(0,0,0,0.65)';
        wordSpan.style.textShadow = '0 1px 3px rgba(0,0,0,0.5)';
      });
      wordSpan.addEventListener('mouseleave', () => {
        if (!wordSpan.classList.contains('mrky-word-hover')) {
          wordSpan.style.color = 'transparent';
          wordSpan.style.background = '';
          wordSpan.style.textShadow = '';
        }
      });
    }

    overlay.appendChild(wordSpan);
  }

  // Add close button to overlay
  const closeBtn = document.createElement('button');
  closeBtn.className = 'mrky-img-overlay-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'إغلاق طبقة النص';
  closeBtn.style.pointerEvents = 'auto';
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    overlay.remove();
    hideTooltip(true);
  });
  overlay.appendChild(closeBtn);

  // Close overlay when clicking outside a word
  document.addEventListener('click', function overlayOutsideClick(ev) {
    if (!overlay.contains(ev.target) && !ev.target.closest('.mrky-tooltip')) {
      overlay.remove();
      hideTooltip(true);
      document.removeEventListener('click', overlayOutsideClick);
    }
  });

  // Insert overlay next to the image
  img.parentElement.appendChild(overlay);

  showTemporaryNotice(`✅ تم استخراج ${overlay.querySelectorAll('.mrky-img-word').length} كلمة من الصورة`);
}

// ═══════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════

function isCrossOrigin(img) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    canvas.toDataURL(); // This throws if cross-origin
    return false;
  } catch {
    return true;
  }
}

function captureScreenshot() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response?.screenshot || null);
      });
    } else {
      resolve(null);
    }
  });
}

/**
 * Crop directly from an on-screen canvas element using viewport coordinates.
 * This avoids the captureVisibleTab limitation on chrome-extension:// pages
 * and gives pixel-perfect accuracy by reading the canvas pixels directly.
 *
 * @param {HTMLCanvasElement} canvas - The rendered PDF canvas
 * @param {{left: number, top: number, width: number, height: number}} selectionRect - Viewport coordinates of the user's selection
 * @returns {string|null} Data URL of the cropped region, or null if no overlap
 */
function cropFromCanvas(canvas, selectionRect) {
  const canvasRect = canvas.getBoundingClientRect();

  // Calculate the overlap between the selection rectangle and the canvas
  const overlapLeft = Math.max(selectionRect.left, canvasRect.left);
  const overlapTop = Math.max(selectionRect.top, canvasRect.top);
  const overlapRight = Math.min(selectionRect.left + selectionRect.width, canvasRect.right);
  const overlapBottom = Math.min(selectionRect.top + selectionRect.height, canvasRect.bottom);

  const overlapWidth = overlapRight - overlapLeft;
  const overlapHeight = overlapBottom - overlapTop;

  if (overlapWidth <= 0 || overlapHeight <= 0) return null; // No overlap

  // Map viewport coords to canvas internal pixel coords
  // The canvas may be displayed at a different size than its actual pixel resolution
  const scaleX = canvas.width / canvasRect.width;
  const scaleY = canvas.height / canvasRect.height;

  const srcX = (overlapLeft - canvasRect.left) * scaleX;
  const srcY = (overlapTop - canvasRect.top) * scaleY;
  const srcW = overlapWidth * scaleX;
  const srcH = overlapHeight * scaleY;

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = srcW;
  cropCanvas.height = srcH;
  const ctx = cropCanvas.getContext('2d');
  ctx.drawImage(canvas, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

  return cropCanvas.toDataURL('image/png');
}

function cropImage(dataUrl, rect) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(
        img,
        rect.left * dpr, rect.top * dpr, rect.width * dpr, rect.height * dpr,
        0, 0, canvas.width, canvas.height
      );
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(null); // Prevent Promise leak on bad data URLs
    img.src = dataUrl;
  });
}

function showTemporaryNotice(message) {
  const notice = document.createElement('div');
  notice.className = 'mrky-ocr-notice';
  notice.textContent = message;
  document.body.appendChild(notice);
  setTimeout(() => {
    notice.classList.add('mrky-ocr-notice-hide');
    setTimeout(() => notice.remove(), 400);
  }, 2500);
}
