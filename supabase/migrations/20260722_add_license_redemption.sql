-- ============================================================================
-- PANDA🐼 Migration: Atomic License Redemption
--
-- Adds redemption tracking columns to `licenses` and creates the
-- `redeem_license_key` RPC function that verify-license Edge Function calls.
--
-- This migration is idempotent — safe to run multiple times.
-- ============================================================================

-- ── 1. Add redemption columns to licenses (if missing) ──
ALTER TABLE public.licenses
  ADD COLUMN IF NOT EXISTS redeemed_by_email text,
  ADD COLUMN IF NOT EXISTS redeemed_at timestamptz;

-- Optional index for quick "has this email already redeemed a key?" lookups
CREATE INDEX IF NOT EXISTS idx_licenses_redeemed_by_email
  ON public.licenses (redeemed_by_email)
  WHERE redeemed_by_email IS NOT NULL;


-- ── 2. Atomic redeem function ──
-- Called by verify-license Edge Function with service_role.
-- Returns JSONB with: { valid, error?, plan?, expires_at? }
--
-- Atomicity guarantees:
--   - SELECT ... FOR UPDATE locks the license row for the duration of the
--     transaction, preventing two concurrent requests from redeeming the
--     same key simultaneously.
--   - The profiles upsert and the license update happen in the same
--     implicit transaction (PL/pgSQL functions run inside one).
--
-- Idempotency:
--   - If the same email redeems the same key again, it returns success
--     without re-writing (no-op upsert still runs to heal any profiles
--     row that might have been deleted/reset in the meantime).
-- ============================================================================

CREATE OR REPLACE FUNCTION redeem_license_key(
  p_license_key text,
  p_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_license record;
BEGIN
  -- ── Step 1: Lock and fetch the license row ──
  SELECT id, key, is_active, plan, expires_at, redeemed_by_email, redeemed_at
    INTO v_license
    FROM public.licenses
   WHERE key = p_license_key
     FOR UPDATE;

  -- Key not found
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'valid', false,
      'error', 'مفتاح الترخيص غير صحيح أو غير موجود'
    );
  END IF;

  -- Key is deactivated
  IF NOT v_license.is_active THEN
    RETURN jsonb_build_object(
      'valid', false,
      'error', 'مفتاح الترخيص غير مفعل أو منتهي الصلاحية'
    );
  END IF;

  -- Key has expired (defense in depth — don't rely solely on is_active)
  IF v_license.expires_at IS NOT NULL AND v_license.expires_at < now() THEN
    RETURN jsonb_build_object(
      'valid', false,
      'error', 'مفتاح الترخيص منتهي الصلاحية'
    );
  END IF;

  -- ── Step 2: Check if already redeemed by a DIFFERENT email ──
  IF v_license.redeemed_by_email IS NOT NULL
     AND v_license.redeemed_by_email <> p_email THEN
    RETURN jsonb_build_object(
      'valid', false,
      'error', 'مفتاح الترخيص مستخدم بالفعل'
    );
  END IF;

  -- ── Step 3: Stamp redemption (idempotent if same email) ──
  UPDATE public.licenses
     SET redeemed_by_email = p_email,
         redeemed_at = COALESCE(v_license.redeemed_at, now())
   WHERE id = v_license.id;

  -- ── Step 4: Upsert profiles row → is_pro = true ──
  -- Mirrors the exact upsert shape used by lemonsqueezy-webhook
  INSERT INTO public.profiles (email, is_pro, plan, expires_at, updated_at)
  VALUES (
    p_email,
    true,
    COALESCE(v_license.plan, 'pro'),
    v_license.expires_at,
    now()
  )
  ON CONFLICT (email)
  DO UPDATE SET
    is_pro     = true,
    plan       = COALESCE(v_license.plan, 'pro'),
    expires_at = v_license.expires_at,
    updated_at = now();

  -- ── Step 5: Return success ──
  RETURN jsonb_build_object(
    'valid', true,
    'plan', COALESCE(v_license.plan, 'pro'),
    'expires_at', v_license.expires_at
  );
END;
$$;

-- ── 3. Lock down permissions (same convention as increment_usage) ──
REVOKE ALL ON FUNCTION redeem_license_key(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION redeem_license_key(text, text) TO service_role;
