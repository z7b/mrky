/**
 * PANDA🐼 Pro - Official Firebase Configuration & In-Extension Auth Service
 * Project: panda-pro-e1dc4
 * Performs 100% In-Extension Authentication without external redirects or websites.
 */

import { checkUserProfileByEmail } from './supabase.js';

export const firebaseConfig = {
  apiKey: "AIzaSyD0xPBLABsmXrMUbpSBAeRcTLIAZiGLa1g",
  authDomain: "panda-pro-e1dc4.firebaseapp.com",
  projectId: "panda-pro-e1dc4",
  storageBucket: "panda-pro-e1dc4.firebasestorage.app",
  messagingSenderId: "1028730482168",
  appId: "1:1028730482168:web:cc0198ae40e984b99aba0d",
  measurementId: "G-T835ZLS20R"
};

/**
 * Check if a user is Pro in Supabase profiles OR Firebase Firestore
 * @param {string} email
 */
export async function checkFirebaseProStatus(email) {
  if (!email || !email.trim()) return { isPro: false, plan: 'free', email };
  const cleanEmail = email.trim().toLowerCase();

  try {
    // 1. Check Supabase 'profiles' table first (where Webhooks & SQL profiles are stored)
    const sbStatus = await checkUserProfileByEmail(cleanEmail);
    if (sbStatus && sbStatus.isPro) {
      await chrome.storage.local.set({
        isPremium: true,
        userEmail: cleanEmail,
        plan: sbStatus.plan || 'pro'
      });
      return { isPro: true, plan: sbStatus.plan || 'pro', email: cleanEmail };
    }

    // 2. Fallback check to Firestore profiles document
    const docId = encodeURIComponent(cleanEmail);
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/profiles/${docId}?key=${firebaseConfig.apiKey}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const fields = data.fields || {};
      const isPro = fields.is_pro?.booleanValue || false;
      const plan = fields.plan?.stringValue || (isPro ? 'pro' : 'free');

      if (isPro) {
        await chrome.storage.local.set({
          isPremium: true,
          userEmail: cleanEmail,
          plan
        });
        return { isPro: true, plan, email: cleanEmail };
      }
    }

    return { isPro: false, plan: 'free', email: cleanEmail };
  } catch (err) {
    console.error('[PANDA Pro Check] Error verifying profile status:', err);
    // On network failure, fall back to cached status instead of forcing free
    return new Promise((resolve) => {
      chrome.storage.local.get(['isPremium', 'plan'], (cached) => {
        resolve({
          isPro: Boolean(cached.isPremium),
          plan: cached.plan || 'free',
          email: cleanEmail
        });
      });
    });
  }
}

/**
 * Sign in directly inside the extension using Firebase Auth REST API (NO external redirects or tabs!)
 * @param {string} email
 * @param {string} password
 */
export async function signInWithFirebaseEmailPassword(email, password) {
  if (!email || !email.trim()) {
    return { success: false, error: 'الرجاء إدخال البريد الإلكتروني' };
  }
  const cleanEmail = email.trim().toLowerCase();

  // 🔴 SECURITY FIX: Password is mandatory for login
  if (!password || !password.trim()) {
    return { success: false, error: 'الرجاء إدخال كلمة المرور' };
  }

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: cleanEmail,
          password: password.trim(),
          returnSecureToken: true
        })
      }
    );

    const data = await res.json();
    if (!res.ok || data.error) {
      // 🔴 SECURITY FIX: Wrong password = ALWAYS fail. Never bypass auth.
      const msg = data.error?.message || 'بيانات الدخول غير صحيحة';
      const friendlyErrors = {
        'INVALID_PASSWORD': 'كلمة المرور غير صحيحة',
        'EMAIL_NOT_FOUND': 'البريد الإلكتروني غير مسجل، أنشئ حساب جديد',
        'INVALID_LOGIN_CREDENTIALS': 'البريد أو كلمة المرور غير صحيحة',
        'TOO_MANY_ATTEMPTS_TRY_LATER': 'محاولات كثيرة، حاول لاحقاً',
        'USER_DISABLED': 'هذا الحساب معطل'
      };
      return {
        success: false,
        error: friendlyErrors[msg] || 'بيانات الدخول غير صحيحة'
      };
    }

    // ── Step 1: Check email verification status ──
    let emailVerified = false;
    try {
      const lookupRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseConfig.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: data.idToken })
        }
      );
      const lookupData = await lookupRes.json();
      emailVerified = lookupData.users?.[0]?.emailVerified === true;
    } catch {
      // If lookup fails, allow login but flag as unverified
    }

    // ── Block login if email is NOT verified ──
    if (!emailVerified) {
      // Save token temporarily so resend verification can work
      await chrome.storage.local.set({
        pendingVerificationEmail: cleanEmail,
        pendingVerificationToken: data.idToken
      });
      return {
        success: false,
        error: 'EMAIL_NOT_VERIFIED',
        email: cleanEmail,
        needsVerification: true
      };
    }

    // ── Step 2: Save tokens (email is verified) ──
    await chrome.storage.local.set({
      userEmail: cleanEmail,
      firebaseToken: data.idToken,
      firebaseRefreshToken: data.refreshToken,
      firebaseTokenExpiry: Date.now() + (parseInt(data.expiresIn, 10) * 1000),
      emailVerified: true
    });

    // ── Step 3: Quick inline check (non-blocking for UI, but we await for initial result) ──
    let isPro = false;
    let plan = 'free';
    try {
      const proStatus = await checkFirebaseProStatus(cleanEmail);
      isPro = proStatus.isPro;
      plan = proStatus.plan || 'free';
      await chrome.storage.local.set({ isPremium: isPro, plan });
    } catch {
      // If initial check fails, that's OK — background retries will handle it
    }

    // ── Step 4: Schedule background verification (covers Edge Function cold start / failures) ──
    chrome.runtime.sendMessage({
      type: 'SCHEDULE_SUBSCRIPTION_CHECK',
      payload: { email: cleanEmail }
    }).catch(() => {});

    return {
      success: true,
      email: cleanEmail,
      isPro,
      plan,
      emailVerified: true
    };
  } catch (err) {
    console.error('[PANDA Firebase] Sign in error:', err);
    return { success: false, error: 'حدث خطأ في الاتصال بسحابة Firebase' };
  }
}

/**
 * Create a new account directly inside the extension using Firebase Auth REST API
 * @param {string} email
 * @param {string} password
 */
export async function signUpWithFirebaseEmailPassword(email, password) {
  if (!email || !email.trim()) {
    return { success: false, error: 'الرجاء إدخال البريد الإلكتروني' };
  }
  if (!password || !password.trim() || password.trim().length < 6) {
    return { success: false, error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' };
  }
  const cleanEmail = email.trim().toLowerCase();

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${firebaseConfig.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: cleanEmail,
          password: password.trim(),
          returnSecureToken: true
        })
      }
    );

    const data = await res.json();
    if (!res.ok || data.error) {
      const msg = data.error?.message || '';
      if (msg.includes('EMAIL_EXISTS')) {
        return { success: false, error: 'البريد الإلكتروني مسجل بالفعل، يرجى تسجيل الدخول' };
      }
      return { success: false, error: 'تعذر إنشاء الحساب: ' + msg };
    }

    // ── Send email verification automatically ──
    try {
      await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${firebaseConfig.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestType: 'VERIFY_EMAIL',
            idToken: data.idToken
          })
        }
      );
      console.log('[PANDA Firebase] ✅ Verification email sent to', cleanEmail);
    } catch {
      console.warn('[PANDA Firebase] ⚠️ Could not send verification email');
    }

    await chrome.storage.local.set({
      userEmail: cleanEmail,
      firebaseToken: data.idToken,
      firebaseRefreshToken: data.refreshToken,
      firebaseTokenExpiry: Date.now() + (parseInt(data.expiresIn, 10) * 1000),
      isPremium: false,
      plan: 'free',
      emailVerified: false,
      pendingVerificationEmail: cleanEmail,
      pendingVerificationToken: data.idToken
    });

    return {
      success: true,
      email: cleanEmail,
      isPro: false,
      plan: 'free',
      emailVerified: false,
      needsVerification: true
    };
  } catch (err) {
    console.error('[PANDA Firebase] Sign up error:', err);
    return { success: false, error: 'حدث خطأ في الاتصال بسحابة Firebase' };
  }
}

/**
 * Resend email verification for unverified accounts.
 * Uses the pending token saved during blocked login.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function resendVerificationEmail() {
  const stored = await chrome.storage.local.get(['pendingVerificationEmail', 'pendingVerificationToken']);
  const token = stored.pendingVerificationToken;
  const email = stored.pendingVerificationEmail;

  if (!token || !email) {
    return { success: false, error: 'لا يوجد حساب بحاجة للتحقق' };
  }

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${firebaseConfig.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestType: 'VERIFY_EMAIL',
          idToken: token
        })
      }
    );
    const data = await res.json();
    if (!res.ok || data.error) {
      // Token may have expired — user needs to try logging in again
      const msg = data.error?.message || '';
      if (msg.includes('INVALID_ID_TOKEN') || msg.includes('TOKEN_EXPIRED')) {
        return { success: false, error: 'انتهت الجلسة. أعد تسجيل الدخول ثم اضغط إعادة إرسال.' };
      }
      return { success: false, error: 'تعذر إرسال رسالة التحقق' };
    }
    console.log('[PANDA Firebase] ✅ Verification email re-sent to', email);
    return { success: true, email };
  } catch (err) {
    console.error('[PANDA Firebase] Resend verification error:', err);
    return { success: false, error: 'حدث خطأ في الاتصال' };
  }
}

/**
 * Send password reset email via Firebase Auth REST API
 * @param {string} email
 */
export async function sendPasswordResetEmail(email) {
  if (!email || !email.trim()) {
    return { success: false, error: 'الرجاء إدخال البريد الإلكتروني أولاً' };
  }
  const cleanEmail = email.trim().toLowerCase();

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${firebaseConfig.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestType: 'PASSWORD_RESET',
          email: cleanEmail,
          continueUrl: `https://${firebaseConfig.authDomain}`
        })
      }
    );

    const data = await res.json();
    if (!res.ok || data.error) {
      const msg = data.error?.message || '';
      if (msg.includes('EMAIL_NOT_FOUND') || msg.includes('USER_NOT_FOUND')) {
        return { success: false, error: '⚠️ هذا البريد غير مسجل بالسيرفر. يرجى إدخال كلمة مرور والضغط على "حساب جديد ➕" لإنشاء حساب أولاً!' };
      }
      return { success: false, error: 'تعذر إرسال رابط الاستعادة: ' + (msg || 'خطأ غير معروف') };
    }

    return { success: true };
  } catch (err) {
    console.error('[PANDA Firebase] Password reset error:', err);
    return { success: false, error: 'حدث خطأ في الاتصال' };
  }
}

/**
 * Get a valid (non-expired) Firebase ID token.
 * Automatically refreshes via the stored refresh token if the current token is expired.
 * Returns null if no token is stored or refresh fails (user must re-login).
 *
 * @returns {Promise<string|null>} A valid Firebase ID token, or null.
 */
export function getValidFirebaseToken() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      resolve(null);
      return;
    }
    chrome.storage.local.get(
      ['firebaseToken', 'firebaseRefreshToken', 'firebaseTokenExpiry'],
      async (stored) => {
        // No token at all — user is not logged in
        if (!stored.firebaseToken) {
          resolve(null);
          return;
        }

        // Token still valid (with 60s safety margin to avoid edge-of-expiry failures)
        if (stored.firebaseTokenExpiry && Date.now() < stored.firebaseTokenExpiry - 60_000) {
          resolve(stored.firebaseToken);
          return;
        }

        // Token expired — attempt refresh
        if (!stored.firebaseRefreshToken) {
          console.warn('[PANDA Auth] Token expired and no refresh token available');
          resolve(null);
          return;
        }

        try {
          const res = await fetch(
            `https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                grant_type: 'refresh_token',
                refresh_token: stored.firebaseRefreshToken
              })
            }
          );

          if (!res.ok) {
            console.error('[PANDA Auth] Token refresh failed:', res.status);
            resolve(null);
            return;
          }

          const result = await res.json();
          const newToken = result.id_token;
          const newRefresh = result.refresh_token;
          const expiresIn = parseInt(result.expires_in, 10) || 3600;

          await chrome.storage.local.set({
            firebaseToken: newToken,
            firebaseRefreshToken: newRefresh,
            firebaseTokenExpiry: Date.now() + (expiresIn * 1000)
          });

          resolve(newToken);
        } catch (err) {
          console.error('[PANDA Auth] Token refresh network error:', err);
          resolve(null);
        }
      }
    );
  });
}
