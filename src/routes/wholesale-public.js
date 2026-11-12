'use strict';
// Public See It. Cook It. wholesale pages: the wholesale information page, the
// "Become a Business Affiliate" inquiry form and the free-credit claim page.
// Consumers only ever see a sponsored-credits offer — never the sponsoring affiliate.
const router = require('express').Router();
const db = require('../db');
const config = require('../config');
const settings = require('../lib/settings');
const rateLimit = require('../lib/rateLimit');
const credits = require('../lib/credits');
const wholesale = require('../lib/wholesale');
const { sendEmail } = require('../lib/notify');
const { readAttribution } = require('../lib/tracking');
const { clampStr, ipHash } = require('../lib/util');

const VOLUMES = ['Just getting started', 'Up to 25 creators a month', '25–100 creators a month', '100–500 creators a month', 'More than 500 creators a month'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function wholesalePage(req, res, { form = {}, errors = {}, status = 200 } = {}) {
  res.status(status).page('public/wholesale', {
    title: 'Wholesale Affiliate Program',
    description: 'Grow your own audience by giving away AI cooking credits for See It. Cook It. An optional paid program for Chew affiliates.',
    packages: wholesale.packages(),
    videoCost: credits.videoCost(),
    volumes: VOLUMES,
    form,
    errors,
  });
}

router.get('/wholesale', (req, res) => wholesalePage(req, res));

// "Become a Business Affiliate" — stored as a lead and routed to sales/admin.
router.post('/wholesale/inquiry', rateLimit({ windowMs: 3_600_000, max: 6 }), async (req, res) => {
  const b = req.body;
  const form = {
    name: clampStr(b.name, 120),
    email: clampStr(b.email, 200).toLowerCase(),
    phone: clampStr(b.phone, 40),
    company: clampStr(b.company, 160),
    audience: clampStr(b.audience, 500),
    volume: VOLUMES.includes(b.volume) ? b.volume : '',
    consent: b.consent === '1',
    page: ['home', 'wholesale'].includes(b.page) ? b.page : 'wholesale',
  };
  const errors = {};
  if (!form.name) errors.name = 'Please enter your name.';
  if (!EMAIL_RE.test(form.email)) errors.email = 'Please enter a valid email.';
  if (form.phone.replace(/\D/g, '').length < 7) errors.phone = 'Please enter a phone number.';
  if (!form.audience) errors.audience = 'Tell us about your audience or channel.';
  if (!form.volume) errors.volume = 'Choose an estimate.';
  if (!form.consent) errors.consent = 'Please agree so we can contact you.';
  if (Object.keys(errors).length) return wholesalePage(req, res, { form, errors, status: 422 });

  const attr = readAttribution(req);
  const source = [clampStr(req.query.utm_source || b.utm_source, 60), clampStr(b.s, 40)].filter(Boolean).join(' / ') || (attr ? 'affiliate referral' : 'direct');
  const { lastInsertRowid: id } = db.run(
    `INSERT INTO business_leads (name, email, phone, company, audience, volume, consent_at, lead_source, page, affiliate_user_id, user_id)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)`,
    form.name,
    form.email,
    form.phone,
    form.company || null,
    form.audience,
    form.volume,
    source,
    form.page,
    attr ? attr.affiliate.id : null,
    req.user ? req.user.id : null,
  );
  const to = settings.get('sales_email') || settings.get('support_email');
  if (to) {
    await sendEmail({
      to,
      subject: `New business affiliate inquiry #${id}`,
      text: `A new "Become a Business Affiliate" inquiry was submitted.\n\nOpen it in the admin: ${config.baseUrl}/admin/m/business_leads/${id}`,
    });
  }
  res.flash('success', 'Thanks — our team will be in touch about the Wholesale Affiliate program.');
  res.redirect(form.page === 'home' ? '/#business-affiliate' : '/wholesale#business-affiliate');
});

// ---- Buy credits (direct purchase by email) ---------------------------------------------
function buyPage(res, { form = {}, errors = {}, status = 200, canceled = false } = {}) {
  const priced = wholesale.quotePackages(form.coupon, { email: EMAIL_RE.test(form.email || '') ? form.email : null });
  res.status(status).page('public/buy-credits', {
    title: 'Buy See It. Cook It. credits',
    description: 'Buy promotional credits to give to creators for free. Pay securely with Stripe.',
    packages: priced.packages,
    coupon: priced,
    blocker: wholesale.directPurchaseBlocker(),
    videoCost: credits.videoCost(),
    termsVersion: wholesale.termsVersion(),
    form,
    errors,
    canceled,
  });
}

router.get('/buy-credits', (req, res) => {
  // Signed-in affiliates buy from their back office, where credits arrive automatically.
  const code = wholesale.normCode(req.query.coupon);
  if (req.user && req.user.affiliate_id && req.user.status === 'active') return res.redirect(`/office/see-it-cook-it/packages${code ? `?coupon=${encodeURIComponent(code)}` : ''}`);
  buyPage(res, { canceled: !!req.query.canceled, form: { coupon: code, ...(req.user ? { email: req.user.email, name: `${req.user.first_name} ${req.user.last_name}` } : {}) } });
});

router.post('/buy-credits', rateLimit({ windowMs: 3_600_000, max: 10 }), async (req, res) => {
  const form = {
    name: clampStr(req.body.name, 120),
    email: clampStr(req.body.email, 200).toLowerCase(),
    phone: clampStr(req.body.phone, 40),
    package_id: clampStr(req.body.package_id, 10),
    terms: req.body.terms === '1',
    coupon: wholesale.normCode(req.body.coupon),
  };
  const errors = {};
  if (!form.name) errors.name = 'Please enter your name.';
  if (!EMAIL_RE.test(form.email)) errors.email = 'Please enter the email you use (or will use) for your Chew account.';
  if (!form.terms) errors.terms = 'Please accept the Wholesale Terms to continue.';
  const blocker = wholesale.directPurchaseBlocker();
  if (blocker) errors._ = blocker;
  if (Object.keys(errors).length) return buyPage(res, { form, errors, status: 422 });
  let purchase;
  try {
    purchase = wholesale.createPurchase({ email: form.email, name: form.name, phone: form.phone || null, packageId: form.package_id, ipHash: ipHash(req.ip), couponCode: form.coupon || null });
  } catch (err) {
    if (!(err instanceof credits.CreditError)) throw err;
    return buyPage(res, { form, errors: err.code === 'coupon' ? { coupon: err.message } : { _: err.message }, status: 422 });
  }
  try {
    res.redirect(303, await wholesale.startPurchaseCheckout(purchase));
  } catch (err) {
    console.error('Stripe checkout failed:', err.message);
    db.run("UPDATE credit_purchases SET status = 'failed' WHERE id = ?", purchase.id);
    buyPage(res, { form, errors: { _: 'We couldn’t start the payment. Please try again in a moment.' }, status: 502 });
  }
});

router.get('/buy-credits/thanks', async (req, res) => {
  let purchase = null;
  try {
    purchase = await wholesale.syncPurchase(clampStr(req.query.session_id, 200));
  } catch (err) {
    console.error('Stripe session check failed:', err.message);
  }
  if (!purchase) return res.redirect('/buy-credits');
  res.page('public/buy-credits-thanks', {
    title: 'Thank you',
    noindex: true,
    purchase,
    hasAccount: !!wholesale.accountForEmail(purchase.email),
  });
});

// ---- Free-credit claim page (claim links) ----------------------------------------------
function offerFor(code) {
  const offer = credits.claimOffer(code);
  if (!offer || !offer.active || !offer.link_active || !credits.isWholesaler(offer.user_id)) return null;
  return offer;
}

function claimPage(res, offer, extra = {}) {
  const cost = credits.videoCost();
  res.status(extra.status || 200).page('public/claim', {
    title: 'Free See It. Cook It. credits',
    description: 'Get free sponsored credits to turn a food photo into a cooking video.',
    noindex: true,
    offer,
    videos: Math.floor(offer.credits / cost),
    videoCost: cost,
    email: '',
    error: null,
    grant: null,
    ...extra,
  });
}

const unavailable = (res) =>
  res.status(410).page('public/message', {
    title: 'Offer not available',
    heading: 'This free-credit offer isn’t available',
    message: 'It may have ended or been fully claimed. You can still explore See It. Cook It.',
    actions: [{ href: '/see-it-cook-it', label: 'Explore the app' }],
  });

router.get('/claim/:code', (req, res) => {
  const offer = offerFor(req.params.code);
  if (!offer) return unavailable(res);
  claimPage(res, offer);
});

router.post('/claim/:code', rateLimit({ windowMs: 3_600_000, max: 10 }), async (req, res) => {
  const offer = offerFor(req.params.code);
  if (!offer) return unavailable(res);
  const email = clampStr(req.body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return claimPage(res, offer, { email, error: 'Please enter a valid email.', status: 422 });
  if (req.body.consent !== '1') return claimPage(res, offer, { email, error: 'Please accept the Terms and Privacy Policy to claim.', status: 422 });
  // Keep the click that led here, when it belongs to this offer's affiliate.
  const attr = readAttribution(req);
  const clickId = attr && attr.affiliate.id === offer.user_id ? attr.clickId : null;
  let grant;
  try {
    grant = credits.claim({ offer, email, ipHash: ipHash(req.ip), clickId });
  } catch (err) {
    if (!(err instanceof credits.CreditError)) throw err;
    if (err.status === 410) return unavailable(res);
    return claimPage(res, offer, { email, error: err.message, status: err.status === 429 ? 429 : 409 });
  }
  wholesale.checkLowBalance(offer.user_id);
  await sendEmail({
    to: email,
    sensitive: true,
    subject: 'Your free See It. Cook It. credits',
    text: `Hello,\n\nYour ${grant.credits.toLocaleString('en-US')} free sponsored credits for See It. Cook It. are reserved.\n\n1. Download See It. Cook It.\n2. Sign in with this email address — or enter claim code ${grant.claim_code}\n\nThe claim expires in ${settings.int('sic_claim_expiry_days', 14)} days.\n\nIf you didn’t request this, you can ignore this email.`,
  });
  claimPage(res, offer, { grant, email });
});

module.exports = router;
module.exports.VOLUMES = VOLUMES;
