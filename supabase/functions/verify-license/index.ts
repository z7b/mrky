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
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
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
    return jsonResponse({ valid: false, error: 'method_not_allowed' }, 405);
  }

  try {
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

    // service_role bypasses RLS by design — that's intentional and safe
    // here because this function itself is the only thing allowed to read
    // this table; it enforces the actual access rule.
    const { data, error } = await supabase
      .from('licenses')
      .select('id, is_active, plan, expires_at')
      .eq('key', licenseKey)
      .maybeSingle();

    if (error) {
      console.error('[verify-license] DB error:', JSON.stringify(error));
      return jsonResponse({ valid: false, error: 'db_error' }, 500);
    }

    if (!data) {
      return jsonResponse({ valid: false, error: 'مفتاح الترخيص غير صحيح أو غير موجود' }, 200);
    }
    if (!data.is_active) {
      return jsonResponse({ valid: false, error: 'مفتاح الترخيص غير مفعل أو منتهي الصلاحية' }, 200);
    }

    return jsonResponse(
      {
        valid: true,
        plan: data.plan || 'pro',
        expiresAt: data.expires_at,
      },
      200
    );
  } catch (err) {
    console.error('[verify-license] Unhandled error:', err);
    return jsonResponse({ valid: false, error: 'internal_error' }, 500);
  }
});
