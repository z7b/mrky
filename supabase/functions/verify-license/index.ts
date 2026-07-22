/**
 * PANDA🐼 Edge Function: verify-license
 *
 * Checks a license key against the `licenses` table using service_role, so
 * the table itself never has to be readable by the anon/public role.
 *
 * Why this exists:
 *   The previous flow queried `${SUPABASE_URL}/rest/v1/licenses?key=eq....`
 *   directly from the extension using the public anon key. That only stays
 *   safe if the table's RLS policy denies anon SELECT entirely — and if it
 *   doesn't (e.g. a policy broader than intended, or none at all beyond
 *   Supabase's default), the entire licenses table — every customer's key,
 *   plan, and active status — is readable by anyone who extracts the
 *   public SUPABASE_URL/anon key from the extension bundle (trivial; those
 *   values are never secret in a client-side app) and calls the REST API
 *   directly with no filter.
 *
 *   Routing this through service_role here means anon never needs SELECT
 *   on `licenses` at all — you can safely lock the table down to
 *   `service_role` only in RLS.
 *
 * Auth model (added):
 *   Requires a Firebase ID token via X-Firebase-Token header. The email is
 *   extracted server-side from the verified JWT — never trusted from the
 *   client. This matches the pattern already used by increment-usage.
 *
 * Redemption model (added):
 *   On successful validation the function calls the `redeem_license_key`
 *   Postgres RPC which atomically (FOR UPDATE row lock):
 *     1. Re-validates the license row
 *     2. Checks if already redeemed by another email (rejects)
 *     3. If same email → idempotent success
 *     4. If unredeemed → stamps redeemed_by_email + redeemed_at, then
 *        upserts into profiles (is_pro=true, plan, expires_at)
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createRemoteJWKSet, jwtVerify } from 'https://esm.sh/jose@5';

// ── Firebase Token Verification (same pattern as increment-usage) ──
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
    console.error('[verify-license] Firebase token verification failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Environment Variables ──
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-firebase-token',
};

/**
 * Best-effort client IP for rate limiting. Supabase Edge Functions run
 * behind a proxy that sets x-forwarded-for; take the first (client-facing)
 * address. Falls back to a constant so a missing header still shares one
 * bucket instead of throwing — worst case that shared bucket rate-limits
 * together, which is an acceptable degrade, not a security hole.
 */
function getClientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') || '';
  const first = fwd.split(',')[0]?.trim();
  return first || 'unknown';
}

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
    return jsonResponse({ valid: false, error: 'method_not_allowed' }, 405);
  }

  try {
    // ── 1. Authenticate caller via Firebase token ──
    const firebaseToken = req.headers.get('X-Firebase-Token') || '';
    if (!firebaseToken) {
      return jsonResponse({ valid: false, error: 'يرجى تسجيل الدخول أولاً لتفعيل الترخيص' }, 401);
    }

    const email = await verifyFirebaseToken(firebaseToken);
    if (!email) {
      return jsonResponse({ valid: false, error: 'جلسة تسجيل الدخول غير صالحة، أعد تسجيل الدخول' }, 401);
    }

    // ── 2. Parse request body ──
    let body: { licenseKey?: string };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ valid: false, error: 'invalid_json' }, 400);
    }

    const licenseKey = (body.licenseKey || '').trim();
    if (!licenseKey) {
      return jsonResponse({ valid: false, error: 'الرجاء إدخال مفتاح الترخيص' }, 400);
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('[verify-license] Missing SUPABASE env vars');
      return jsonResponse({ valid: false, error: 'server_misconfigured' }, 500);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ── 3. Rate limit: max attempts per IP per time window ──
    // Defends against brute-forcing license keys. Atomic check+increment
    // happens inside the Postgres function itself.
    const clientIp = getClientIp(req);
    const { data: rateOk, error: rateError } = await supabase.rpc('check_license_rate_limit', {
      p_ip: clientIp,
    });
    if (rateError) {
      console.error('[verify-license] Rate limit check failed:', JSON.stringify(rateError));
      // Fail OPEN on infra errors so a DB hiccup never blocks legitimate
      // customers from activating a license they paid for.
    } else if (rateOk === false) {
      return jsonResponse({ valid: false, error: 'too_many_attempts' }, 429);
    }

    // ── 4. Atomic license redemption via RPC ──
    // This single Postgres function (SECURITY DEFINER, service_role only):
    //   - Locks the license row FOR UPDATE (prevents race conditions)
    //   - Validates is_active + expiry
    //   - Checks redeemed_by_email (prevents reuse by different accounts)
    //   - If same email → idempotent success
    //   - If unredeemed → stamps redeemed_by_email/redeemed_at + upserts profiles
    const { data: redeemResult, error: redeemError } = await supabase.rpc('redeem_license_key', {
      p_license_key: licenseKey,
      p_email: email,
    });

    if (redeemError) {
      console.error('[verify-license] RPC redeem_license_key error:', JSON.stringify(redeemError));
      return jsonResponse({ valid: false, error: 'db_error' }, 500);
    }

    // The RPC returns a JSONB object with: valid, error?, plan?, expires_at?
    const result = redeemResult as Record<string, unknown>;

    if (!result.valid) {
      return jsonResponse(
        { valid: false, error: result.error || 'مفتاح الترخيص غير صحيح أو غير موجود' },
        200
      );
    }

    return jsonResponse(
      {
        valid: true,
        plan: result.plan || 'pro',
        expiresAt: result.expires_at,
      },
      200
    );
  } catch (err) {
    console.error('[verify-license] Unhandled error:', err);
    return jsonResponse({ valid: false, error: 'internal_error' }, 500);
  }
});
