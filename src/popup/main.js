/**
 * Mrky Popup Script
 * Manages stats rendering, showing the recent word list, and actions (Local Player & Review).
 */
import { getAllCards, getDueCards, getKnownWordCount } from '../shared/db.js';
import { playPronunciation } from '../shared/audio.js';
import { verifyLicenseKey, loginWithGoogle, openStripeCheckout, openMonthlyCheckout, openAnnualCheckout, checkUserProfileByEmail, fetchDailyUsageFromServer } from '../shared/supabase.js';
import { checkFirebaseProStatus, loginWithGoogleFirebase, signInWithFirebaseEmailPassword, signUpWithFirebaseEmailPassword, sendPasswordResetEmail, resendVerificationEmail } from '../shared/firebase.js';
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
      if (!tab || !tab.id) return;

      // Skip restricted browser URLs
      if (tab.url && (
        tab.url.startsWith('chrome://') || 
        tab.url.startsWith('edge://') || 
        tab.url.startsWith('about:') || 
        tab.url.startsWith('chrome-extension://') ||
        tab.url.startsWith('https://chrome.google.com/') ||
        tab.url.startsWith('https://chromewebstore.google.com/')
      )) {
        console.warn('[PANDA Popup] Cannot run OCR on browser restricted page:', tab.url);
        return;
      }

      const originalHTML = btnTriggerOcr.innerHTML;
      btnTriggerOcr.disabled = true;
      btnTriggerOcr.innerHTML = '<span>جاري التفعيل...</span>';

      const sendMessageAndClose = () => {
        chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_OCR_SELECTION' }, () => {
          if (chrome.runtime.lastError) {
            console.error('[PANDA Popup] Send message error:', chrome.runtime.lastError.message);
          }
          window.close();
        });
      };

      chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_OCR_SELECTION' }, async (response) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message || '';
          if (errMsg.includes('Receiving end does not exist') || errMsg.includes('connection')) {
            console.log('[PANDA Popup] Content script not detected. Injecting dynamically...');
            try {
              // Inject CSS
              await chrome.scripting.insertCSS({
                target: { tabId: tab.id },
                files: ['content.css']
              });
              // Inject JS
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
              });
              // Brief delay for init, then trigger
              setTimeout(sendMessageAndClose, 150);
            } catch (err) {
              console.error('[PANDA Popup] Failed to inject content script dynamically:', err);
              btnTriggerOcr.disabled = false;
              btnTriggerOcr.innerHTML = originalHTML;
            }
          } else {
            console.error('[PANDA Popup] Unknown send message error:', errMsg);
            btnTriggerOcr.disabled = false;
            btnTriggerOcr.innerHTML = originalHTML;
          }
        } else {
          window.close();
        }
      });
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

  // Validate domain format and block broad public suffixes / TLDs
  function isValidDomain(domain) {
    const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,20}$/i;
    if (!domainRegex.test(domain)) return false;

    const parts = domain.split('.');
    
    // List of common TLDs and two-level public suffixes to block
    const blockedSuffixes = new Set([
      'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'biz', 'info', 'name', 'pro', 'co', 'io', 'me', 'tv', 'cc',
      'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'com.br', 'net.br',
      'co.jp', 'org.jp', 'ne.jp', 'com.sg', 'com.tr', 'co.za', 'co.in', 'net.in', 'org.in'
    ]);

    if (blockedSuffixes.has(domain)) return false;

    if (parts.length >= 2) {
      const lastTwo = parts.slice(-2).join('.');
      if (blockedSuffixes.has(lastTwo) && parts.length < 3) {
        return false; // e.g. blocks "co.uk" as a domain name, requires "example.co.uk"
      }
    }

    return true;
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

    if (!isValidDomain(domain)) {
      inputCustomSite.style.borderColor = '#FF6B6B';
      inputCustomSite.focus();
      return;
    }
    inputCustomSite.style.borderColor = '';

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
    inputCustomSite.addEventListener('input', () => {
      inputCustomSite.style.borderColor = '';
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

  // ─── Mrky Pro Subscription & License Management ───
  const proAccordionBar = document.getElementById('pro-accordion-bar');
  const proCardContent = document.getElementById('pro-card-content');
  const proStatusDesc = document.getElementById('pro-status-desc');
  const proCard = document.getElementById('pro-card');
  const proStatusTitle = document.getElementById('pro-status-title');
  const proStatusTag = document.getElementById('pro-status-tag');
  const proInputGroup = document.getElementById('pro-input-group');
  const proUpgradeActions = document.getElementById('pro-upgrade-actions');
  const proFirebaseLoginArea = document.getElementById('pro-firebase-login-area');
  const fbLoginEmail = document.getElementById('fb-login-email');
  const fbLoginPassword = document.getElementById('fb-login-password');
  const btnFbLogin = document.getElementById('btn-fb-login');
  const btnFbSignup = document.getElementById('btn-fb-signup');
  const proUserDashboard = document.getElementById('pro-user-dashboard');
  const loggedUserEmail = document.getElementById('logged-user-email');
  const loggedUserPlanBadge = document.getElementById('logged-user-plan-badge');
  const planStatusText = document.getElementById('plan-status-text');
  const btnLogout = document.getElementById('btn-logout');
  const proMessage = document.getElementById('pro-message');
  const btnActivate = document.getElementById('btn-activate-license');
  const licenseInput = document.getElementById('license-key-input');
  const proPaymentSection = document.getElementById('pro-payment-section');
  const btnForgotPassword = document.getElementById('btn-forgot-password');

  proAccordionBar?.addEventListener('click', () => {
    if (!proCardContent) return;
    const isHidden = proCardContent.classList.contains('hidden');
    if (isHidden) {
      proCardContent.classList.remove('hidden');
      proAccordionBar.classList.add('expanded');
    } else {
      proCardContent.classList.add('hidden');
      proAccordionBar.classList.remove('expanded');
    }
  });

  function renderPlanStatusDashboard(isPro, planName) {
    if (!planStatusText) return;
    if (isPro) {
      const planLabel = planName === 'annual' ? 'السنوي' : 'الشهري';
      planStatusText.innerHTML = `
        <div class="plan-dashboard-box pro">
          <div class="plan-dashboard-title">
            <span>🎉 اشتراك PANDA Pro (${planLabel}) مفعّل</span>
          </div>
          <p class="plan-dashboard-sub">جميع ميزات الحفظ والتعليل النحوي والمزامنة السحابية مفتوحة لحسابك بلا حدود ✨</p>
        </div>
      `;
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    chrome.storage.local.get(['dailyWordCount', 'dailyExplainCount', 'dailyUsageDate'], (usageData) => {
      const isToday = usageData.dailyUsageDate === todayStr;
      const wordUsed = isToday ? (usageData.dailyWordCount || 0) : 0;
      const explainUsed = isToday ? (usageData.dailyExplainCount || 0) : 0;
      const wordRem = Math.max(0, 10 - wordUsed);
      const explainRem = Math.max(0, 10 - explainUsed);
      const wordPct = Math.min(100, (wordUsed / 10) * 100);
      const explainPct = Math.min(100, (explainUsed / 10) * 100);

      planStatusText.innerHTML = `
        <div class="plan-dashboard-box free">
          <div class="plan-dashboard-title">
            <span>📊 الاستهلاك اليومي للباقة المجانية (10 / يومياً):</span>
          </div>

          <div class="usage-meter-row">
            <div class="usage-meter-head">
              <span class="usage-meter-label">🔖 حفظ البطاقات للمراجعة</span>
              <span class="usage-meter-rem ${wordRem === 0 ? 'empty' : ''}">${wordRem} / 10 متبقي</span>
            </div>
            <div class="usage-meter-track">
              <div class="usage-meter-bar ${wordRem === 0 ? 'full' : ''}" style="width: ${wordPct}%;"></div>
            </div>
          </div>

          <div class="usage-meter-row">
            <div class="usage-meter-head">
              <span class="usage-meter-label">🧠 التعليل النحوي الذكي (AI)</span>
              <span class="usage-meter-rem ${explainRem === 0 ? 'empty' : ''}">${explainRem} / 10 متبقي</span>
            </div>
            <div class="usage-meter-track">
              <div class="usage-meter-bar ${explainRem === 0 ? 'full' : ''}" style="width: ${explainPct}%;"></div>
            </div>
          </div>

          <div class="free-upgrade-hint">
            <span class="free-upgrade-icon">⚡</span>
            <span>اختر اشتراك شهر أو سنة أدناه للترقية وفتح الحفظ والتعليل <b>بلا حدود</b>!</span>
          </div>
        </div>
      `;
    });
  }

  function updateProUI(isPremium, emailOrKey = '', plan = 'free') {
    const isEmailLogged = emailOrKey && String(emailOrKey).includes('@');
    const dividerEl = document.querySelector('.pro-license-divider');

    if (proAccordionBar) {
      if (isPremium) {
        proAccordionBar.classList.add('pro-active');
      } else {
        proAccordionBar.classList.remove('pro-active');
      }
    }

    if (isEmailLogged) {
      if (proFirebaseLoginArea) proFirebaseLoginArea.style.display = 'none';
      if (proUserDashboard) proUserDashboard.classList.remove('hidden');
      if (loggedUserEmail) loggedUserEmail.textContent = String(emailOrKey).toUpperCase();

      if (isPremium) {
        proCard?.classList.add('pro-active');
        if (proStatusTitle) proStatusTitle.textContent = '⭐ اشتراك PANDA Pro مفعّل 🐼';
        if (proStatusTag) proStatusTag.textContent = 'Pro مفعّل ⭐';
        if (proStatusDesc) proStatusDesc.textContent = 'حساب متصل ومفعل باحترافية ✨';
        if (loggedUserPlanBadge) {
          const planText = plan === 'annual' ? 'سنة' : 'شهر';
          loggedUserPlanBadge.textContent = `باقة PANDA Pro (${planText}) ⭐`;
          loggedUserPlanBadge.classList.add('pro-badge');
        }
        renderPlanStatusDashboard(true, plan);
        if (proPaymentSection) proPaymentSection.classList.add('hidden');
      } else {
        proCard?.classList.remove('pro-active');
        if (proStatusTitle) proStatusTitle.textContent = 'اشتراك PANDA Pro 🐼';
        if (proStatusTag) proStatusTag.textContent = 'نسخة مجانية 🆓';
        if (proStatusDesc) proStatusDesc.textContent = 'مسجل بحساب مجاني (اضغط للترقية)';
        if (loggedUserPlanBadge) {
          loggedUserPlanBadge.textContent = 'باقة مجانية 🆓';
          loggedUserPlanBadge.classList.remove('pro-badge');
        }
        renderPlanStatusDashboard(false, 'free');
        if (proPaymentSection) proPaymentSection.classList.remove('hidden');
      }
    } else if (isPremium) {
      proCard?.classList.add('pro-active');
      if (proStatusTitle) proStatusTitle.textContent = '⭐ اشتراك PANDA Pro مفعّل 🐼';
      if (proStatusTag) proStatusTag.textContent = 'Pro مفعّل ⭐';
      if (proStatusDesc) proStatusDesc.textContent = 'الاشتراك مفعّل بالكامل';
      if (proFirebaseLoginArea) proFirebaseLoginArea.style.display = 'none';
      if (proUserDashboard) proUserDashboard.classList.add('hidden');
      if (proPaymentSection) proPaymentSection.classList.add('hidden');
    } else {
      proCard?.classList.remove('pro-active');
      if (proStatusTitle) proStatusTitle.textContent = 'اشتراك PANDA Pro 🐼';
      if (proStatusTag) proStatusTag.textContent = 'نسخة مجانية';
      if (proStatusDesc) proStatusDesc.textContent = 'سجّل دخولك أولاً لعرض الاشتراكات';
      if (proFirebaseLoginArea) proFirebaseLoginArea.style.display = 'flex';
      if (proUserDashboard) proUserDashboard.classList.add('hidden');
      if (proPaymentSection) proPaymentSection.classList.add('hidden');
    }
  }

  btnLogout?.addEventListener('click', () => {
    // Clear all subscription verification alarms in the service worker
    chrome.runtime.sendMessage({ type: 'CLEAR_SUBSCRIPTION_ALARMS' }).catch(() => {});

    chrome.storage.local.remove([
      'isPremium', 'userEmail', 'plan', 'licenseKey',
      'firebaseToken', 'firebaseRefreshToken', 'firebaseTokenExpiry',
      'dailyWordCount', 'dailyExplainCount', 'dailyUsageDate', 'dailyUsageIsPro'
    ], () => {
      if (fbLoginEmail) fbLoginEmail.value = '';
      if (fbLoginPassword) fbLoginPassword.value = '';
      updateProUI(false, '', 'free');
      proMessage.textContent = 'تم تسجيل الخروج بنجاح 🚪';
      proMessage.className = 'pro-message success';
    });
  });

  chrome.storage.local.get(['isPremium', 'userEmail', 'licenseKey', 'plan'], async (res) => {
    if (fbLoginEmail && res.userEmail) {
      fbLoginEmail.value = res.userEmail;
    }
    // 1. Show cached UI immediately for fast loading
    updateProUI(Boolean(res.isPremium), res.userEmail || res.licenseKey, res.plan || 'free');

    // 2. Silently verify with server in the background if email exists
    if (res.userEmail) {
      try {
        let serverProfile = await checkUserProfileByEmail(res.userEmail);
        
        // Retry once if server returned a fallback (Edge Function may have cold-started/EarlyDrop)
        if (serverProfile && !serverProfile.isPro && res.isPremium) {
          await new Promise(r => setTimeout(r, 1500));
          serverProfile = await checkUserProfileByEmail(res.userEmail);
        }
        
        if (serverProfile) {
          const isPro = serverProfile.isPro;
          const plan = serverProfile.plan || 'free';
          
          // If server status is different from local cache, update local cache and UI
          if (isPro !== res.isPremium || plan !== res.plan) {
            await chrome.storage.local.set({ isPremium: isPro, plan: plan });
            updateProUI(Boolean(isPro), res.userEmail, plan);
          }
        }
      } catch (err) {
        console.error('Silent verification failed, keeping cached status:', err);
        // On network failure, keep the cached status instead of downgrading
      }

      // 3. Fetch real-time quota from server (non-blocking, updates dashboard reactively)
      fetchDailyUsageFromServer().catch(() => {});
    }
  });

  // ── Reactive Dashboard: auto-update progress bars when storage changes ──
  // This fires when: (a) fetchDailyUsageFromServer writes new counts,
  // (b) incrementUsageOnServer updates after a word-save or explain action,
  // (c) any other tab/content-script writes usage data.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const usageKeys = ['dailyWordCount', 'dailyExplainCount', 'dailyUsageDate', 'dailyUsageIsPro'];
    const hasUsageChange = usageKeys.some(k => k in changes);
    if (!hasUsageChange) return;

    // Re-render the dashboard with fresh data from storage
    chrome.storage.local.get(['isPremium', 'plan'], (current) => {
      renderPlanStatusDashboard(Boolean(current.isPremium), current.plan || 'free');
    });
  });

  btnFbLogin?.addEventListener('click', async () => {
    const email = (fbLoginEmail?.value || '').trim();
    const password = (fbLoginPassword?.value || '').trim();

    if (!email) {
      proMessage.textContent = 'الرجاء إدخال البريد الإلكتروني';
      proMessage.className = 'pro-message error';
      return;
    }

    btnFbLogin.disabled = true;
    btnFbLogin.textContent = 'جاري التحقق...';
    proMessage.className = 'pro-message hidden';

    const res = await signInWithFirebaseEmailPassword(email, password);
    btnFbLogin.disabled = false;
    btnFbLogin.textContent = 'دخول 🔥';

    if (res.needsVerification) {
      // ── Email not verified — show resend option ──
      proMessage.innerHTML = `⚠️ بريدك <strong>${res.email}</strong> غير موثق. تفقد بريدك واضغط رابط التحقق ثم سجل دخول مرة أخرى.<br><button id="btn-resend-verify" style="margin-top:8px;padding:6px 16px;border:none;border-radius:6px;background:#6C5CE7;color:#fff;cursor:pointer;font-size:13px;">📧 إعادة إرسال رسالة التحقق</button>`;
      proMessage.className = 'pro-message error';
      // Attach resend handler
      document.getElementById('btn-resend-verify')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'جاري الإرسال...';
        const resendRes = await resendVerificationEmail();
        if (resendRes.success) {
          e.target.textContent = '✅ تم الإرسال! تفقد بريدك';
        } else {
          e.target.textContent = resendRes.error || 'فشل الإرسال';
          e.target.disabled = false;
        }
      });
    } else if (res.success && res.isPro) {
      updateProUI(true, email, res.plan || 'pro');
      proMessage.textContent = `🎉 مرحباً! تم تسجيل الدخول وتفعيل اشتراك PANDA Pro بنجاح!`;
      proMessage.className = 'pro-message success';
    } else if (res.success && !res.isPro) {
      await chrome.storage.local.set({ isPremium: false, userEmail: email, plan: 'free' });
      updateProUI(false, email, 'free');
      proMessage.textContent = 'حسابك مسجل بالباقة المجانية. اختر اشتراك شهر أو سنة للترقية!';
      proMessage.className = 'pro-message error';
    } else {
      proMessage.textContent = res.error || 'فشل تسجيل الدخول';
      proMessage.className = 'pro-message error';
    }
  });

  btnFbSignup?.addEventListener('click', async () => {
    const email = (fbLoginEmail?.value || '').trim();
    const password = (fbLoginPassword?.value || '').trim();

    if (!email) {
      proMessage.textContent = 'الرجاء إدخال البريد الإلكتروني لإنشاء حساب';
      proMessage.className = 'pro-message error';
      return;
    }
    if (!password || password.length < 6) {
      proMessage.textContent = 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
      proMessage.className = 'pro-message error';
      return;
    }

    btnFbSignup.disabled = true;
    btnFbSignup.textContent = 'جاري الإنشاء...';
    proMessage.className = 'pro-message hidden';

    const res = await signUpWithFirebaseEmailPassword(email, password);
    btnFbSignup.disabled = false;
    btnFbSignup.textContent = 'حساب جديد ➕';

    if (res.success && res.needsVerification) {
      proMessage.innerHTML = `🎉 تم إنشاء حسابك! تم إرسال رسالة تحقق إلى <strong>${email}</strong>.<br>افتح بريدك واضغط رابط التحقق، ثم سجل دخول 🔐`;
      proMessage.className = 'pro-message success';
    } else if (res.success) {
      updateProUI(false, email);
      proMessage.textContent = `🎉 تم إنشاء حسابك بنجاح!`;
      proMessage.className = 'pro-message success';
    } else {
      proMessage.textContent = res.error || 'تعذر إنشاء الحساب';
      proMessage.className = 'pro-message error';
    }
  });

  btnForgotPassword?.addEventListener('click', async () => {
    const email = (fbLoginEmail?.value || '').trim();
    if (!email) {
      proMessage.textContent = 'اكتب بريدك الإلكتروني أولاً ثم اضغط "نسيت كلمة المرور"';
      proMessage.className = 'pro-message error';
      return;
    }
    btnForgotPassword.disabled = true;
    btnForgotPassword.textContent = 'جاري الإرسال...';
    const res = await sendPasswordResetEmail(email);
    btnForgotPassword.disabled = false;
    btnForgotPassword.textContent = 'نسيت كلمة المرور؟';
    if (res.success) {
      proMessage.textContent = `📧 تم إرسال رابط استعادة كلمة المرور إلى ${email}. تفقّد بريدك!`;
      proMessage.className = 'pro-message success';
    } else {
      proMessage.textContent = res.error;
      proMessage.className = 'pro-message error';
    }
  });

  document.getElementById('btn-monthly-upgrade')?.addEventListener('click', () => {
    chrome.storage.local.get(['userEmail'], (res) => {
      openMonthlyCheckout(res.userEmail || fbLoginEmail?.value || '');
    });
  });

  document.getElementById('btn-annual-upgrade')?.addEventListener('click', () => {
    chrome.storage.local.get(['userEmail'], (res) => {
      openAnnualCheckout(res.userEmail || fbLoginEmail?.value || '');
    });
  });

  document.getElementById('btn-stripe-upgrade')?.addEventListener('click', () => {
    chrome.storage.local.get(['userEmail'], (res) => {
      openAnnualCheckout(res.userEmail || fbLoginEmail?.value || '');
    });
  });

  btnActivate?.addEventListener('click', async () => {
    const key = (licenseInput?.value || '').trim();
    if (!key) return;

    btnActivate.disabled = true;
    btnActivate.textContent = 'جاري التحقق...';
    proMessage.className = 'pro-message hidden';

    const result = await verifyLicenseKey(key);
    btnActivate.disabled = false;
    btnActivate.textContent = 'تفعيل 🚀';

    if (result.valid) {
      updateProUI(true, key);
      proMessage.textContent = '🎉 تم تفعيل اشتراك Pro بنجاح!';
      proMessage.className = 'pro-message success';
    } else {
      proMessage.textContent = result.error || 'مفتاح الترخيص غير صحيح';
      proMessage.className = 'pro-message error';
    }
  });
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
