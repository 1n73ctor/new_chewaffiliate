'use strict';
const router = require('express').Router();
const db = require('../db');
const config = require('../config');
const rateLimit = require('../lib/rateLimit');
const { sendEmail } = require('../lib/notify');
const totp = require('../lib/totp');
const { isStaff, STAFF_ROLES } = require('../lib/permissions');
const {
  checkPassword, createSession, destroySession, destroyAllSessions, hashPassword, passwordProblem, nextSignupStep,
  isLocked, recordFailedLogin, clearFailedLogins, setMfaTicket, readMfaTicket, clearMfaTicket,
} = require('../lib/auth');
const { randomToken, sha256, addMinutes, safeNext, clampStr } = require('../lib/util');

// Compared against when the email is unknown so response time doesn't reveal which emails exist.
const DUMMY_HASH = hashPassword('not-a-real-password');

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 12, message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });

function homeFor(user) {
  return nextSignupStep(user) || (user.affiliate_id ? '/office' : isStaff(user) ? '/admin' : '/');
}

router.get('/signin', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.page('auth/signin', { title: 'Sign in', next: safeNext(req.query.next, ''), email: '', error: null, layout: 'join' });
});

router.post('/signin', loginLimiter, (req, res) => {
  const email = clampStr(req.body.email, 200).toLowerCase();
  const next = safeNext(req.body.next, '');
  const user = db.get('SELECT * FROM users WHERE email = ?', email);
  const fail = (error) => res.status(401).page('auth/signin', { title: 'Sign in', next, email, error, layout: 'join' });
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (isLocked(user)) {
    checkPassword(password, DUMMY_HASH);
    return fail('Too many failed attempts. Please wait 15 minutes, or reset your password.');
  }
  const passwordOk = checkPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    recordFailedLogin(user);
    return fail('That email and password don’t match an account.');
  }
  if (user.status === 'suspended') return fail('This account is suspended. Please contact support.');
  if (user.status === 'closed') return fail('This account has been closed. Please contact support if this is a mistake.');

  // Two-step sign-in: password is right, now ask for the authenticator code.
  if (user.totp_enabled_at) {
    setMfaTicket(res, { uid: user.id, remember: req.body.remember === '1', next });
    return res.redirect('/signin/code');
  }
  finishSignin(req, res, user, { remember: req.body.remember === '1', next });
});

function finishSignin(req, res, user, { remember, next }) {
  clearFailedLogins(user.id);
  createSession(req, res, user.id, { remember });
  db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", user.id);
  res.redirect(nextSignupStep(user) || next || homeFor(user));
}

const pendingUser = (ticket) => (ticket ? db.get("SELECT * FROM users WHERE id = ? AND status NOT IN ('suspended','closed')", ticket.uid) : null);

router.get('/signin/code', (req, res) => {
  const user = pendingUser(readMfaTicket(req));
  if (!user || !user.totp_enabled_at) return res.redirect('/signin');
  res.page('auth/mfa', { title: 'Two-step sign-in', error: null, layout: 'join' });
});

router.post('/signin/code', rateLimit({ windowMs: 15 * 60_000, max: 10 }), (req, res) => {
  const ticket = readMfaTicket(req);
  const user = pendingUser(ticket);
  if (!user || !user.totp_enabled_at) {
    res.flash('info', 'Your sign-in timed out. Please sign in again.');
    return res.redirect('/signin');
  }
  if (isLocked(user)) {
    clearMfaTicket(res);
    res.flash('error', 'Too many failed attempts. Please wait 15 minutes and sign in again.');
    return res.redirect('/signin');
  }
  const ok = totp.verifyLogin(user, req.body.code);
  if (!ok) {
    recordFailedLogin(user);
    return res.status(401).page('auth/mfa', { title: 'Two-step sign-in', error: 'That code isn’t right, or it was already used. Try the newest code.', layout: 'join' });
  }
  clearMfaTicket(res);
  if (ok === 'recovery') res.flash('info', `You signed in with a recovery code. ${totp.recoveryLeft(user.id)} left — set up a new authenticator in My account if you lost your device.`);
  finishSignin(req, res, user, { remember: ticket.remember, next: safeNext(ticket.next, '') });
});

router.post('/signout', (req, res) => {
  destroySession(req, res);
  res.redirect('/');
});

router.get('/forgot-password', (req, res) => {
  res.page('auth/forgot', { title: 'Reset your password', sent: false, layout: 'join' });
});

router.post('/forgot-password', rateLimit({ windowMs: 3_600_000, max: 6 }), async (req, res) => {
  const email = clampStr(req.body.email, 200).toLowerCase();
  const user = db.get("SELECT * FROM users WHERE email = ? AND status NOT IN ('closed')", email);
  if (user) await sendPasswordReset(user);
  // Same response whether or not the account exists.
  res.page('auth/forgot', { title: 'Check your email', sent: true, layout: 'join' });
});

async function sendPasswordReset(user) {
  const token = randomToken(32);
  db.run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), user.id, addMinutes(60));
  return sendEmail({
    to: user.email,
    userId: user.id,
    sensitive: true,
    subject: 'Reset your Chew Network password',
    // No user-supplied text (like names) in this email: it can be triggered for any address.
    text: `Hello,\n\nUse this link to choose a new Chew Network password. It expires in 60 minutes.\n\n${config.baseUrl}/reset-password/${token}\n\nIf you didn’t ask for this, you can ignore this email — your password won’t change.`,
  });
}

function findReset(token) {
  return db.get(
    "SELECT r.*, u.email, u.role FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > datetime('now')",
    sha256(String(token || '')),
  );
}

router.get('/reset-password/:token', (req, res) => {
  const reset = findReset(req.params.token);
  res.page('auth/reset', { title: 'Choose a new password', valid: !!reset, token: req.params.token, error: null, layout: 'join' });
});

router.post('/reset-password/:token', rateLimit({ windowMs: 3_600_000, max: 20 }), (req, res) => {
  const reset = findReset(req.params.token);
  if (!reset) return res.page('auth/reset', { title: 'Link expired', valid: false, token: '', error: null, layout: 'join' });
  const problem = passwordProblem(req.body.password, { email: reset.email, staff: STAFF_ROLES.includes(reset.role) });
  if (problem) return res.status(422).page('auth/reset', { title: 'Choose a new password', valid: true, token: req.params.token, error: problem, layout: 'join' });
  db.tx(() => {
    db.run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", hashPassword(req.body.password), reset.user_id);
    db.run("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL", reset.user_id);
  });
  destroyAllSessions(reset.user_id);
  clearFailedLogins(reset.user_id);
  res.flash('success', 'Your password has been updated. Please sign in.');
  res.redirect('/signin');
});

module.exports = router;
module.exports.sendPasswordReset = sendPasswordReset;
