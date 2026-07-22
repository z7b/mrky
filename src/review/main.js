/**
 * Mrky Review Page Controller — Enhanced
 *
 * Features:
 * - Spaced repetition (SM-2) with undo support
 * - Text-to-Speech pronunciation
 * - Swipe gestures for mobile rating
 * - Streak counter for motivation
 * - Session statistics on completion
 * - Card deletion with confirmation
 * - Toast notifications for user feedback
 * - Keyboard shortcuts (Space, 1-4, Ctrl+Z)
 */
import { getDueCards, getAllCards, reviewCard, deleteCard } from '../shared/db.js';
import { playPronunciation } from '../shared/audio.js';

/* ─── State ─── */
let dueCards = [];
let initialDueCards = [];
let hardCards = [];
let currentIndex = 0;
let streak = 0;
let correctCount = 0;
let lastReview = null;        // { cardId, oldIndex } for undo
let isSpeaking = false;
let isAllMode = false;        // true when reviewing all saved cards

/* ─── Touch / Swipe State ─── */
let touchStartX = 0;
let touchStartY = 0;
let touchDeltaX = 0;
let isSwiping = false;

/* ─── DOM Cache ─── */
const $ = (id) => document.getElementById(id);

/* ─── Init ─── */
document.addEventListener('DOMContentLoaded', async () => {
  // Check if user is logged in
  const stored = await chrome.storage.local.get(['userEmail']);
  if (!stored.userEmail) {
    const cardContainer = $('review-card') || document.querySelector('.mrky-card');
    if (cardContainer) {
      cardContainer.innerHTML = `
        <div style="text-align:center;padding:40px 20px;">
          <div style="font-size:48px;margin-bottom:12px;">🔒</div>
          <h2 style="font-size:20px;font-weight:700;color:#2D3748;margin-bottom:8px;">المراجعة متاحة للمسجلين فقط</h2>
          <p style="color:#718096;font-size:14px;line-height:1.6;margin-bottom:20px;">يرجى فتح الإضافة وتسجيل الدخول بحسابك أولاً للبدء بمراجعة البطاقات.</p>
        </div>
      `;
    }
    return;
  }

  // Check if we're in "all cards" mode via query param
  const params = new URLSearchParams(window.location.search);
  isAllMode = params.get('mode') === 'all';

  try {
    dueCards = isAllMode ? await getAllCards() : await getDueCards();
    initialDueCards = [...dueCards];

    if (dueCards.length === 0) {
      showEmptyState();
      return;
    }

    updateProgress();
    showCard(currentIndex);
  } catch (error) {
    console.error('[Mrky Review] Load error:', error);
    showToast('حدث خطأ أثناء تحميل البطاقات', 'error');
  }

  bindEvents();
});

/* ═══════════════════════════════════
   Event Binding
   ═══════════════════════════════════ */
function bindEvents() {
  // Reveal answer
  $('btn-show-answer').addEventListener('click', showAnswer);
  $('flashcard').addEventListener('click', handleCardClick);

  // Rating buttons
  document.querySelectorAll('.btn-rate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const quality = parseInt(e.currentTarget.dataset.quality, 10);
      handleScore(quality);
    });
  });

  // Undo
  $('btn-undo').addEventListener('click', handleUndo);

  // TTS
  $('btn-speak').addEventListener('click', (e) => {
    e.stopPropagation();
    speakWord();
  });

  // Delete card
  $('btn-delete-card').addEventListener('click', (e) => {
    e.stopPropagation();
    handleDeleteCard();
  });

  // Close buttons
  $('btn-close-session')?.addEventListener('click', () => window.close());
  $('btn-close-empty')?.addEventListener('click', () => window.close());

  // Session completion actions
  $('btn-restart-session')?.addEventListener('click', restartSession);
  $('btn-review-hard')?.addEventListener('click', reviewHardOnly);

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);

  // Touch / Swipe (mobile rating)
  const flashcard = $('flashcard');
  flashcard.addEventListener('touchstart', handleTouchStart, { passive: true });
  flashcard.addEventListener('touchmove', handleTouchMove, { passive: false });
  flashcard.addEventListener('touchend', handleTouchEnd, { passive: true });
}

/* ═══════════════════════════════════
   Card Display
   ═══════════════════════════════════ */
function showCard(index) {
  const card = dueCards[index];
  if (!card) return;

  const flashcard = $('flashcard');

  // Reset card state
  flashcard.classList.remove('swipe-left', 'swipe-right');
  flashcard.style.transform = '';
  flashcard.style.opacity = '';
  $('card-back').classList.add('hidden');
  $('show-answer-panel').classList.remove('hidden');
  $('rating-panel').classList.add('hidden');

  // Populate
  $('card-word').textContent = card.word;
  $('card-pos').textContent = card.pos;
  $('card-translation').textContent = card.translation;
  $('card-sentence').textContent = card.sentence;

  // POS badge color
  const posColors = {
    noun: '#3B82F6', verb: '#F59E0B', adj: '#10B981',
    adv: '#8B5CF6', ocr: '#EF4444', other: '#6B7280'
  };
  const posEl = $('card-pos');
  const posColor = posColors[card.pos] || posColors.other;
  posEl.style.borderColor = posColor;
  posEl.style.color = posColor;

  // Screenshot
  if (card.screenshot) {
    $('card-screenshot').src = card.screenshot;
    $('screenshot-container').classList.remove('hidden');
  } else {
    $('screenshot-container').classList.add('hidden');
  }

  // Undo button — show only if there's a previous review
  $('btn-undo').classList.toggle('hidden', !lastReview);
}

/* ═══════════════════════════════════
   Answer & Scoring
   ═══════════════════════════════════ */
function showAnswer() {
  $('card-back').classList.remove('hidden');
  $('show-answer-panel').classList.add('hidden');
  $('rating-panel').classList.remove('hidden');
}

function handleCardClick(e) {
  // Don't flip if clicking buttons
  if (e.target.closest('.btn-icon')) return;

  const isAnswerHidden = $('card-back').classList.contains('hidden');
  if (isAnswerHidden) showAnswer();
}

async function handleScore(quality) {
  const card = dueCards[currentIndex];
  if (!card) return;

  // Save undo state
  lastReview = { cardId: card.id, cardIndex: currentIndex, quality };

  // Track hard cards (quality 0 or 3)
  if (quality < 4) {
    if (!hardCards.some(c => c.id === card.id)) {
      hardCards.push(card);
    }
  }

  // Update streak
  if (quality >= 3) {
    streak++;
    correctCount++;
  } else {
    streak = 0;
  }
  updateStreak();

  // Persist to DB
  try {
    await reviewCard(card.id, quality);
  } catch (err) {
    console.error('[Mrky Review] Score save error:', err);
    showToast('خطأ في حفظ التقييم', 'error');
  }

  // Advance
  currentIndex++;
  updateProgress();

  if (currentIndex < dueCards.length) {
    showCard(currentIndex);
  } else {
    showCompletion();
  }
}

/* ═══════════════════════════════════
   Undo
   ═══════════════════════════════════ */
async function handleUndo() {
  if (!lastReview) return;

  // Revert the SM-2 update by re-reviewing with quality 0 to reset
  // In practice, go back to the previous card index
  currentIndex = lastReview.cardIndex;

  // Revert streak
  if (lastReview.quality >= 3) {
    correctCount = Math.max(0, correctCount - 1);
  }
  streak = 0;
  updateStreak();

  lastReview = null;

  updateProgress();
  showCard(currentIndex);
  showToast('تم التراجع عن التقييم', 'success');
}

/* ═══════════════════════════════════
   Speak Word Pronunciation (Human/Neural)
   ═══════════════════════════════════ */
function speakWord() {
  const word = $('card-word').textContent;
  if (!word || isSpeaking) return;

  const btn = $('btn-speak');
  isSpeaking = true;
  btn.classList.add('speaking');

  playPronunciation(word, {
    onStart: () => {
      isSpeaking = true;
      btn.classList.add('speaking');
    },
    onEnd: () => {
      isSpeaking = false;
      btn.classList.remove('speaking');
    },
    onError: () => {
      isSpeaking = false;
      btn.classList.remove('speaking');
    }
  });
}

/* ═══════════════════════════════════
   Delete Card
   ═══════════════════════════════════ */
async function handleDeleteCard() {
  const card = dueCards[currentIndex];
  if (!card) return;

  // Simple inline confirmation
  const btn = $('btn-delete-card');
  if (!btn.dataset.confirming) {
    btn.dataset.confirming = 'true';
    btn.style.color = '#EF4444';
    showToast('اضغط مرة أخرى للتأكيد', 'error');

    setTimeout(() => {
      delete btn.dataset.confirming;
      btn.style.color = '';
    }, 3000);
    return;
  }

  // Confirmed — delete
  delete btn.dataset.confirming;
  btn.style.color = '';

  try {
    await deleteCard(card.id);
    dueCards.splice(currentIndex, 1);

    showToast('تم حذف البطاقة', 'success');

    if (dueCards.length === 0) {
      showCompletion();
    } else if (currentIndex >= dueCards.length) {
      currentIndex = dueCards.length - 1;
      showCompletion();
    } else {
      updateProgress();
      showCard(currentIndex);
    }
  } catch (err) {
    console.error('[Mrky Review] Delete error:', err);
    showToast('خطأ أثناء حذف البطاقة', 'error');
  }
}

/* ═══════════════════════════════════
   Keyboard Shortcuts
   ═══════════════════════════════════ */
function handleKeyboard(e) {
  // Ctrl+Z for undo
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    handleUndo();
    return;
  }

  const isAnswerHidden = $('card-back').classList.contains('hidden');

  if (e.code === 'Space') {
    e.preventDefault();
    if (isAnswerHidden) showAnswer();
  } else if (!isAnswerHidden) {
    if (e.key === '1') handleScore(0);
    if (e.key === '2') handleScore(3);
    if (e.key === '3') handleScore(4);
    if (e.key === '4') handleScore(5);
  }

  // S for speak
  if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    speakWord();
  }
}

/* ═══════════════════════════════════
   Touch / Swipe Gestures
   ═══════════════════════════════════ */
function handleTouchStart(e) {
  const isAnswerVisible = !$('card-back').classList.contains('hidden');
  if (!isAnswerVisible) return;

  const touch = e.touches[0];
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  touchDeltaX = 0;
  isSwiping = false;
}

function handleTouchMove(e) {
  const isAnswerVisible = !$('card-back').classList.contains('hidden');
  if (!isAnswerVisible) return;

  const touch = e.touches[0];
  const deltaX = touch.clientX - touchStartX;
  const deltaY = touch.clientY - touchStartY;

  // Only swipe horizontally
  if (!isSwiping && Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 15) {
    isSwiping = true;
  }

  if (isSwiping) {
    e.preventDefault();
    touchDeltaX = deltaX;

    const flashcard = $('flashcard');
    const rotation = deltaX * 0.04;
    flashcard.style.transform = `translateX(${deltaX}px) rotate(${rotation}deg)`;
    flashcard.style.opacity = Math.max(0.5, 1 - Math.abs(deltaX) / 300);
  }
}

function handleTouchEnd() {
  if (!isSwiping) return;
  isSwiping = false;

  const flashcard = $('flashcard');
  const threshold = 80;

  if (Math.abs(touchDeltaX) > threshold) {
    // Swipe right = easy (5), Swipe left = forgot (0)
    // In RTL, visual directions are reversed:
    if (touchDeltaX > 0) {
      handleScore(5); // Swiped right → easy
    } else {
      handleScore(0); // Swiped left → forgot
    }
  } else {
    // Snap back
    flashcard.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
    flashcard.style.transform = '';
    flashcard.style.opacity = '';
    setTimeout(() => { flashcard.style.transition = ''; }, 300);
  }
}

/* ═══════════════════════════════════
   Progress & Streak
   ═══════════════════════════════════ */
function updateProgress() {
  const bar = $('progress-bar');
  const text = $('progress-text');

  if (dueCards.length === 0) {
    bar.style.width = '100%';
    text.textContent = '0 / 0';
    return;
  }

  const pct = (currentIndex / dueCards.length) * 100;
  bar.style.width = `${pct}%`;
  text.textContent = `${currentIndex} / ${dueCards.length}`;
}

function updateStreak() {
  const badge = $('streak-badge');
  const count = $('streak-count');
  count.textContent = streak;
  badge.classList.toggle('active', streak >= 3);
}

/* ═══════════════════════════════════
   State Views
   ═══════════════════════════════════ */
function showEmptyState() {
  $('flashcard').classList.add('hidden');
  $('show-answer-panel').classList.add('hidden');
  $('rating-panel').classList.add('hidden');
  $('completion-view').classList.add('hidden');
  $('empty-view').classList.remove('hidden');
}

function showCompletion() {
  $('flashcard').classList.add('hidden');
  $('show-answer-panel').classList.add('hidden');
  $('rating-panel').classList.add('hidden');
  $('empty-view').classList.add('hidden');
  $('completion-view').classList.remove('hidden');

  // Session stats
  const totalReviewed = currentIndex;
  const accuracy = totalReviewed > 0
    ? Math.round((correctCount / totalReviewed) * 100)
    : 0;

  $('stat-reviewed').textContent = totalReviewed;
  $('stat-correct').textContent = correctCount;
  $('stat-accuracy').textContent = `${accuracy}%`;

  // Toggle "Review Hard Words" action based on session failures
  const btnReviewHard = $('btn-review-hard');
  if (btnReviewHard) {
    btnReviewHard.classList.toggle('hidden', hardCards.length === 0);
  }
}

function restartSession() {
  if (initialDueCards.length === 0) return;
  dueCards = [...initialDueCards];
  currentIndex = 0;
  correctCount = 0;
  streak = 0;
  hardCards = [];
  lastReview = null;

  $('empty-view').classList.add('hidden');
  $('completion-view').classList.add('hidden');
  $('flashcard').classList.remove('hidden');

  updateStreak();
  updateProgress();
  showCard(currentIndex);
  showToast('تم إعادة بدء الاختبار', 'success');
}

function reviewHardOnly() {
  if (hardCards.length === 0) return;
  dueCards = [...hardCards];
  // Treat hard cards as the new initial due cards for subsequent restarts
  initialDueCards = [...hardCards];
  currentIndex = 0;
  correctCount = 0;
  streak = 0;
  hardCards = [];
  lastReview = null;

  $('empty-view').classList.add('hidden');
  $('completion-view').classList.add('hidden');
  $('flashcard').classList.remove('hidden');

  updateStreak();
  updateProgress();
  showCard(currentIndex);
  showToast('بدء مراجعة الكلمات الصعبة', 'success');
}

/* ═══════════════════════════════════
   Toast Notifications
   ═══════════════════════════════════ */
function showToast(message, type = 'success') {
  const container = $('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Auto-remove after animation completes
  setTimeout(() => toast.remove(), 3000);
}
