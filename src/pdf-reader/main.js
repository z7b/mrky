/**
 * Mrky PDF Reader Controller
 * Uses PDF.js to render canvas pages with an interactive transparent HTML5 text layer.
 * Integrates directly with Mrky Content Script for hover translation and card generation.
 */

// Set worker source locally with absolute extension URL (required for MV3 CSP)
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdfjs/pdf.worker.min.js');

let pdfDoc = null;
let pageNum = 1;
let scale = 1.3;
let pageRendering = false;
let pageNumPending = null;

// DOM Elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const btnSelect = document.getElementById('btn-select-file');
const viewerContainer = document.getElementById('viewer-container');
const pdfViewer = document.getElementById('pdf-viewer');
const readerControls = document.getElementById('reader-controls');
const btnLoadNew = document.getElementById('btn-load-new');

const pageNumSpan = document.getElementById('page-num');
const pageCountSpan = document.getElementById('page-count');
const zoomTextSpan = document.getElementById('zoom-text');

// Drag and drop listeners
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') {
    loadPdfFile(file);
  } else {
    showPdfToast('يرجى سحب وإفلات ملف PDF صالح فقط.', 'error');
  }
});

// File input selection
btnSelect.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadPdfFile(file);
});

// Reset and load another file
btnLoadNew.addEventListener('click', () => {
  pdfDoc = null;
  pageNum = 1;
  pdfViewer.innerHTML = '';
  viewerContainer.classList.add('hidden');
  readerControls.classList.add('hidden');
  btnLoadNew.classList.add('hidden');
  dropZone.classList.remove('hidden');
  fileInput.value = '';
});

/**
 * Read the PDF file and initialize the document viewer.
 * @param {File} file
 */
function loadPdfFile(file) {
  const reader = new FileReader();
  reader.onload = function(e) {
    const arrayBuffer = e.target.result;
    
    pdfjsLib.getDocument({ data: arrayBuffer }).promise.then((pdf) => {
      pdfDoc = pdf;
      pageCountSpan.textContent = pdf.numPages;
      
      dropZone.classList.add('hidden');
      viewerContainer.classList.remove('hidden');
      readerControls.classList.remove('hidden');
      btnLoadNew.classList.remove('hidden');
      
      pageNum = 1;
      renderPage(pageNum);
    }).catch(err => {
      console.error('[Mrky PDF] Load error:', err);
      showPdfToast('حدث خطأ أثناء تحميل ملف الـ PDF. تأكد من أن الملف غير محمي بكلمة مرور.', 'error');
    });
  };
  reader.readAsArrayBuffer(file);
}

/**
 * Render a specific page of the loaded PDF.
 * @param {number} num - Page index (1-based)
 */
async function renderPage(num) {
  pageRendering = true;
  pdfViewer.innerHTML = ''; // Clear previous content
  
  try {
    const page = await pdfDoc.getPage(num);
    const viewport = page.getViewport({ scale });
    
    // Create container wrapper for page layer alignment
    const pageContainer = document.createElement('div');
    pageContainer.className = 'pdf-page-container';
    pageContainer.style.width = `${viewport.width}px`;
    pageContainer.style.height = `${viewport.height}px`;
    
    // Render Canvas layer
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pageContainer.appendChild(canvas);
    
    const context = canvas.getContext('2d');
    const renderContext = {
      canvasContext: context,
      viewport: viewport
    };
    
    await page.render(renderContext).promise;
    
    pdfViewer.appendChild(pageContainer);
    
    // Update controls text
    pageNumSpan.textContent = num;
    pageRendering = false;
    
    // Process pending pages if navigation is clicked rapidly
    if (pageNumPending !== null) {
      renderPage(pageNumPending);
      pageNumPending = null;
    }
  } catch (err) {
    console.error('[Mrky PDF] Render page error:', err);
    pageRendering = false;
  }
}



/**
 * Queue a render request if page-rendering is already busy.
 * @param {number} num
 */
function queueRenderPage(num) {
  if (pageRendering) {
    pageNumPending = num;
  } else {
    renderPage(num);
  }
}

// Navigation Events
document.getElementById('btn-prev').addEventListener('click', () => {
  if (pageNum <= 1) return;
  pageNum--;
  queueRenderPage(pageNum);
});

document.getElementById('btn-next').addEventListener('click', () => {
  if (!pdfDoc || pageNum >= pdfDoc.numPages) return;
  pageNum++;
  queueRenderPage(pageNum);
});

// Zoom Events
document.getElementById('btn-zoom-in').addEventListener('click', () => {
  if (scale >= 3.0) return;
  scale += 0.2;
  zoomTextSpan.textContent = `${Math.round(scale * 100)}%`;
  if (pdfDoc) renderPage(pageNum);
});

document.getElementById('btn-zoom-out').addEventListener('click', () => {
  if (scale <= 0.6) return;
  scale -= 0.2;
  zoomTextSpan.textContent = `${Math.round(scale * 100)}%`;
  if (pdfDoc) renderPage(pageNum);
});

// Trigger manual OCR selection mode inside PDF Reader page
document.getElementById('btn-pdf-ocr').addEventListener('click', () => {
  document.dispatchEvent(new CustomEvent('mrky-trigger-ocr'));
});

// --- URL Parameter Initialization & Automated Loading ---

/**
 * Render a warning layout showing the user how to drag/select their local file.
 * Required because browsers block chrome-extension:// from directly fetching file:// URLs.
 * @param {string} url - The local file URL
 */
function showLocalFileTip(url) {
  const fileName = decodeURIComponent(url.substring(url.lastIndexOf('/') + 1));
  
  // Clear any existing custom tip first
  const existingTip = dropZone.querySelector('.local-file-tip');
  if (existingTip) existingTip.remove();

  const tipDiv = document.createElement('div');
  tipDiv.className = 'local-file-tip';
  tipDiv.style.marginTop = '16px';
  tipDiv.style.width = '100%';
  
  // Security: Build HTML with a placeholder for fileName, then insert safely via textContent
  tipDiv.innerHTML = `
    <div style="background: rgba(229, 57, 53, 0.08); border: 1.5px dashed var(--mrky-red); border-radius: var(--mrky-radius-md); padding: 24px; max-width: 480px; margin: 12px auto 0; text-align: center;">
      <span style="font-size: 32px; display: block; margin-bottom: 10px;">🔒 حماية المتصفح</span>
      <h3 style="font-size: 16px; margin-bottom: 8px; color: #fff;">لم نتمكن من فتح الملف المحلي تلقائياً</h3>
      <p style="font-size: 13px; color: var(--mrky-text-secondary); line-height: 1.6; margin-bottom: 16px;">
        تمنع أنظمة أمان المتصفح الإضافات من قراءة ملفات جهازك (<strong>file://</strong>) بشكل تلقائي ومباشر.
      </p>
      <div style="background: var(--mrky-bg-inset); padding: 12px 16px; border-radius: var(--mrky-radius-sm); text-align: right; font-size: 13px; color: var(--mrky-text-secondary); margin-bottom: 18px; line-height: 1.8;">
        <strong>لفتح وقراءة الملف الآن:</strong><br>
        1. اسحب ملف <strong style="color: var(--mrky-red);" class="local-file-name"></strong> من مجلد التنزيلات وأفلته هنا.<br>
        2. أو اضغط على الزر أدناه وحدده يدوياً.
      </div>
      <button class="btn-primary btn-sm local-file-select-btn">تحديد الملف يدوياً 📂</button>
    </div>
  `;

  // Security: Insert fileName safely via textContent (prevents XSS from crafted filenames)
  const fileNameEl = tipDiv.querySelector('.local-file-name');
  if (fileNameEl) fileNameEl.textContent = fileName;

  // Security: Use addEventListener instead of inline onclick (CSP-safe)
  const selectBtn = tipDiv.querySelector('.local-file-select-btn');
  if (selectBtn) {
    selectBtn.addEventListener('click', () => document.getElementById('file-input').click());
  }
  
  // Hide standard drop zone descriptions and append our customized security tip
  const standardContent = dropZone.querySelector('.drop-zone-content');
  if (standardContent) {
    standardContent.style.display = 'none';
  }
  dropZone.appendChild(tipDiv);
}

/**
 * Fetch and load a web-based PDF file.
 * Works seamlessly because of the extension's host permissions.
 * @param {string} url - The HTTP/HTTPS web PDF URL
 */
function loadWebPdf(url) {
  dropZone.classList.add('hidden');
  viewerContainer.classList.remove('hidden');
  
  // Render loading state inside viewer
  pdfViewer.innerHTML = `
    <div style="color: var(--mrky-text-secondary); font-size: 16px; text-align: center; margin-top: 60px; display: flex; flex-direction: column; align-items: center; gap: 16px;">
      <span style="font-size: 40px; animation: pulse 1s infinite;">⏳</span>
      <span>جاري تحميل مستند الـ PDF من الإنترنت...</span>
    </div>
  `;
  
  pdfjsLib.getDocument({ url: url }).promise.then((pdf) => {
    pdfDoc = pdf;
    pageCountSpan.textContent = pdf.numPages;
    
    readerControls.classList.remove('hidden');
    btnLoadNew.classList.remove('hidden');
    
    pageNum = 1;
    renderPage(pageNum);
  }).catch(err => {
    console.error('[Mrky PDF] Load web PDF error:', err);
    pdfViewer.innerHTML = '';
    viewerContainer.classList.add('hidden');
    dropZone.classList.remove('hidden');
    showPdfToast('فشل تحميل ملف PDF من الإنترنت. تأكد من أن الرابط مباشر ويسمح بالتحميل.', 'error');
  });
}

// Check for "file" URL parameter on init
const urlParams = new URLSearchParams(window.location.search);
const fileParam = urlParams.get('file');
if (fileParam) {
  const cleanUrl = fileParam.trim();
  if (cleanUrl.toLowerCase().startsWith('file://')) {
    showLocalFileTip(cleanUrl);
  } else if (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')) {
    loadWebPdf(cleanUrl);
  } else {
    // Security: Block unsupported URL schemes (e.g. javascript:, data:)
    console.warn('[Mrky PDF] Blocked unsupported URL scheme:', cleanUrl.split(':')[0]);
  }
}

/**
 * Non-blocking toast notification (replaces blocking alert() for better UX and accessibility).
 * @param {string} message
 * @param {'error'|'success'|'info'} type
 */
function showPdfToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.setAttribute('role', 'alert');
  toast.setAttribute('aria-live', 'assertive');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: ${type === 'error' ? 'rgba(239,68,68,0.95)' : 'rgba(16,185,129,0.95)'};
    color: #fff; padding: 14px 28px; border-radius: 12px; font-size: 14px;
    font-weight: 500; z-index: 2147483647; max-width: 500px; text-align: center;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3); backdrop-filter: blur(8px);
    animation: mrkyToastIn 0.3s ease; direction: rtl;
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
