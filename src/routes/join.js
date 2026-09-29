'use strict';
// Free signup flow:
// JOIN FREE → REGISTRATION → EMAIL / PHONE VERIFICATION → AFFILIATE AGREEMENT
//   → ACCOUNT CREATED → AFFILIATE ID → WELCOME → BACK OFFICE
// No payment page. No purchase. Marketing + SMS consent are separate and optional.
const router = require('express').Router();
const db = require('../db');
const config = require('../config');
const settings = require('../lib/settings');
const rateLimit = require('../lib/rateLimit');
const qr = require('../lib/qr');
const { sendEmail, sendSms, smsAvailable } = require('../lib/notify');
const { createSession, destroySession, hashPassword, passwordProblem, nextSignupStep } = require('../lib/auth');
const { readAttribution, generateAffiliateId, recordEvent, primaryLink } = require('../lib/tracking');
const { COUNTRIES, BY_CODE, guessCountry, normalizePhone, validPhone } = require('../lib/countries');
const { HEAR_ABOUT } = require('../lib/constants');
const { sha256, randomDigits, addMinutes, clampStr, now, markdown, parseSql } = require('../lib/util');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_TTL_MIN = 15;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 45;

const codeHash = (userId, code) => sha256(`${config.secret}:${userId}:${code}`);

async function sendCode(user, channel) {
  const code = randomDigits(6);
  db.run("UPDATE verification_codes SET consumed_at = datetime('now') WHERE user_id = ? AND consumed_at IS NULL", user.id);
  db.run('INSERT INTO verification_codes (user_id, channel, code_hash, expires_at) VALUES (?, ?, ?, ?)', user.id, channel, codeHash(user.id, code), addMinutes(CODE_TTL_MIN));
  if (channel === 'sms') {
    return sendSms({ to: user.mobile, userId: user.id, sensitive: true, body: `${code} is your Chew Network verification code. It expires in ${CODE_TTL_MIN} minutes.` });
  }
  return sendEmail({
    to: user.email,
    userId: user.id,
    sensitive: true,
    subject: `${code} is your Chew Network verification code`,
    text: `Hi ${user.first_name},\n\nYour verification code is:\n\n${code}\n\nEnter it on the Chew Network signup page. It expires in ${CODE_TTL_MIN} minutes.\n\nIf you didn’t start signing up, you can ignore this email.`,
  });
}

function referrerFromCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  return db.get("SELECT id, affiliate_id, first_name, last_name FROM users WHERE affiliate_id = ? AND status = 'active'", c);
}

function sponsorDisplay(u) {
  return u ? { affiliate_id: u.affiliate_id, name: `${u.first_name} ${u.last_name.charAt(0)}.` } : null;
}

// Only users part-way through signup may use the step pages.
function requireStep(status) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/join');
    if (req.user.status !== status) return res.redirect(nextSignupStep(req.user) || (req.user.affiliate_id ? '/office' : '/'));
    next();
  };
}

function renderRegister(res, { form, errors = {}, sponsor, status = 200 }) {
  res.status(status).page('join/register', {
    title: 'Join free',
    description: 'Join the Chew Network Affiliate Program free. No purchase required.',
    layout: 'join',
    step: 1,
    form,
    errors,
    sponsor,
    countries: COUNTRIES,
    hearAbout: HEAR_ABOUT,
  });
}

// ---- 1. Registration -------------------------------------------------------
router.get('/', (req, res) => {
  if (req.user) {
    const step = nextSignupStep(req.user);
    if (step) return res.redirect(step);
    return res.redirect(req.user.affiliate_id ? '/office' : '/admin');
  }
  const attr = readAttribution(req);
  const sponsor = attr ? sponsorDisplay(attr.affiliate) : null;
  renderRegister(res, {
    form: { country: guessCountry(req), referral_code: sponsor ? sponsor.affiliate_id : '' },
    sponsor,
  });
});

router.post('/', rateLimit({ windowMs: 3_600_000, max: 15, message: 'Too many sign-up attempts from this network. Please try again later.' }), async (req, res) => {
  const b = req.body;
  const form = {
    first_name: clampStr(b.first_name, 60),
    last_name: clampStr(b.last_name, 60),
    email: clampStr(b.email, 200).toLowerCase(),
    mobile: clampStr(b.mobile, 30),
    country: BY_CODE[b.country] ? b.country : '',
    referral_code: clampStr(b.referral_code, 20).toUpperCase(),
    hear_about: HEAR_ABOUT.includes(b.hear_about) ? b.hear_about : '',
    terms: b.terms === '1',
    marketing_consent: b.marketing_consent === '1',
    sms_consent: b.sms_consent === '1',
  };
  const attr = readAttribution(req);
  const errors = {};
  if (!form.first_name) errors.first_name = 'Enter your first name.';
  if (!form.last_name) errors.last_name = 'Enter your last name.';
  if (!EMAIL_RE.test(form.email)) errors.email = 'Enter a valid email address.';
  if (!form.country) errors.country = 'Choose your country.';
  const mobile = normalizePhone(form.mobile, form.country);
  if (!mobile || !validPhone(mobile)) errors.mobile = 'Enter a valid mobile number.';
  const pwProblem = passwordProblem(b.password);
  if (pwProblem) errors.password = pwProblem;
  if (!form.terms) errors.terms = 'Please accept the Terms of Use and Privacy Policy to create your account.';
  if (form.sms_consent && !mobile) errors.sms_consent = 'Add a mobile number to receive texts.';

  let sponsor = null;
  if (form.referral_code) {
    sponsor = referrerFromCode(form.referral_code);
    if (!sponsor) errors.referral_code = 'We couldn’t find that Affiliate ID. Check it or leave it blank.';
  } else if (attr) {
    sponsor = attr.affiliate;
  }

  const existing = form.email && db.get('SELECT * FROM users WHERE email = ?', form.email);
  if (existing && existing.status !== 'pending_verification') {
    errors.email = 'An account with this email already exists. Sign in or reset your password.';
  }

  if (Object.keys(errors).length) {
    return renderRegister(res, { form, errors, sponsor: attr ? sponsorDisplay(attr.affiliate) : null, status: 422 });
  }

  const clickId = attr && sponsor && attr.affiliate.id === sponsor.id ? attr.clickId : null;
  const ts = now();
  const values = {
    first_name: form.first_name,
    last_name: form.last_name,
    email: form.email,
    mobile,
    country: form.country,
    password_hash: hashPassword(b.password),
    terms_accepted_at: ts,
    marketing_consent: form.marketing_consent ? 1 : 0,
    marketing_consent_at: form.marketing_consent ? ts : null,
    sms_consent: form.sms_consent ? 1 : 0,
    sms_consent_at: form.sms_consent ? ts : null,
    referred_by: sponsor ? sponsor.id : null,
    referral_click_id: clickId,
    signup_source: form.hear_about || (sponsor ? 'Referral' : null),
    signup_ip: req.ip,
  };

  let userId;
  if (existing) {
    // Unverified duplicate: refresh the pending registration and resend the code.
    db.run(
      `UPDATE users SET first_name=@first_name, last_name=@last_name, mobile=@mobile, country=@country, password_hash=@password_hash,
         terms_accepted_at=@terms_accepted_at, marketing_consent=@marketing_consent, marketing_consent_at=@marketing_consent_at,
         sms_consent=@sms_consent, sms_consent_at=@sms_consent_at, referred_by=@referred_by, referral_click_id=@referral_click_id,
         signup_source=@signup_source, signup_ip=@signup_ip, updated_at=datetime('now') WHERE id=@id`,
      { ...values, id: existing.id },
    );
    userId = existing.id;
  } else {
    userId = db.run(
      `INSERT INTO users (first_name, last_name, email, mobile, country, password_hash, terms_accepted_at, marketing_consent,
         marketing_consent_at, sms_consent, sms_consent_at, referred_by, referral_click_id, signup_source, signup_ip)
       VALUES (@first_name, @last_name, @email, @mobile, @country, @password_hash, @terms_accepted_at, @marketing_consent,
         @marketing_consent_at, @sms_consent, @sms_consent_at, @referred_by, @referral_click_id, @signup_source, @signup_ip)`,
      values,
    ).lastInsertRowid;
  }
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  await sendCode(user, 'email');
  createSession(req, res, user.id);
  res.redirect('/join/verify');
});

// ---- 2. Email / phone verification -----------------------------------------
router.get('/verify', requireStep('pending_verification'), (req, res) => {
  const last = db.get('SELECT channel, created_at FROM verification_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1', req.user.id);
  res.page('join/verify', {
    title: 'Verify your account',
    layout: 'join',
    step: 2,
    channel: last ? last.channel : 'email',
    canSms: smsAvailable() && !!req.user.mobile,
    error: null,
  });
});

router.post('/verify', requireStep('pending_verification'), rateLimit({ windowMs: 15 * 60_000, max: 20 }), (req, res) => {
  const code = String(req.body.code || '').replace(/\D/g, '');
  const row = db.get(
    "SELECT * FROM verification_codes WHERE user_id = ? AND consumed_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1",
    req.user.id,
  );
  const fail = (error) =>
    res.status(422).page('join/verify', {
      title: 'Verify your account',
      layout: 'join',
      step: 2,
      channel: row ? row.channel : 'email',
      canSms: smsAvailable() && !!req.user.mobile,
      error,
    });

  if (!row) return fail('That code has expired. Send yourself a new one below.');
  if (row.attempts >= MAX_ATTEMPTS) return fail('Too many incorrect tries. Send yourself a new code below.');
  if (code.length !== 6 || codeHash(req.user.id, code) !== row.code_hash) {
    db.run('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    return fail('That code isn’t right. Check it and try again.');
  }
  db.tx(() => {
    db.run("UPDATE verification_codes SET consumed_at = datetime('now') WHERE id = ?", row.id);
    const col = row.channel === 'sms' ? 'phone_verified_at' : 'email_verified_at';
    db.run(`UPDATE users SET ${col} = datetime('now'), status = 'pending_agreement', updated_at = datetime('now') WHERE id = ?`, req.user.id);
  });
  res.redirect('/join/agreement');
});

router.post('/verify/resend', requireStep('pending_verification'), rateLimit({ windowMs: 3_600_000, max: 10 }), async (req, res) => {
  const channel = req.body.channel === 'sms' && smsAvailable() && req.user.mobile ? 'sms' : 'email';
  const last = db.get('SELECT created_at FROM verification_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1', req.user.id);
  const wait = last ? RESEND_SECONDS - Math.floor((Date.now() - parseSql(last.created_at).getTime()) / 1000) : 0;
  if (wait > 0) {
    res.flash('info', `Please wait ${wait} seconds before requesting another code.`);
  } else {
    await sendCode(req.user, channel);
    res.flash('success', channel === 'sms' ? `We texted a new code to ${maskPhone(req.user.mobile)}.` : `We sent a new code to ${req.user.email}.`);
  }
  res.redirect('/join/verify');
});

// Typo in the email? Remove the unverified registration and start over.
router.post('/restart', requireStep('pending_verification'), (req, res) => {
  const id = req.user.id;
  destroySession(req, res);
  db.run("DELETE FROM users WHERE id = ? AND status = 'pending_verification'", id);
  res.redirect('/join');
});

function maskPhone(p) {
  return p ? p.slice(0, 3) + '•••' + p.slice(-3) : '';
}

// ---- 3. Affiliate agreement -------------------------------------------------
router.get('/agreement', requireStep('pending_agreement'), (req, res) => {
  const page = db.get("SELECT * FROM pages WHERE slug = 'affiliate-agreement'");
  res.page('join/agreement', {
    title: 'Affiliate Agreement',
    layout: 'join',
    step: 3,
    agreementHtml: markdown(page ? page.body : ''),
    version: settings.get('agreement_version'),
    error: null,
  });
});

router.post('/agreement', requireStep('pending_agreement'), async (req, res) => {
  if (req.body.agree !== '1') {
    const page = db.get("SELECT * FROM pages WHERE slug = 'affiliate-agreement'");
    return res.status(422).page('join/agreement', {
      title: 'Affiliate Agreement',
      layout: 'join',
      step: 3,
      agreementHtml: markdown(page ? page.body : ''),
      version: settings.get('agreement_version'),
      error: 'Please tick the box to accept the Affiliate Agreement.',
    });
  }
  // ACCOUNT CREATED → AFFILIATE ID (generated automatically, unique)
  let user;
  db.tx(() => {
    const affiliateId = generateAffiliateId();
    db.run(
      `UPDATE users SET affiliate_id = ?, status = 'active', agreement_version = ?, agreement_accepted_at = datetime('now'),
         agreement_ip = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending_agreement'`,
      affiliateId,
      settings.get('agreement_version'),
      req.ip,
      req.user.id,
    );
    user = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    recordEvent({
      type: 'affiliate_signup',
      affiliateUserId: user.referred_by,
      subjectUserId: user.id,
      clickId: user.referral_click_id,
      metadata: { affiliate_id: user.affiliate_id },
    });
  });
  await sendEmail({
    to: user.email,
    userId: user.id,
    subject: `Welcome to Chew Network — your Affiliate ID is ${user.affiliate_id}`,
    text: `Hi ${user.first_name},\n\nYour Chew Network affiliate account is ready.\n\nAffiliate ID: ${user.affiliate_id}\nYour referral link: ${primaryLink(user)}\n\nOpen your back office: ${config.baseUrl}/office\n\nNext steps:\n1. Download See It. Cook It.\n2. Share Today’s 3 from the Content Kitchen\n3. Complete the Getting Started training\n\nWelcome to the table!\nChew Network`,
  });
  res.redirect('/join/welcome');
});

// ---- 4. Welcome → app download → back office (one continuous flow) ----------
router.get('/welcome', async (req, res) => {
  if (!req.user) return res.redirect('/signin');
  const step = nextSignupStep(req.user);
  if (step) return res.redirect(step);
  if (!req.user.affiliate_id) return res.redirect('/');
  const link = primaryLink(req.user);
  const qrSvg = await qr.svg(link);
  res.page('join/welcome', { title: 'Welcome to Chew', layout: 'join', step: 4, link, qrSvg });
});

module.exports = router;
module.exports.sendCode = sendCode;
