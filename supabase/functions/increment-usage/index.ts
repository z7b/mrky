/**
 * PANDA🐼 Edge Function: increment-usage
 *
 * Secure gateway between the extension (Firebase Auth) and Supabase DB.
 *
 * Architecture:
 *   Extension → Firebase ID Token → this Edge Function → verifies token via Google Identity Toolkit
 *   → extracts email server-side → calls increment_usage(p_email, p_type) with service_role → returns result
 *
 * Why this exists:
 *   The extension authenticates users via Firebase Auth (REST API), but the database is Supabase.
 *   PostgreSQL's auth.jwt() only recognizes Supabase-issued JWTs, so Firebase tokens would always
 *   return NULL for auth.jwt() >> 'email'. This Edge Function bridges the gap by:
 *   1. Verifying the Firebase token server-side (no client trust)
 *   2. Extracting the email from the verified token
 *   3. Calling the DB function with service_role (bypasses RLS, which is intentional — the function
 *      itself enforces all business rules)
 *
 * Security layers:
 *   - Firebase token is verified via Google's Identity Toolkit API (not decoded locally)
 *   - Email is extracted server-side from the verified token (never from client params)
 *   - DB function is REVOKE'd from anon/authenticated — only service_role can call it
 *   - CORS is restricted to extension origin
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Environment Variables ──
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const FIREBASE_API_KEY = Deno.env.get('FIREBASE_API_KEY') || '';

// ── CORS Headers ──
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-firebase-token',
};

/**
 * Verify a Firebase ID token by calling Google's Identity Toolkit API.
 * This is a server-to-server call — Google verifies the token's signature, expiry,
 * and issuer, then returns the user's profile including email.
 *
 * @param idToken - The Firebase ID token from the extension
 * @returns The verified user's email (lowercase, trimmed), or null if invalid
 */
async function verifyFirebaseToken(idToken: string): Promise<string | null> {
  if (!idToken || !FIREBASE_API_KEY) return null;

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );

    if (!res.ok) {
      console.error('[increment-usage] Firebase token verification failed:', res.status);
      return null;
    }

    const data = await res.json();
    const user = data.users?.[0];
    if (!user?.email) {
      console.error('[increment-usage] Verified token has no email');
      return null;
    }

    return user.email.trim().toLowerCase();
  } catch (err) {
    console.error('[increment-usage] Firebase verification network error:', err);
    return null;
  }
}

/**
 * Create a typed JSON response with standard headers.
 */
function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ── Main Handler ──
serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Only POST allowed
  if (req.method !== 'POST') {
    return jsonResponse({ allowed: false, error: 'method_not_allowed' }, 405);
  }

  try {
    // ── 1. Extract and verify Firebase token ──
    const firebaseToken = req.headers.get('X-Firebase-Token') || '';
    if (!firebaseToken) {
      return jsonResponse({ allowed: false, error: 'missing_token' }, 401);
    }

    const email = await verifyFirebaseToken(firebaseToken);
    if (!email) {
      return jsonResponse({ allowed: false, error: 'invalid_token' }, 401);
    }

    // ── 2. Parse and validate request body ──
    let body: { p_type?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ allowed: false, error: 'invalid_json' }, 400);
    }

    const type = body.p_type;
    if (type !== 'word' && type !== 'explain' && type !== 'status') {
      return jsonResponse({ allowed: false, error: 'invalid_type' }, 400);
    }

    // ── 3. Check server configuration ──
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('[increment-usage] Missing SUPABASE env vars');
      return jsonResponse({ allowed: false, error: 'server_misconfigured' }, 500);
    }

    // ── 4. Call DB function with service_role ──
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Status query: read-only, returns current counts without incrementing
    if (type === 'status') {
      const { data, error } = await supabase.rpc('get_daily_usage', {
        p_email: email,
      });

      if (error) {
        console.error('[increment-usage] RPC get_daily_usage error:', JSON.stringify(error));
        return jsonResponse({ error: 'db_error' }, 500);
      }

      return jsonResponse(data as Record<string, unknown>, 200);
    }

    // Increment query: increases counter and returns new count
    const { data, error } = await supabase.rpc('increment_usage', {
      p_email: email,
      p_type: type,
    });

    if (error) {
      console.error('[increment-usage] RPC error:', JSON.stringify(error));
      return jsonResponse({ allowed: false, error: 'db_error' }, 500);
    }

    // The RPC returns JSONB directly — pass it through
    return jsonResponse(data as Record<string, unknown>, 200);
  } catch (err) {
    console.error('[increment-usage] Unhandled error:', err);
    return jsonResponse({ allowed: false, error: 'internal_error' }, 500);
  }
});
