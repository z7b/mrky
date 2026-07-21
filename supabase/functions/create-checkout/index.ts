/**
 * PANDA🐼 Edge Function: create-checkout
 *
 * Builds a Lemon Squeezy checkout URL with a SERVER-VERIFIED email baked
 * into custom_data, instead of trusting whatever email the client sends.
 *
 * Why this exists:
 *   The extension previously built the Lemon Squeezy checkout URL entirely
 *   client-side, with the email taken from chrome.storage or, if the user
 *   wasn't logged in yet, straight from an unauthenticated popup text
 *   field. Since the webhook activates Pro on whatever email arrives in
 *   custom_data.ext_email, a user could point a paid checkout at ANY
 *   email — activating Pro on an account that isn't their own. This
 *   doesn't grant free access (a real card still has to pay), but it lets
 *   a paying customer redirect their subscription's benefit to an
 *   arbitrary email without your knowledge. Verifying the Firebase token
 *   here and using ITS email closes that gap.
 *
 * Note: the client still needs to open the returned URL in a window that
 * was created synchronously inside the click handler (before this fetch)
 * to avoid the browser's popup blocker — this function only returns the
 * URL, it doesn't open anything itself.
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createRemoteJWKSet, jwtVerify } from 'https://esm.sh/jose@5';

// ── 1. Firebase Token Verification Logic (Inlined) ──
const FIREBASE_PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID') || '';
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

async function verifyFirebaseToken(idToken: string): Promise<string | null> {
  if (!idToken || !FIREBASE_PROJECT_ID) return null;
  try {
    const { payload } = await jwtVerify(idToken, JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    return email || null;
  } catch (err) {
    console.error('[verify-firebase-token] Failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── 2. Edge Function Logic ──

const LEMON_SQUEEZY_ANNUAL_URL =
  Deno.env.get('LEMONSQUEEZY_ANNUAL_URL') ||
  'https://enpanda.lemonsqueezy.com/checkout/buy/66004302-aa92-4358-9ff5-354e758517fc';
const LEMON_SQUEEZY_MONTHLY_URL =
  Deno.env.get('LEMONSQUEEZY_MONTHLY_URL') ||
  'https://enpanda.lemonsqueezy.com/checkout/buy/96bb46f7-7a33-4991-a728-de063801ad6d';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-firebase-token',
};

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  try {
    const firebaseToken = req.headers.get('X-Firebase-Token') || '';
    if (!firebaseToken) {
      return jsonResponse({ error: 'missing_token' }, 401);
    }

    const email = await verifyFirebaseToken(firebaseToken);
    if (!email) {
      return jsonResponse({ error: 'invalid_token' }, 401);
    }

    let body: { plan?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400);
    }

    const plan = body.plan === 'monthly' ? 'monthly' : 'annual';
    const baseUrl = plan === 'monthly' ? LEMON_SQUEEZY_MONTHLY_URL : LEMON_SQUEEZY_ANNUAL_URL;

    const encoded = encodeURIComponent(email);
    const url = `${baseUrl}?checkout[email]=${encoded}&checkout[custom][ext_email]=${encoded}`;

    return jsonResponse({ url }, 200);
  } catch (err) {
    console.error('[create-checkout] Unhandled error:', err);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
});
