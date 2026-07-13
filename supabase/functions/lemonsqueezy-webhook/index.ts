// Supabase Edge Function: Lemon Squeezy Webhook Handler for PANDA🐼
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const WEBHOOK_SECRET = Deno.env.get('LEMONSQUEEZY_WEBHOOK_SECRET') || '';
const EXPECTED_STORE_ID = Deno.env.get('LEMONSQUEEZY_STORE_ID') || '';

async function verifySignature(rawBody: string, signatureHeader: string, secret: string) {
  if (!signatureHeader || !secret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const macBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const computedHex = Array.from(new Uint8Array(macBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (computedHex.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
    }

    const rawBody = await req.text();
    const signature = req.headers.get('X-Signature') || req.headers.get('x-signature') || '';

    if (!(await verifySignature(rawBody, signature, WEBHOOK_SECRET))) {
      console.error('[PANDA Webhook] REJECTED: Invalid or missing signature');
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const payload = JSON.parse(rawBody);
    const eventName = payload.meta?.event_name;
    console.log('[PANDA Webhook] Verified event:', eventName);

    // ── Step 5: Store ID validation (prevents cross-product activation) ──
    const incomingStoreId = payload.data?.attributes?.store_id?.toString() || '';
    if (EXPECTED_STORE_ID && incomingStoreId !== EXPECTED_STORE_ID) {
      console.error(`[PANDA Webhook] REJECTED: Wrong store_id ${incomingStoreId}`);
      return new Response(JSON.stringify({ error: 'Unrecognized store' }), { status: 400 });
    }

    // ── Step 5.1: Validate Variant ID and extract Plan Name (Fail-Closed) ──
    const attrs = payload.data?.attributes || {};
    const variantId = (attrs.variant_id ?? attrs.first_order_item?.variant_id)?.toString() || '';

    // ⚠️ تنبيه هام: يجب استبدال المعرفات الرقمية أدناه (Integers) بالقيم الفعلية من لوحة تحكم ليمون سكويزي للمتغيرات (Variants) الخاصة بـ PANDA Pro
    const PLAN_BY_VARIANT: Record<string, string> = {
      '1214334': 'monthly', // باقة PANDA Pro الشهرية
      '1214317': 'annual'   // باقة PANDA Pro السنوية
    };

    const planName = PLAN_BY_VARIANT[variantId];

    // إغلاق الدائرة (Fail-Closed) إذا لم يتطابق معرف المتغير مع المعرفات المعتمدة
    if (!planName) {
      console.log(`[PANDA Webhook] Skipped - variant ${variantId} is not a valid PANDA Pro variant`);
      return new Response(JSON.stringify({ received: true, skipped: true }), { status: 200 });
    }

    // ── Step 6: Extract and NORMALIZE customer email ──
    const rawEmail =
      payload.meta?.custom_data?.ext_email ||  // الأولوية القصوى للمعرف المحمي الممرر سراً من الإضافة
      payload.data?.attributes?.user_email ||
      payload.data?.attributes?.customer_email ||
      payload.data?.attributes?.email;

    if (!rawEmail) {
      return new Response(JSON.stringify({ error: 'Missing email' }), { status: 400 });
    }

    const customerEmail = rawEmail.trim().toLowerCase();

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('[PANDA Webhook] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
      return new Response(JSON.stringify({ error: 'Server misconfigured' }), { status: 500 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ── Step 8: Idempotency check ──
    const eventId = payload.meta?.webhook_id || '';
    if (eventId) {
      const { data: existing } = await supabase
        .from('processed_events')
        .select('id')
        .eq('event_id', eventId)
        .maybeSingle();

      if (existing) {
        console.log(`[PANDA Webhook] Duplicate event ${eventId}, skipping.`);
        return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
      }
    }

    const activationEvents = [
      'order_created',
      'subscription_created',
      'subscription_resumed',
      'subscription_unpaused',
      'subscription_updated',
      'subscription_payment_success',
      'subscription_payment_recovered',
      'subscription_plan_changed'
    ];

    const deactivationEvents = [
      'subscription_expired',
      'subscription_cancelled',
      'subscription_paused',
      'order_refunded',
      'subscription_payment_refunded'
    ];

    // ── Step 9: Process activation events ──
    if (activationEvents.includes(eventName)) {
      console.log(`[PANDA Webhook] Activating Pro: ${customerEmail} (${eventName}, ${planName})`);

      const { error } = await supabase
        .from('profiles')
        .upsert(
          {
            email: customerEmail,
            is_pro: true,
            plan: planName, // المعرف بصورة موحدة من خريطة المتغيرات
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'email' }
        );

      if (error) {
        console.error('[PANDA Webhook] DB error:', error);
        return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 });
      }

      if (eventId) {
        await supabase.from('processed_events').insert({
          event_id: eventId,
          event_name: eventName,
          email: customerEmail,
          processed_at: new Date().toISOString()
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Step 10: Process deactivation events ──
    if (deactivationEvents.includes(eventName)) {
      console.log(`[PANDA Webhook] Downgrading: ${customerEmail} (${eventName})`);

      const { error } = await supabase
        .from('profiles')
        .upsert(
          {
            email: customerEmail,
            is_pro: false,
            plan: 'free',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'email' }
        );

      if (error) {
        console.error('[PANDA Webhook] DB error:', error);
        return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 });
      }

      if (eventId) {
        await supabase.from('processed_events').insert({
          event_id: eventId,
          event_name: eventName,
          email: customerEmail,
          processed_at: new Date().toISOString()
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (err) {
    console.error('[PANDA Webhook] Internal Error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 });
  }
});
