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

  function updateToggleUI(enabled) {
    if (enabled) {
      if (toggleBox) toggleBox.classList.remove('disabled');
      if (btnToggle) btnToggle.classList.remove('disabled-btn');
      if (statusDot) statusDot.textContent = '🟢';
      if (statusLabel) statusLabel.textContent = 'الإضافة تعمل على جميع المواقع';
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
  chrome.storage.local.get(['mrkyEnabled'], (res) => {
    updateToggleUI(res.mrkyEnabled !== false);
  });

  // Toggle click event
  if (btnToggle) {
    btnToggle.addEventListener('click', () => {
      chrome.storage.local.get(['mrkyEnabled'], (res) => {
        const current = res.mrkyEnabled !== false;
        const nextState = !current;
        chrome.storage.local.set({ mrkyEnabled: nextState }, () => {
          updateToggleUI(nextState);
        });
      });
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

    item.innerHTML = `
      <div class="word-meta">
        <div class="word-eng-wrapper">
          <button class="mrky-btn-speak-popup" title="استمع للكلمة" data-word="${card.word}">🔊</button>
          <span class="word-eng">${card.word}</span>
        </div>
        <span class="word-pos" style="background:${color}; color:${textColor}">${card.pos}</span>
      </div>
      <span class="word-arb">${card.translation}</span>
    `;

    container.appendChild(item);
  });
}
