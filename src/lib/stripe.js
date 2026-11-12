'use strict';
// Minimal Stripe client for wholesale package checkout (no SDK dependency).
// Docs: https://stripe.com/docs/api/checkout/sessions · https://stripe.com/docs/webhooks/signatures
const crypto = require('crypto');
const config = require('../config');

const configured = () => !!config.stripe.secretKey;

// Stripe's form encoding: nested objects become a[b][c]=v.
function encode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function call(method, path, body = null, { idempotencyKey = null } = {}) {
  if (!configured()) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY).');
  const headers = { Authorization: `Bearer ${config.stripe.secretKey}` };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${config.stripe.apiBase}${path}`, { method, headers, body: body ? encode(body).toString() : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `Stripe ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function createCheckoutSession({ order, email, successUrl, cancelUrl }) {
  return call(
    'POST',
    '/v1/checkout/sessions',
    {
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: order.ref,
      customer_email: email,
      metadata: { order_ref: order.ref },
      payment_intent_data: { metadata: { order_ref: order.ref } },
      line_items: {
        0: {
          quantity: 1,
          price_data: {
            currency: order.currency.toLowerCase(),
            unit_amount: order.price_cents,
            product_data: {
              name: order.package_name,
              description: `${order.credits.toLocaleString('en-US')} promotional credits for See It. Cook It.${order.coupon_code ? ` Coupon ${order.coupon_code} applied.` : ''}`,
            },
          },
        },
      },
    },
    { idempotencyKey: `checkout-${order.ref}` },
  );
}

const retrieveSession = (id) => call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`);

// Verifies the Stripe-Signature header against the raw request body.
function verifyWebhook(rawBody, header, toleranceSec = 300) {
  const secret = config.stripe.webhookSecret;
  if (!secret || !header) return null;
  const items = String(header).split(',').map((p) => p.split('='));
  const t = (items.find(([k]) => k === 't') || [])[1];
  const sigs = items.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

module.exports = { configured, createCheckoutSession, retrieveSession, verifyWebhook, encode };
