/**
 * Mrky Popup Script
 * Manages stats rendering, showing the recent word list, and actions (Local Player & Review).
 */
import { getAllCards, getDueCards, getKnownWordCount } from '../shared/db.js';
import { playPronunciation } from '../shared/audio.js';
document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const statCardsEl = document.getElementById('stat-cards-count');
  const statKnownEl = document.getElementById('stat-known-count');
  const dueCountEl = document.getElementById('due-count');
  const btnStartReview = document.getElementById('btn-start-review');
  const btnReviewAll = document.getElementById('btn-review-all');
  const btnOpenPlayer = document.getElementById('btn-open-player');
  const btnOpenPdf = document.getElementById('btn-open-pdf');
  const wordsListEl = document.getElementById('words-list');

  // Load Database Stats
  try {
    const allCards = await getAllCards();
    const dueCards = await getDueCards();
    const knownCount = await getKnownWordCount();

    // Set stats text
    statCardsEl.textContent = allCards.length;
    statKnownEl.textContent = knownCount;
    dueCountEl.textContent = dueCards.length;

    // Enable/Disable review button
    if (dueCards.length > 0) {
      btnStartReview.disabled = false;
      btnStartReview.textContent = 'ابدأ المراجعة';
    } else {
      btnStartReview.disabled = true;
      btnStartReview.textContent = 'مكتمل اليوم!';
    }

    // Enable/Disable review all button based on word existence
    if (allCards.length > 0) {
      btnReviewAll.disabled = false;
    } else {
      btnReviewAll.disabled = true;
    }

    // Render Recent Words
    renderRecentWords(allCards.slice(-5).reverse());

  } catch (error) {
    console.error('[Mrky Popup] Database error:', error);
  }

  // Audio Playback Event Delegation
  wordsListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.mrky-btn-speak-popup');
    if (btn) {
      const word = btn.dataset.word;
      if (word) {
        btn.classList.add('playing');
        playPronunciation(word, {
          onEnd: () => btn.classList.remove('playing'),
          onError: () => btn.classList.remove('playing'),
        });
      }
    }
  });

  // Start Review Session button (due cards only)
  btnStartReview.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('review/index.html') });
  });

  // Start Review Session button (all cards)
  btnReviewAll.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('review/index.html?mode=all') });
  });

  // Open Local Player button
  btnOpenPlayer.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('player/index.html') });
  });

  // Open PDF Reader button
  btnOpenPdf.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pdf-reader/index.html') });
  });

  // ─── Extension ON/OFF Toggle Logic ───
  const btnToggle = document.getElementById('btn-toggle-enable');
  const toggleBox = document.querySelector('.toggle-control-box');
  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');
  const toggleIcon = document.getElementById('btn-toggle-icon');
  const toggleText = document.getElementById('btn-toggle-text');
  
  // OCR elements
  const btnTriggerOcr = document.getElementById('btn-trigger-ocr');
  const ocrCard = document.querySelector('.ocr-control-card');
  
  if (btnTriggerOcr) {
    btnTriggerOcr.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_OCR_SELECTION' }, () => {
          // Ignore chrome.runtime.lastError in case content script is not loaded
          if (chrome.runtime.lastError) {}
        });
        window.close(); // Close popup so they can draw on screen
      }
    });
  }

  // Status label text based on site mode
  const statusMessages = {
    all: 'الإضافة تعمل على جميع المواقع',
    custom: 'الإضافة تعمل على مواقع محددة',
    english: 'الإضافة تعمل على المواقع الإنجليزية',
  };

  function updateToggleUI(enabled, siteMode) {
    const modeText = statusMessages[siteMode] || statusMessages.all;
    if (enabled) {
      if (toggleBox) toggleBox.classList.remove('disabled');
      if (btnToggle) btnToggle.classList.remove('disabled-btn');
      if (statusDot) statusDot.textContent = '🟢';
      if (statusLabel) statusLabel.textContent = modeText;
      if (toggleIcon) toggleIcon.textContent = '⚡';
      if (toggleText) toggleText.textContent = 'مفعل';
      if (btnTriggerOcr) btnTriggerOcr.disabled = false;
      if (ocrCard) ocrCard.classList.remove('disabled');
    } else {
      if (toggleBox) toggleBox.classList.add('disabled');
      if (btnToggle) btnToggle.classList.add('disabled-btn');
      if (statusDot) statusDot.textContent = '🔴';
      if (statusLabel) statusLabel.textContent = 'الإضافة متوقفة مؤقتاً';
      if (toggleIcon) toggleIcon.textContent = '⏸️';
      if (toggleText) toggleText.textContent = 'متوقف';
      if (btnTriggerOcr) btnTriggerOcr.disabled = true;
      if (ocrCard) ocrCard.classList.add('disabled');
    }
  }

  // Load initial toggle state
  chrome.storage.local.get(['mrkyEnabled', 'mrkySiteMode'], (res) => {
    const mode = res.mrkySiteMode || 'all';
    updateToggleUI(res.mrkyEnabled !== false, mode);
  });

  // Toggle click event
  if (btnToggle) {
    btnToggle.addEventListener('click', () => {
      chrome.storage.local.get(['mrkyEnabled', 'mrkySiteMode'], (res) => {
        const current = res.mrkyEnabled !== false;
        const nextState = !current;
        const mode = res.mrkySiteMode || 'all';
        chrome.storage.local.set({ mrkyEnabled: nextState }, () => {
          updateToggleUI(nextState, mode);
        });
      });
    });
  }

  // ─── Settings Panel Logic ───
  const btnOpenSettings = document.getElementById('btn-open-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const settingsPanel = document.getElementById('settings-panel');
  const customSitesArea = document.getElementById('custom-sites-area');
  const englishNote = document.getElementById('english-note');
  const inputCustomSite = document.getElementById('input-custom-site');
  const btnAddSite = document.getElementById('btn-add-site');
  const customSitesList = document.getElementById('custom-sites-list');
  const modeRadios = document.querySelectorAll('input[name="siteMode"]');

  // Open/Close settings
  if (btnOpenSettings) {
    btnOpenSettings.addEventListener('click', () => {
      const isOpen = settingsPanel.style.display !== 'none';
      settingsPanel.style.display = isOpen ? 'none' : 'block';
      btnOpenSettings.classList.toggle('active', !isOpen);
    });
  }

  if (btnCloseSettings) {
    btnCloseSettings.addEventListener('click', () => {
      settingsPanel.style.display = 'none';
      if (btnOpenSettings) btnOpenSettings.classList.remove('active');
    });
  }

  // Load saved settings
  chrome.storage.local.get(['mrkySiteMode', 'mrkyCustomSites'], (res) => {
    const mode = res.mrkySiteMode || 'all';
    const sites = res.mrkyCustomSites || [];

    // Set selected radio
    const radio = document.querySelector(`input[name="siteMode"][value="${mode}"]`);
    if (radio) radio.checked = true;

    // Show/hide conditional areas
    updateSettingsUI(mode);
    renderCustomSites(sites);
  });

  // Mode change handler
  modeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      const mode = e.target.value;
      chrome.storage.local.set({ mrkySiteMode: mode }, () => {
        updateSettingsUI(mode);
        // Update status label
        chrome.storage.local.get(['mrkyEnabled'], (res) => {
          updateToggleUI(res.mrkyEnabled !== false, mode);
        });
      });
    });
  });

  function updateSettingsUI(mode) {
    if (customSitesArea) customSitesArea.style.display = mode === 'custom' ? 'block' : 'none';
    if (englishNote) englishNote.style.display = mode === 'english' ? 'flex' : 'none';
  }

  // Add custom site
  function addCustomSite() {
    const raw = inputCustomSite.value.trim();
    if (!raw) return;

    // Normalize: extract hostname from URL or plain domain
    let domain = raw;
    try {
      if (raw.includes('://')) {
        domain = new URL(raw).hostname;
      } else if (raw.includes('/')) {
        domain = new URL('https://' + raw).hostname;
      }
    } catch {
      // Use as-is
    }
    domain = domain.replace(/^www\./, '').toLowerCase();

    if (!domain) return;

    chrome.storage.local.get(['mrkyCustomSites'], (res) => {
      const sites = res.mrkyCustomSites || [];
      if (sites.includes(domain)) {
        inputCustomSite.value = '';
        return; // Already exists
      }
      sites.push(domain);
      chrome.storage.local.set({ mrkyCustomSites: sites }, () => {
        inputCustomSite.value = '';
        renderCustomSites(sites);
      });
    });
  }

  if (btnAddSite) btnAddSite.addEventListener('click', addCustomSite);
  if (inputCustomSite) {
    inputCustomSite.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addCustomSite();
    });
  }

  // Render custom sites list
  function renderCustomSites(sites) {
    if (!customSitesList) return;
    customSitesList.innerHTML = '';

    if (sites.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'custom-sites-empty';
      empty.textContent = 'لم تضف أي مواقع بعد';
      customSitesList.appendChild(empty);
      return;
    }

    sites.forEach((site) => {
      const item = document.createElement('div');
      item.className = 'site-item';

      const domainSpan = document.createElement('span');
      domainSpan.className = 'site-item-domain';
      domainSpan.textContent = site;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-remove-site';
      removeBtn.textContent = '✕';
      removeBtn.title = 'حذف';
      removeBtn.addEventListener('click', () => {
        chrome.storage.local.get(['mrkyCustomSites'], (res) => {
          const updated = (res.mrkyCustomSites || []).filter(s => s !== site);
          chrome.storage.local.set({ mrkyCustomSites: updated }, () => {
            renderCustomSites(updated);
          });
        });
      });

      item.appendChild(domainSpan);
      item.appendChild(removeBtn);
      customSitesList.appendChild(item);
    });
  }
});

/**
 * Render list of recently added words.
 * @param {Array} cards
 */
function renderRecentWords(cards) {
  const container = document.getElementById('words-list');
  if (cards.length === 0) return; // Keep empty state

  container.innerHTML = '';

  // Part of speech tags configuration (matching premium dark theme)
  const posColors = {
    noun: '#3B82F6',
    verb: '#F59E0B',
    adj: '#10B981',
    adv: '#8B5CF6',
    other: '#6B7280',
    ocr: '#EF4444',
  };

  cards.forEach(card => {
    const item = document.createElement('div');
    item.className = 'word-item';

    const color = posColors[card.pos] || posColors.other;
    const textColor = card.pos === 'verb' ? '#0F0F1A' : '#fff';

    // Security: Build DOM safely to prevent XSS from user-stored data
    const wordMeta = document.createElement('div');
    wordMeta.className = 'word-meta';

    const wordEngWrapper = document.createElement('div');
    wordEngWrapper.className = 'word-eng-wrapper';

    const speakBtn = document.createElement('button');
    speakBtn.className = 'mrky-btn-speak-popup';
    speakBtn.title = 'استمع للكلمة';
    speakBtn.setAttribute('data-word', card.word);
    speakBtn.textContent = '🔊';

    const wordEng = document.createElement('span');
    wordEng.className = 'word-eng';
    wordEng.textContent = card.word;

    wordEngWrapper.appendChild(speakBtn);
    wordEngWrapper.appendChild(wordEng);

    const wordPos = document.createElement('span');
    wordPos.className = 'word-pos';
    wordPos.style.background = color;
    wordPos.style.color = textColor;
    wordPos.textContent = card.pos;

    wordMeta.appendChild(wordEngWrapper);
    wordMeta.appendChild(wordPos);

    const wordArb = document.createElement('span');
    wordArb.className = 'word-arb';
    wordArb.textContent = card.translation;

    item.appendChild(wordMeta);
    item.appendChild(wordArb);

    container.appendChild(item);
  });
}
