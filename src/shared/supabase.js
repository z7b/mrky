/**
 * Mrky Supabase Integration & Subscription Manager
 * Supabase integration: Firebase Auth bridge, usage limits (Edge Functions),
 * Lemon Squeezy checkout, license verification.
 */

import { getValidFirebaseToken } from './firebase.js';

export const SUPABASE_URL = 'https://xkkgvupfjlzrtzcfaqpu.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_5utBLgjzmBQsBVeZx0cM-w_EQdVajpN';

// Lemon Squeezy Checkout Links for PANDA🐼
export const LEMON_SQUEEZY_ANNUAL_URL = 'https://enpanda.lemonsqueezy.com/checkout/buy/66004302-aa92-4358-9ff5-354e758517fc';
export const LEMON_SQUEEZY_MONTHLY_URL = 'https://enpanda.lemonsqueezy.com/checkout/buy/96bb46f7-7a33-4991-a728-de063801ad6d';

/**
 * Check daily usage limits via the secure Edge Function gateway.
 *
 * Architecture: Extension → Firebase ID Token → Edge Function (verifies token server-side)
 * → extracts email → calls increment_usage(p_email, p_type) with service_role → returns result
 *
 * Fail-open/fail-closed logic:
 *   - True network failures (DNS, offline, timeout) → catch block → fail-OPEN (features are local, no API cost)
 *   - Server responded with any HTTP status → fail-CLOSED (respects server's decision)
 *   - Server responded 200 but malformed body → fail-CLOSED (defense against response tampering)
 *
 * @param {'word' | 'explain'} type - The usage type to increment
 * @returns {Promise<{allowed: boolean, count?: number, is_pro?: boolean, error?: string}>}
 */
// ── Offline / network-failure usage allowance ──
// When the server is unreachable (DNS block, offline, ad-blocker), allow a
// small number of operations per session before requiring connectivity.
// This prevents a trivial paywall bypass (block the Supabase domain via
// hosts file) while not punishing legitimate users with flaky connections.
// The counter resets to 0 on every successful server round-trip.
const MAX_OFFLINE_ALLOWANCE = 3;
let offlineUsageThisSession = 0;

/**
 * Consume one offline allowance unit and return the appropriate response.
 * Called when the server is unreachable — either the browser reports offline
 * or the fetch itself threw a network error (DNS failure, blocked, timeout).
 * @param {string} reason - Human-readable reason for logging
 * @returns {{ allowed: boolean, error: string, offline_remaining?: number }}
 */
function consumeOfflineAllowance(reason) {
  offlineUsageThisSession++;
  if (offlineUsageThisSession <= MAX_OFFLINE_ALLOWANCE) {
    console.log(
      `[PANDA Network] ${reason} — offline allowance ${offlineUsageThisSession}/${MAX_OFFLINE_ALLOWANCE}`
    );
    return {
      allowed: true,
      error: 'network_fallback',
      offline_remaining: MAX_OFFLINE_ALLOWANCE - offlineUsageThisSession,
    };
  }
  console.log(`[PANDA Network] ${reason} — offline allowance exhausted, blocking`);
  return { allowed: false, error: 'network_exhausted' };
}

export async function incrementUsageOnServer(type) {
  if (typeof chrome === 'undefined' || !chrome.storage) {
    return { allowed: false, error: 'context_invalidated' };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return consumeOfflineAllowance('Browser reports offline');
  }

  // Get a valid (auto-refreshed) Firebase ID token
  const token = await getValidFirebaseToken();
  if (!token) {
    return { allowed: false, error: 'unauthenticated' };
  }

  let response;
  try {
    response = await fetch(
      `${SUPABASE_URL}/functions/v1/increment-usage`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'X-Firebase-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_type: type }),
      }
    );
  } catch (err) {
    return consumeOfflineAllowance('Fetch failed: ' + err.message);
  }

  // ── Server responded — respect its decision (Fail-Closed) ──
  if (!response.ok) {
    console.log(`[PANDA Security] Server rejected usage check: HTTP ${response.status}`);
    return { allowed: false, error: `server_rejected_${response.status}` };
  }

  // ── Parse response body — fail-closed on malformed JSON ──
  try {
    const data = await response.json();
    // Server responded successfully — reset offline counter so transient
    // network blips don't permanently penalise the user.
    offlineUsageThisSession = 0;
    if (typeof data.count === 'number') {
      const todayStr = new Date().toISOString().slice(0, 10);
      const storageKey = type === 'word' ? 'dailyWordCount' : 'dailyExplainCount';
      await chrome.storage.local.set({
        [storageKey]: data.count,
        dailyUsageDate: todayStr
      });
    }
    return data;
  } catch (err) {
    console.log('[PANDA Security] Malformed response body:', err);
    return { allowed: false, error: 'malformed_response' };
  }
}


/**
 * Fetch current daily usage from server WITHOUT incrementing.
 * Used by the popup to display accurate quota meters on open.
 *
 * Returns { is_pro, word_count, explain_count, limit } from the server,
 * and caches the values in chrome.storage.local for reactive UI updates.
 *
 * @returns {Promise<{is_pro: boolean, word_count: number, explain_count: number, limit: number} | null>}
 */
export async function fetchDailyUsageFromServer() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return null;
  }
  if (typeof chrome === 'undefined' || !chrome.storage) {
    return null;
  }

  const token = await getValidFirebaseToken();
  if (!token) return null;

  try {
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/increment-usage`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'X-Firebase-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_type: 'status' }),
      }
    );

    if (!response.ok) {
      console.log('[PANDA Status] Server returned:', response.status);
      return null;
    }

    const data = await response.json();

    // Cache server-authoritative counts locally for the popup dashboard
    if (typeof data.word_count === 'number') {
      const todayStr = new Date().toISOString().slice(0, 10);
      await chrome.storage.local.set({
        dailyWordCount: data.word_count,
        dailyExplainCount: data.explain_count || 0,
        dailyUsageDate: todayStr,
        dailyUsageIsPro: Boolean(data.is_pro),
      });
    }

    return data;
  } catch (err) {
    console.log('[PANDA Status] Network error fetching usage:', err.message);
    return null;
  }
}

/**
 * Check user profile subscription status via the secure Edge Function gateway.
 *
 * Security: This function previously queried the 'profiles' table directly via
 * the REST API with the anon key, which allowed anyone with the key to enumerate
 * any user's subscription status. It now routes through the Edge Function which:
 *   1. Verifies the Firebase token server-side
 *   2. Extracts the email from the verified token (not from client params)
 *   3. Queries the DB with service_role (bypasses RLS, but only returns the
 *      authenticated user's own data)
 *
 * @param {string} email - Used only for the return value and local cache key
 * @returns {Promise<{ isPro: boolean, plan: string, email: string }>}
 */
export async function checkUserProfileByEmail(email) {
  if (!email) return { isPro: false, plan: 'free', email: '' };

  // Helper: read cached status from chrome.storage.local
  async function getCachedStatus() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['isPremium', 'plan'], (cached) => {
        resolve({
          isPro: Boolean(cached.isPremium),
          plan: cached.plan || 'free',
          email,
          fromCache: true
        });
      });
    });
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return await getCachedStatus();
  }

  try {
    const token = await getValidFirebaseToken();
    if (!token) {
      // No token = not logged in; return cached status instead of forcing free
      return await getCachedStatus();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/increment-usage`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'X-Firebase-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_type: 'status' }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(`[PANDA Security] Profile check HTTP ${response.status} — falling back to cache`);
      return await getCachedStatus();
    }

    const data = await response.json();
    const isPro = Boolean(data.is_pro);
    const plan = isPro ? (data.plan || 'pro') : 'free';
    const expiresAt = data.expires_at || null;

    await chrome.storage.local.set({
      isPremium: isPro,
      userEmail: email,
      plan,
      expiresAt,
    });

    return { isPro, plan, email, expiresAt };
  } catch (err) {
    console.log('[PANDA Security] Profile check via Edge Function failed:', err.message, '— falling back to cache');
    return await getCachedStatus();
  }
}

/**
 * Verify a user's license key against the 'licenses' table in Supabase.
 * @param {string} licenseKey - The license key entered by the user
 * @returns {Promise<{ valid: boolean, plan?: string, expiresAt?: string, error?: string }>}
 */
export async function verifyLicenseKey(licenseKey) {
  if (!licenseKey || !licenseKey.trim()) {
    return { valid: false, error: 'الرجاء إدخال مفتاح الترخيص' };
  }

  const cleanKey = licenseKey.trim();

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { valid: false, error: 'أنت غير متصل بالإنترنت. يرجى التحقق من الشبكة.' };
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/verify-license`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ licenseKey: cleanKey }),
      }
    );

    const result = await response.json().catch(() => null);

    if (!response.ok || !result) {
      console.log('[Mrky Supabase] Error HTTP status:', response.status);
      return { valid: false, error: 'تعذر الاتصال بقاعدة بيانات التحقق' };
    }

    if (!result.valid) {
      return { valid: false, error: result.error || 'مفتاح الترخيص غير صحيح أو غير موجود' };
    }

    // Save premium status locally
    await chrome.storage.local.set({
      isPremium: true,
      licenseKey: cleanKey,
      plan: result.plan || 'pro'
    });

    return {
      valid: true,
      plan: result.plan || 'pro',
      expiresAt: result.expiresAt
    };
  } catch (err) {
    console.log('[Mrky Supabase] Network error verifying license:', err);
    return { valid: false, error: 'خطأ في الاتصال بالشبكة' };
  }
}

/**
 * Read the locally cached daily usage count INSTANTLY, with no network
 * round-trip. Kept fresh by: (a) the periodic warm-up call to
 * fetchDailyUsageFromServer() already fired from showTooltip() in
 * tooltip.js (throttled to every 25s), and (b) every successful write from
 * incrementUsageOnServer() below. This mirrors the exact same trust model
 * already used by isUserPremium() — trust the local cache at click-time,
 * reconcile with the server in the background — just applied to the daily
 * quota counter instead of the plan flag. The 10/day cap itself is
 * unchanged; only how instantly the check feels to the user changes.
 * @param {'word' | 'explain'} type
 * @returns {Promise<{count: number, remaining: number, isStale: boolean}>}
 */
export async function getLocalDailyUsage(type) {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['dailyWordCount', 'dailyExplainCount', 'dailyUsageDate'],
      (data) => {
        const todayStr = new Date().toISOString().slice(0, 10);
        const isStale = data.dailyUsageDate !== todayStr;
        const count = isStale
          ? 0
          : type === 'word'
            ? (data.dailyWordCount || 0)
            : (data.dailyExplainCount || 0);
        resolve({ count, remaining: Math.max(0, 10 - count), isStale });
      }
    );
  });
}

/**
 * Check stored subscription status from chrome.storage.local
 * @returns {Promise<boolean>}
 */
export async function isUserPremium() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['isPremium'], (data) => {
      resolve(Boolean(data.isPremium));
    });
  });
}

/**
 * Launch Google OAuth Login via Supabase Auth
 */
export function loginWithGoogle() {
  const redirectUrl = chrome.identity?.getRedirectURL ? chrome.identity.getRedirectURL() : `${SUPABASE_URL}/auth/v1/callback`;
  const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUrl)}`;

  if (chrome.identity && chrome.identity.launchWebAuthFlow) {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (callbackUrl) => {
        if (chrome.runtime.lastError || !callbackUrl) {
          window.open(authUrl, '_blank');
          return;
        }
        console.log('[PANDA Auth] Successfully signed in via OAuth flow');
      }
    );
  } else {
    window.open(authUrl, '_blank');
  }
}

/**
 * Open secure Lemon Squeezy checkout with a SERVER-VERIFIED email when the
 * user is logged in (via Firebase).
 *
 * ARCHITECTURE FIX: Uses chrome.tabs.create instead of window.open to avoid
 * stealing focus from the extension popup (which causes Chrome to destroy
 * the popup and kill in-flight JS). Returns an error object instead of
 * calling alert(), so the popup UI can display the message inline.
 *
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function openCheckoutSecurely(plan, fallbackEmail) {
  try {
    const idToken = await getValidFirebaseToken();
    if (!idToken) {
      return { success: false, error: '🔐 يرجى تسجيل الدخول أو إنشاء حساب أولاً لإكمال عملية الشراء وتفعيل اشتراكك تلقائياً.' };
    }

    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/create-checkout`,
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          'X-Firebase-Token': idToken,
        },
        body: JSON.stringify({ plan }),
      }
    );

    const result = await response.json().catch(() => null);
    if (response.ok && result?.url) {
      chrome.tabs.create({ url: result.url });
      return { success: true };
    }

    console.log('[Mrky Supabase] create-checkout failed:', result?.error);
    return { success: false, error: '⚠ تعذر إنشاء رابط الشراء، يرجى المحاولة لاحقاً.' };
  } catch (err) {
    console.log('[Mrky Supabase] create-checkout error:', err);
    return { success: false, error: '⚠ خطأ في الاتصال بالشبكة.' };
  }
}

/**
 * Open secure Lemon Squeezy Annual Checkout (pre-fills email if provided)
 */
export async function openAnnualCheckout(email = '') {
  return await openCheckoutSecurely('annual', email);
}

/**
 * Open secure Lemon Squeezy Monthly Checkout (pre-fills email if provided)
 */
export async function openMonthlyCheckout(email = '') {
  return await openCheckoutSecurely('monthly', email);
}

/**
 * Legacy alias
 */
export function openStripeCheckout(email = '') {
  openAnnualCheckout(email);
}
