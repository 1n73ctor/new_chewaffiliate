'use strict';
// See It. Cook It. wholesale program: package orders (Stripe), app revenue and
// refunds, dashboard summaries and notifications. Credit movements live in credits.js.
const db = require('../db');
const config = require('../config');
const settings = require('./settings');
const stripe = require('./stripe');
const credits = require('./credits');
const audit = require('./audit');
const { sendEmail } = require('./notify');
const { recordEvent, EVENT_TYPES, SIC_REVENUE_TYPES } = require('./tracking');
const { money, daysAgo, now } = require('./util');

const SIC_COMMISSION_TYPES = [...SIC_REVENUE_TYPES, 'sic_refund'];
const IN = (list) => list.map((t) => `'${t}'`).join(',');
const enabled = () => settings.get('sic_wholesale_enabled') === '1';
const termsVersion = () => settings.get('wholesale_terms_version') || '1.0';

// ---- Packages & orders ----------------------------------------------------------------
const packages = () => db.all('SELECT * FROM credit_packages WHERE active = 1 ORDER BY sort, price_cents, id');

// Why this affiliate can't buy right now (null = they can).
function purchaseBlocker(userId) {
  if (!enabled()) return 'Wholesale packages are not available right now.';
  if (!stripe.configured()) return 'Online payment isn’t set up yet. Please contact support to buy a package.';
  const acct = credits.account(userId);
  if (acct && acct.status === 'suspended') return 'Your wholesale account is suspended. Please contact support.';
  if (!acct || !acct.attribution_ack_at || acct.attribution_ack_version !== termsVersion()) return 'Please acknowledge the Wholesale Terms and attribution policy first.';
  const below = settings.int('sic_repurchase_below', 0);
  if (below > 0 && acct.status === 'active' && credits.available(userId) >= below) {
    return `You can buy more credits once your available balance is below ${below.toLocaleString('en-US')}.`;
  }
  return null;
}

function acknowledge(req) {
  credits.ensureAccount(req.user.id);
  db.run(
    "UPDATE wholesale_accounts SET attribution_ack_at = datetime('now'), attribution_ack_version = ?, updated_at = datetime('now') WHERE user_id = ?",
    termsVersion(),
    req.user.id,
  );
  audit(req, 'wholesale.policy_acknowledged', 'user', req.user.id, { version: termsVersion() });
}

// ---- Coupons -----------------------------------------------------------------------------
const MIN_CHARGE_CENTS = 50; // Stripe's smallest card charge
const normCode = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);

// Total uses: paid, plus checkouts started in the last hour (so a limited code can't be
// oversold by several people paying at once). Per-email uses: completed payments only,
// so an abandoned checkout never blocks the same buyer from trying again.
function couponUses(couponId, email = null) {
  const recent = email ? "'9999-12-31'" : "datetime('now', '-1 hour')";
  const orders = db.get(
    `SELECT COUNT(*) AS n FROM package_orders o JOIN users u ON u.id = o.user_id
     WHERE o.coupon_id = ? AND (o.status = 'paid' OR (o.status = 'pending' AND o.created_at >= ${recent}))${email ? ' AND u.email = ?' : ''}`,
    couponId,
    ...(email ? [email] : []),
  ).n;
  const purchases = db.get(
    `SELECT COUNT(*) AS n FROM credit_purchases
     WHERE coupon_id = ? AND (status IN ('paid', 'credited') OR (status = 'pending' AND created_at >= ${recent}))${email ? ' AND email = ?' : ''}`,
    couponId,
    ...(email ? [email] : []),
  ).n;
  return orders + purchases;
}

const couponLabel = (c) => (c.kind === 'fixed' ? `${money(c.amount_cents)} off` : `${c.percent_bps / 100}% off`);

// The price of a package, with an optional coupon code. `error` says why a code doesn't apply.
function quote(pkg, code, { email = null } = {}) {
  const base = { listCents: pkg.price_cents, discountCents: 0, totalCents: pkg.price_cents, coupon: null, code: null, label: null, error: null };
  const c = normCode(code);
  if (!c) return base;
  const fail = (error) => ({ ...base, code: c, error });
  const coupon = db.get('SELECT * FROM coupons WHERE code = ?', c);
  if (!coupon || !coupon.active) return fail('That coupon code isn’t valid.');
  const today = now().slice(0, 10);
  if (coupon.starts_on && today < coupon.starts_on) return fail('That coupon isn’t active yet.');
  if (coupon.ends_on && today > coupon.ends_on) return fail('That coupon has expired.');
  if (coupon.package_id && coupon.package_id !== pkg.id) return fail(`Coupon ${coupon.code} isn’t valid for the ${pkg.name}.`);
  if (coupon.max_redemptions != null && couponUses(coupon.id) >= coupon.max_redemptions) return fail('That coupon has been fully used.');
  if (email && coupon.per_email_limit != null && couponUses(coupon.id, String(email).toLowerCase()) >= coupon.per_email_limit) {
    return fail('That coupon was already used with this email.');
  }
  const discount = Math.min(pkg.price_cents, coupon.kind === 'fixed' ? coupon.amount_cents : Math.round((pkg.price_cents * coupon.percent_bps) / 10000));
  if (discount <= 0) return fail('That coupon doesn’t apply to this package.');
  if (pkg.price_cents - discount < MIN_CHARGE_CENTS) return fail('That coupon can’t be used for this package.');
  return {
    listCents: pkg.price_cents,
    discountCents: discount,
    totalCents: pkg.price_cents - discount,
    coupon,
    code: coupon.code,
    label: couponLabel(coupon),
    forPackage: coupon.package_id ? pkg.name : null,
    error: null,
  };
}

// Packages priced with a code, for the package pages.
function quotePackages(code, { email = null } = {}) {
  const list = packages().map((p) => ({ ...p, quote: quote(p, code, { email }) }));
  const applied = list.find((p) => p.quote.coupon);
  return { packages: list, code: normCode(code) || null, applied: applied ? applied.quote : null, error: normCode(code) && !applied && list[0] ? list[0].quote.error : null };
}

function priced(pkg, code, email) {
  const q = quote(pkg, code, { email });
  if (q.error) throw new credits.CreditError('coupon', q.error, 400);
  return q;
}

function createOrder(userId, packageId, couponCode = null) {
  const pkg = db.get('SELECT * FROM credit_packages WHERE id = ? AND active = 1', Number(packageId) || 0);
  if (!pkg) return null;
  const user = db.get('SELECT email FROM users WHERE id = ?', userId);
  const q = priced(pkg, couponCode, user.email);
  const ref = credits.newRef('order', 'package_orders');
  db.run(
    `INSERT INTO package_orders (ref, user_id, package_id, package_name, price_cents, currency, credits, list_price_cents, discount_cents, coupon_id, coupon_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ref,
    userId,
    pkg.id,
    pkg.name,
    q.totalCents,
    pkg.currency,
    pkg.credits,
    q.listCents,
    q.discountCents,
    q.coupon ? q.coupon.id : null,
    q.code,
  );
  return db.get('SELECT * FROM package_orders WHERE ref = ?', ref);
}

async function startCheckout(order, user) {
  const session = await stripe.createCheckoutSession({
    order,
    email: user.email,
    successUrl: `${config.baseUrl}/office/see-it-cook-it/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${config.baseUrl}/office/see-it-cook-it/packages?canceled=${order.ref}`,
  });
  db.run('UPDATE package_orders SET stripe_session_id = ? WHERE id = ?', session.id, order.id);
  return session.url;
}

// Paid order → inventory batch. Safe to call any number of times (webhook + return page).
function fulfill(orderRef, { sessionId = null, paymentIntent = null } = {}) {
  let created = null;
  const batch = db.txImmediate(() => {
    const order = db.get('SELECT * FROM package_orders WHERE ref = ?', String(orderRef || ''));
    if (!order) return null;
    if (order.status === 'paid') return db.get('SELECT * FROM credit_batches WHERE order_id = ?', order.id);
    if (order.status !== 'pending') return null;
    db.run(
      "UPDATE package_orders SET status = 'paid', paid_at = datetime('now'), stripe_session_id = COALESCE(?, stripe_session_id), stripe_payment_intent = COALESCE(?, stripe_payment_intent) WHERE id = ?",
      sessionId,
      paymentIntent,
      order.id,
    );
    created = credits.addBatch({ userId: order.user_id, credits: order.credits, source: 'purchase', orderId: order.id, note: `${order.package_name} · ${order.ref}` });
    return created;
  });
  if (created) {
    const order = db.get('SELECT o.*, u.email FROM package_orders o JOIN users u ON u.id = o.user_id WHERE o.ref = ?', orderRef);
    sendEmail({
      to: order.email,
      userId: order.user_id,
      subject: 'Your See It. Cook It. credits are ready',
      text: `Hello,\n\nThanks for your purchase of ${order.package_name} (order ${order.ref}). ${order.credits.toLocaleString('en-US')} promotional credits are now in your inventory.\n\nGive them away from your back office: ${config.baseUrl}/office/see-it-cook-it\n\nCredits are promotional and can only be given to creators for free — they can’t be resold.\n\nChew Network`,
    }).catch(() => {});
  }
  return batch;
}

// Return page after Stripe Checkout: confirm with Stripe directly so credits appear
// even if the webhook is delayed.
async function syncReturn(sessionId, userId) {
  const order = db.get('SELECT * FROM package_orders WHERE stripe_session_id = ? AND user_id = ?', String(sessionId || ''), userId);
  if (!order) return { order: null };
  if (order.status === 'pending') {
    const session = await stripe.retrieveSession(sessionId);
    if (session.payment_status === 'paid' && session.client_reference_id === order.ref) {
      fulfill(order.ref, { sessionId: session.id, paymentIntent: session.payment_intent });
    }
  }
  return { order: db.get('SELECT * FROM package_orders WHERE id = ?', order.id) };
}

// ---- Direct purchases ("Buy credits" on the homepage) -----------------------------------
// Anyone can pay by email; an admin then adds the credits to the right affiliate account.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function directPurchaseBlocker() {
  if (!enabled()) return 'Credit packages are not available right now.';
  if (!stripe.configured()) return 'Online payment isn’t available right now. Please use the inquiry form and our team will help.';
  return null;
}

function createPurchase({ email, name, phone = null, packageId, ipHash = null, couponCode = null }) {
  const pkg = db.get('SELECT * FROM credit_packages WHERE id = ? AND active = 1', Number(packageId) || 0);
  if (!pkg) throw new credits.CreditError('invalid_request', 'Choose a package.', 400);
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new credits.CreditError('invalid_request', 'Enter a valid email.', 400);
  if (!name) throw new credits.CreditError('invalid_request', 'Enter your name.', 400);
  const q = priced(pkg, couponCode, email);
  const ref = credits.newRef('purchase', 'credit_purchases');
  db.run(
    `INSERT INTO credit_purchases (ref, email, name, phone, package_id, package_name, price_cents, currency, credits, terms_version, terms_accepted_at, ip_hash,
                                   list_price_cents, discount_cents, coupon_id, coupon_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)`,
    ref,
    email,
    name,
    phone,
    pkg.id,
    pkg.name,
    q.totalCents,
    pkg.currency,
    pkg.credits,
    termsVersion(),
    ipHash,
    q.listCents,
    q.discountCents,
    q.coupon ? q.coupon.id : null,
    q.code,
  );
  return db.get('SELECT * FROM credit_purchases WHERE ref = ?', ref);
}

async function startPurchaseCheckout(purchase) {
  const session = await stripe.createCheckoutSession({
    order: purchase,
    email: purchase.email,
    successUrl: `${config.baseUrl}/buy-credits/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${config.baseUrl}/buy-credits?canceled=1`,
  });
  db.run('UPDATE credit_purchases SET stripe_session_id = ? WHERE id = ?', session.id, purchase.id);
  return session.url;
}

const accountForEmail = (email) =>
  db.get("SELECT id, affiliate_id, first_name, last_name, email, status FROM users WHERE email = ? AND affiliate_id IS NOT NULL", String(email || '').toLowerCase());

// Paid → waiting for an admin to add the credits. Safe to call repeatedly.
function markPurchasePaid(ref, { sessionId = null, paymentIntent = null } = {}) {
  const changed = db.run(
    "UPDATE credit_purchases SET status = 'paid', paid_at = datetime('now'), stripe_session_id = COALESCE(?, stripe_session_id), stripe_payment_intent = COALESCE(?, stripe_payment_intent) WHERE ref = ? AND status = 'pending'",
    sessionId,
    paymentIntent,
    String(ref || ''),
  ).changes;
  const p = db.get('SELECT * FROM credit_purchases WHERE ref = ?', String(ref || ''));
  if (!changed || !p) return p;
  audit(null, 'wholesale.purchase_paid', 'credit_purchase', p.id, { ref: p.ref, email: p.email });
  const account = accountForEmail(p.email);
  sendEmail({
    to: p.email,
    subject: `Payment received — ${p.package_name} (${p.ref})`,
    text: `Hello ${p.name},

Thanks — we received your payment of ${money(p.price_cents, p.currency)}${p.discount_cents ? ` (coupon ${p.coupon_code}: ${money(p.discount_cents, p.currency)} off)` : ''} for ${p.package_name} (${p.credits.toLocaleString('en-US')} See It. Cook It. promotional credits). Your reference is ${p.ref}.

Our team will add the credits to your Chew affiliate account${account ? '' : ' — if you don’t have one yet, join free with this email address: ' + config.baseUrl + '/join'} and email you when they’re ready.

Credits are promotional: you give them to creators for free and they can’t be resold.

Chew Network`,
  }).catch(() => {});
  const to = settings.get('sales_email') || settings.get('support_email');
  if (to) {
    sendEmail({
      to,
      subject: `Credits to add: ${p.ref} (${p.credits.toLocaleString('en-US')} credits)`,
      text: `A direct credit purchase was paid.

Reference: ${p.ref}
Package: ${p.package_name} · ${p.credits.toLocaleString('en-US')} credits · ${money(p.price_cents, p.currency)}
Buyer email: ${p.email}
Affiliate account with this email: ${account ? account.affiliate_id : 'none yet'}

Add the credits: ${config.baseUrl}/admin/wholesale/purchases`,
    }).catch(() => {});
  }
  return p;
}

async function syncPurchase(sessionId) {
  const p = db.get('SELECT * FROM credit_purchases WHERE stripe_session_id = ?', String(sessionId || ''));
  if (!p) return null;
  if (p.status === 'pending') {
    const session = await stripe.retrieveSession(sessionId);
    if (session.payment_status === 'paid' && session.client_reference_id === p.ref) markPurchasePaid(p.ref, { sessionId: session.id, paymentIntent: session.payment_intent });
  }
  return db.get('SELECT * FROM credit_purchases WHERE id = ?', p.id);
}

// Admin: add a paid purchase's credits to an affiliate account (once).
function creditPurchase(purchaseId, { affiliateId, actorId, note = null }) {
  let result;
  db.txImmediate(() => {
    const p = db.get('SELECT * FROM credit_purchases WHERE id = ?', purchaseId);
    if (!p) throw new credits.CreditError('not_found', 'Purchase not found.', 404);
    if (p.status === 'credited') throw new credits.CreditError('already_credited', 'These credits were already added.', 409);
    if (p.status !== 'paid') throw new credits.CreditError('not_paid', 'Only paid purchases can be credited.', 400);
    const u = db.get("SELECT * FROM users WHERE affiliate_id = ? AND status = 'active'", String(affiliateId || '').trim().toUpperCase());
    if (!u) throw new credits.CreditError('no_account', 'Enter the Affiliate ID of an active affiliate.', 400);
    const acct = credits.ensureAccount(u.id);
    // The buyer accepted the Wholesale Terms at checkout.
    if (!acct.attribution_ack_at) {
      db.run("UPDATE wholesale_accounts SET attribution_ack_at = ?, attribution_ack_version = ?, updated_at = datetime('now') WHERE user_id = ?", p.terms_accepted_at, p.terms_version, u.id);
    }
    const batch = credits.addBatch({ userId: u.id, credits: p.credits, source: 'purchase', note: `Direct purchase ${p.ref} · ${p.email}${note ? ' · ' + note : ''}`, actorId });
    db.run(
      "UPDATE credit_purchases SET status = 'credited', credited_user_id = ?, credited_batch_id = ?, credited_by = ?, credited_at = datetime('now'), admin_note = ? WHERE id = ?",
      u.id,
      batch.id,
      actorId,
      note,
      p.id,
    );
    result = { purchase: db.get('SELECT * FROM credit_purchases WHERE id = ?', p.id), user: u, batch };
  });
  sendEmail({
    to: result.user.email,
    userId: result.user.id,
    subject: 'Your See It. Cook It. credits are ready',
    text: `Hi ${result.user.first_name},

${result.batch.credits_total.toLocaleString('en-US')} promotional credits from your purchase ${result.purchase.ref} are now in your inventory.

Give them away from your back office: ${config.baseUrl}/office/see-it-cook-it

Chew Network`,
  }).catch(() => {});
  return result;
}

function handleStripeEvent(evt) {
  const obj = (evt.data && evt.data.object) || {};
  const ref = obj.client_reference_id || (obj.metadata && obj.metadata.order_ref) || '';
  const isPurchase = ref.startsWith('BUY-');
  switch (evt.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (obj.payment_status !== 'paid') return true;
      if (isPurchase) markPurchasePaid(ref, { sessionId: obj.id, paymentIntent: obj.payment_intent });
      else fulfill(ref, { sessionId: obj.id, paymentIntent: obj.payment_intent });
      return true;
    case 'checkout.session.expired':
      db.run("UPDATE package_orders SET status = 'canceled' WHERE stripe_session_id = ? AND status = 'pending'", obj.id);
      db.run("UPDATE credit_purchases SET status = 'canceled' WHERE stripe_session_id = ? AND status = 'pending'", obj.id);
      return true;
    case 'charge.refunded': {
      const purchase = obj.payment_intent && db.get('SELECT * FROM credit_purchases WHERE stripe_payment_intent = ?', obj.payment_intent);
      if (purchase) {
        if (!obj.refunded || !['paid', 'credited'].includes(purchase.status)) {
          audit(null, 'wholesale.purchase_partially_refunded', 'credit_purchase', purchase.id, { ref: purchase.ref, amount_refunded: obj.amount_refunded });
          return true;
        }
        db.run("UPDATE credit_purchases SET status = 'refunded', refunded_at = datetime('now') WHERE id = ?", purchase.id);
        if (purchase.credited_batch_id) credits.reverseBatch(purchase.credited_batch_id, { reason: `Stripe refund · ${purchase.ref}` });
        audit(null, 'wholesale.purchase_refunded', 'credit_purchase', purchase.id, { ref: purchase.ref });
        return true;
      }
      const order = obj.payment_intent && db.get('SELECT * FROM package_orders WHERE stripe_payment_intent = ?', obj.payment_intent);
      if (!order || order.status !== 'paid') return true;
      if (obj.refunded) {
        db.run("UPDATE package_orders SET status = 'refunded', refunded_at = datetime('now') WHERE id = ?", order.id);
        const batch = db.get('SELECT id FROM credit_batches WHERE order_id = ?', order.id);
        if (batch) credits.reverseBatch(batch.id, { reason: `Stripe refund · ${order.ref}` });
        audit(null, 'wholesale.order_refunded', 'package_order', order.id, { ref: order.ref });
      } else {
        audit(null, 'wholesale.order_partially_refunded', 'package_order', order.id, { ref: order.ref, amount_refunded: obj.amount_refunded });
      }
      return true;
    }
    default:
      return false;
  }
}

// ---- App revenue (reported by the app backend) ------------------------------------------------
const CATEGORY_TYPES = { subscription: 'sic_subscription', download: 'sic_download' };
const SUB_STATUSES = ['active', 'trialing', 'past_due', 'canceled', 'none'];

function setSubscription(creator, status, plan = null) {
  db.run(
    "UPDATE creators SET subscription_status = ?, subscription_plan = COALESCE(?, subscription_plan), subscription_updated_at = datetime('now'), last_active_at = datetime('now') WHERE id = ?",
    status,
    plan,
    creator.id,
  );
}

function recordRevenue({ ref, appUserId, category, amountCents, netCents = null, currency = 'USD', plan = null, occurredAt = null }) {
  const type = CATEGORY_TYPES[category];
  if (!type) throw new credits.CreditError('invalid_request', 'category must be "subscription" or "download".', 400);
  if (!ref) throw new credits.CreditError('invalid_request', 'transaction_id is required.', 400);
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new credits.CreditError('invalid_request', 'amount_cents must be a whole number of cents.', 400);
  if (netCents != null && (!Number.isInteger(netCents) || netCents < 0 || netCents > amountCents)) {
    throw new credits.CreditError('invalid_request', 'net_cents must be between 0 and amount_cents.', 400);
  }
  const creator = db.get('SELECT * FROM creators WHERE app_user_id = ?', String(appUserId || ''));
  if (!creator) throw new credits.CreditError('unknown_creator', 'Unknown app_user_id — link the creator first.', 404);
  const attr = credits.attribution(creator.id);
  const result = db.txImmediate(() => {
    const r = recordEvent({
      type,
      affiliateUserId: attr ? attr.affiliate_user_id : null,
      creatorId: creator.id,
      valueCents: netCents ?? amountCents,
      currency: String(currency || 'USD').toUpperCase().slice(0, 3),
      externalId: String(ref).slice(0, 120),
      origin: 'api',
      metadata: { gross_cents: amountCents, net_cents: netCents, plan, occurred_at: occurredAt },
    });
    if (!r.duplicate && type === 'sic_subscription') setSubscription(creator, 'active', plan);
    return r;
  });
  const commissions = db.all('SELECT * FROM commissions WHERE event_id = ?', result.event.id);
  if (!result.duplicate && commissions.length && attr) notify(attr.affiliate_user_id, 'notify_earnings', 'New See It. Cook It. earnings recorded', `New eligible earnings were recorded from ${creator.ref} and are pending review.\n\nSee them in Commissions → See It. Cook It.: ${config.baseUrl}/office/commissions?tab=sic`);
  return { ...result, creator, commissions };
}

// Refund or chargeback: reverse (or claw back) the commissions on the original payment.
function recordRefund({ ref, originalRef, amountCents = null, kind = 'refund', currency = null }) {
  if (!ref || !originalRef) throw new credits.CreditError('invalid_request', 'transaction_id and original_transaction_id are required.', 400);
  if (amountCents != null && (!Number.isInteger(amountCents) || amountCents <= 0)) throw new credits.CreditError('invalid_request', 'amount_cents must be a positive whole number.', 400);
  kind = kind === 'chargeback' ? 'chargeback' : 'refund';
  return db.txImmediate(() => {
    const original = db.get(`SELECT * FROM events WHERE external_id = ? AND type IN (${IN(SIC_REVENUE_TYPES)})`, String(originalRef));
    if (!original) throw new credits.CreditError('not_found', 'Unknown original_transaction_id.', 404);
    const r = recordEvent({
      type: 'sic_refund',
      affiliateUserId: original.affiliate_user_id,
      creatorId: original.creator_id,
      valueCents: amountCents ?? original.value_cents,
      currency: currency || original.currency,
      externalId: String(ref).slice(0, 120),
      origin: 'api',
      metadata: { kind, original_transaction_id: originalRef },
    });
    if (r.duplicate) return { event: r.event, duplicate: true, adjustments: [] };
    const fraction = amountCents == null || !original.value_cents ? 1 : Math.min(1, amountCents / original.value_cents);
    const label = kind === 'chargeback' ? 'Chargeback' : 'Refund';
    const adjustments = [];
    for (const c of db.all('SELECT * FROM commissions WHERE event_id = ? AND amount_cents > 0', original.id)) {
      if (c.status === 'reversed') continue;
      const already = db.get('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM commissions WHERE reversal_of = ?', c.id).n; // ≤ 0
      const left = c.amount_cents + already;
      if (left <= 0) continue;
      const amount = fraction >= 1 ? left : Math.min(left, Math.round(c.amount_cents * fraction));
      if (!amount) continue;
      if (fraction >= 1 && !already && ['pending', 'approved'].includes(c.status)) {
        db.run("UPDATE commissions SET status = 'reversed', note = ?, status_changed_at = datetime('now') WHERE id = ?", `${label} ${ref}`, c.id);
        audit(null, 'commission.reversed', 'commission', c.id, { reason: kind, transaction_id: ref });
        adjustments.push({ id: c.id, reversed: true });
      } else {
        const { lastInsertRowid } = db.run(
          `INSERT INTO commissions (user_id, event_id, rule_id, amount_cents, currency, status, description, basis, reversal_of, note)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          c.user_id,
          r.event.id,
          c.rule_id,
          -amount,
          c.currency,
          `${label} adjustment`,
          `Reverses ${Math.round(fraction * 100)}% of entry #${c.id}`,
          c.id,
          `${label} ${ref}`,
        );
        adjustments.push({ id: lastInsertRowid, reversal_of: c.id, amount_cents: -amount });
      }
    }
    return { event: r.event, duplicate: false, adjustments };
  });
}

// ---- Summaries for the back office --------------------------------------------------------------
function commissionTotals(userId) {
  const out = { pending: 0, approved: 0, paid: 0, reversed: 0 };
  for (const r of db.all(
    `SELECT c.status, SUM(c.amount_cents) AS total FROM commissions c JOIN events e ON e.id = c.event_id
     WHERE c.user_id = ? AND e.type IN (${IN(SIC_COMMISSION_TYPES)}) GROUP BY c.status`,
    userId,
  )) out[r.status] = r.total || 0;
  return out;
}

function creatorCounts(userId) {
  return db.get(
    `SELECT COUNT(*) AS creators, COALESCE(SUM(CASE WHEN c.subscription_status IN ('active','trialing') THEN 1 ELSE 0 END), 0) AS subscribers
     FROM creator_attribution a JOIN creators c ON c.id = a.creator_id WHERE a.affiliate_user_id = ?`,
    userId,
  );
}

function checklist(userId) {
  const acct = credits.account(userId);
  const ack = !!(acct && acct.attribution_ack_at && acct.attribution_ack_version === termsVersion());
  const bought = !!db.get('SELECT 1 FROM credit_batches WHERE user_id = ?', userId);
  const link = !!db.get('SELECT 1 FROM claim_offers WHERE user_id = ?', userId);
  const given = !!db.get('SELECT 1 FROM credit_grants WHERE user_id = ?', userId);
  const trained = !!db.get(
    `SELECT 1 FROM training_progress p JOIN training_lessons l ON l.id = p.lesson_id JOIN training_modules m ON m.id = l.module_id
     WHERE p.user_id = ? AND m.track = 'wholesale' LIMIT 1`,
    userId,
  );
  const steps = [
    { key: 'ack', label: 'Acknowledge the attribution policy', detail: 'One creator, one wholesale affiliate — for the life of the app.', done: ack, href: '/office/see-it-cook-it#policy' },
    { key: 'package', label: 'Get your credit package', detail: 'Your inventory of promotional credits.', done: bought, href: '/office/see-it-cook-it/packages' },
    { key: 'link', label: 'Create a free-credit claim link', detail: 'Share it — creators claim free credits.', done: link, href: '/office/see-it-cook-it#issue' },
    { key: 'give', label: 'Give away your first credits', detail: 'Through a claim or directly to a creator.', done: given, href: '/office/see-it-cook-it#issue' },
    { key: 'train', label: 'Watch the wholesale training', detail: 'Links, giveaways, attribution and earnings.', done: trained, href: '/office/training#track-wholesale' },
  ];
  return { steps, done: steps.filter((s) => s.done).length, total: steps.length, ack };
}

function alerts(userId, inv = credits.inventory(userId)) {
  const out = [];
  const acct = credits.account(userId);
  if (!acct) return out;
  const low = settings.int('sic_low_balance', 0);
  if (acct.status === 'active' && inv.available < low) {
    out.push({ tone: 'warn', text: `Low inventory: ${inv.available.toLocaleString('en-US')} credits available.`, href: '/office/see-it-cook-it/packages', cta: 'Get more credits' });
  }
  if (inv.pending_claims) {
    out.push({ tone: 'info', text: `${inv.pending_claims} claim${inv.pending_claims === 1 ? '' : 's'} waiting for creators to sign in to the app (${inv.pending.toLocaleString('en-US')} credits reserved).`, href: '/office/see-it-cook-it#claims', cta: 'View claims' });
  }
  const list = checklist(userId);
  if (list.done < list.total) {
    const next = list.steps.find((s) => !s.done);
    out.push({ tone: 'info', text: `Promotional setup: ${list.done} of ${list.total} done. Next: ${next.label.toLowerCase()}.`, href: next.href, cta: 'Continue setup' });
  }
  return out;
}

function summary(userId) {
  const acct = credits.account(userId);
  if (!acct) return null;
  const inv = credits.inventory(userId);
  return { account: acct, inventory: inv, ...creatorCounts(userId), commissions: commissionTotals(userId), alerts: alerts(userId, inv) };
}

// ---- My See It. Cook It. users (analytics) --------------------------------------------------------
const ACTIVE_DAYS = 30;

function creatorsReport(userId, f = {}) {
  const where = ['a.affiliate_user_id = ?'];
  const params = [userId];
  if (f.from) {
    where.push('a.assigned_at >= ?');
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    where.push('a.assigned_at <= ?');
    params.push(`${f.to} 23:59:59`);
  }
  if (f.link) {
    where.push('a.link_id = ?');
    params.push(Number(f.link));
  }
  if (f.subscribed === 'yes') where.push("c.subscription_status IN ('active','trialing')");
  if (f.subscribed === 'no') where.push("c.subscription_status NOT IN ('active','trialing')");
  if (f.activity === 'active') where.push(`c.last_active_at >= '${daysAgo(ACTIVE_DAYS)}'`);
  if (f.activity === 'inactive') where.push(`(c.last_active_at IS NULL OR c.last_active_at < '${daysAgo(ACTIVE_DAYS)}')`);
  const rows = db.all(
    `SELECT c.id, c.ref, c.subscription_status, c.subscription_plan, c.last_active_at, a.assigned_at, a.source,
            COALESCE(l.label, l.code) AS link_label, cp.name AS campaign_name, u.affiliate_id,
            (SELECT COUNT(*) FROM credit_grants g WHERE g.creator_id = c.id AND g.user_id = a.affiliate_user_id AND g.status IN ('active','exhausted','revoked')) AS grants,
            (SELECT COALESCE(SUM(g.credits), 0) FROM credit_grants g WHERE g.creator_id = c.id AND g.user_id = a.affiliate_user_id AND g.status IN ('active','exhausted','revoked')) AS granted,
            (SELECT COALESCE(SUM(credits), 0) FROM credit_consumptions WHERE creator_id = c.id AND status = 'consumed') AS used,
            (SELECT COALESCE(SUM(credits_remaining), 0) FROM credit_grants g WHERE g.creator_id = c.id AND g.status = 'active') AS remaining
     FROM creator_attribution a JOIN creators c ON c.id = a.creator_id JOIN users u ON u.id = a.affiliate_user_id
     LEFT JOIN tracked_links l ON l.id = a.link_id LEFT JOIN campaigns cp ON cp.id = a.campaign_id
     WHERE ${where.join(' AND ')} ORDER BY a.assigned_at DESC, c.id DESC`,
    ...params,
  );
  const cost = credits.videoCost();
  const all = db.get(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN c.subscription_status IN ('active','trialing') THEN 1 ELSE 0 END), 0) AS subscribers,
            COALESCE(SUM(CASE WHEN (SELECT COALESCE(SUM(credits_remaining), 0) FROM credit_grants g WHERE g.creator_id = c.id AND g.status = 'active') >= ? THEN 1 ELSE 0 END), 0) AS with_credits,
            COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.creator_id = c.id AND e.type IN (${IN(SIC_REVENUE_TYPES)})) THEN 1 ELSE 0 END), 0) AS conversions
     FROM creator_attribution a JOIN creators c ON c.id = a.creator_id WHERE a.affiliate_user_id = ?`,
    cost,
    userId,
  );
  const consumed = credits.inventory(userId).consumed;
  const exceptions =
    db.get("SELECT COUNT(*) AS n FROM credit_grants WHERE user_id = ? AND status = 'rejected' AND close_reason IN ('assigned_elsewhere','duplicate_claim','unused_credits')", userId).n +
    db.get('SELECT COUNT(*) AS n FROM attribution_transfers WHERE from_user_id = ? OR to_user_id = ?', userId, userId).n;
  return {
    rows: rows.map((r) => ({ ...r, active: !!r.last_active_at && r.last_active_at >= daysAgo(ACTIVE_DAYS) })),
    summary: { ...all, consumed, exceptions },
    links: db.all("SELECT l.id, COALESCE(l.label, l.code) AS label FROM tracked_links l WHERE l.user_id = ? AND l.id IN (SELECT link_id FROM creator_attribution WHERE affiliate_user_id = ?) ORDER BY l.id DESC", userId, userId),
  };
}

// ---- Earnings tab ------------------------------------------------------------------------
const CATEGORY_LABELS = { sic_subscription: 'Subscription', sic_download: 'Watermark-free download', sic_refund: 'Refund / chargeback' };

function commissionRows(userId, status = null) {
  return db.all(
    `SELECT c.*, e.type AS event_type, e.created_at AS event_at, e.external_id, cr.ref AS creator_ref, orig.id AS orig_id
     FROM commissions c JOIN events e ON e.id = c.event_id LEFT JOIN creators cr ON cr.id = e.creator_id
     LEFT JOIN commissions orig ON orig.id = c.reversal_of
     WHERE c.user_id = ? AND e.type IN (${IN(SIC_COMMISSION_TYPES)}) ${status ? 'AND c.status = ?' : ''}
     ORDER BY c.id DESC LIMIT 300`,
    userId,
    ...(status ? [status] : []),
  ).map((c) => ({ ...c, category: CATEGORY_LABELS[c.event_type] || EVENT_TYPES[c.event_type] || c.event_type, reversedBy: c.status === 'reversed' ? c.note : null }));
}

// ---- Notifications --------------------------------------------------------------------------
function notify(userId, pref, subject, text) {
  const acct = credits.account(userId);
  const u = db.get('SELECT email, first_name FROM users WHERE id = ?', userId);
  if (!acct || !u || !acct[pref]) return;
  sendEmail({ to: u.email, userId, subject, text: `Hi ${u.first_name},\n\n${text}\n\nChew Network` }).catch(() => {});
}

function checkLowBalance(userId) {
  const acct = credits.account(userId);
  if (!acct || acct.status !== 'active' || acct.low_balance_notified_at) return;
  const low = settings.int('sic_low_balance', 0);
  const left = credits.available(userId);
  if (left >= low) return;
  db.run("UPDATE wholesale_accounts SET low_balance_notified_at = datetime('now') WHERE user_id = ?", userId);
  notify(userId, 'notify_low_balance', 'Your See It. Cook It. credits are running low', `You have ${left.toLocaleString('en-US')} credits left to give away.\n\nGet more: ${config.baseUrl}/office/see-it-cook-it/packages`);
}

function notifyRedeemed(claims) {
  for (const c of claims.filter((x) => x.ok)) {
    const g = db.get('SELECT g.user_id, g.credits, cr.ref FROM credit_grants g JOIN creators cr ON cr.id = g.creator_id WHERE g.ref = ?', c.grant);
    if (g) notify(g.user_id, 'notify_claims', 'A creator redeemed your free credits', `Creator ${g.ref} signed in to See It. Cook It. and redeemed ${g.credits.toLocaleString('en-US')} free credits. They are now assigned to you.\n\n${config.baseUrl}/office/analytics#sic-users`);
  }
}

module.exports = {
  SIC_COMMISSION_TYPES,
  SUB_STATUSES,
  enabled,
  termsVersion,
  packages,
  quote,
  quotePackages,
  couponUses,
  couponLabel,
  normCode,
  purchaseBlocker,
  acknowledge,
  createOrder,
  startCheckout,
  fulfill,
  syncReturn,
  handleStripeEvent,
  directPurchaseBlocker,
  createPurchase,
  startPurchaseCheckout,
  markPurchasePaid,
  syncPurchase,
  creditPurchase,
  accountForEmail,
  setSubscription,
  recordRevenue,
  recordRefund,
  commissionTotals,
  checklist,
  alerts,
  summary,
  creatorsReport,
  commissionRows,
  checkLowBalance,
  notifyRedeemed,
  moneyFmt: money,
};
