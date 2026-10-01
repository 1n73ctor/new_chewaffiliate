'use strict';
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { sha256, randomToken, addDays, addMinutes, safeEqual, hmac, now } = require('./util');
const { can, isStaff, STAFF_ROLES } = require('./permissions');

// In production every cookie uses the __Host- prefix: browsers then only accept
// it over HTTPS, for the exact host, so no subdomain can set or overwrite it.
const COOKIE_PREFIX = config.isProd ? '__Host-' : '';
const SESSION_COOKIE = `${COOKIE_PREFIX}chew_sid`;
const CSRF_COOKIE = `${COOKIE_PREFIX}chew_csrf`;
const FLASH_COOKIE = `${COOKIE_PREFIX}chew_flash`;
const MFA_COOKIE = `${COOKIE_PREFIX}chew_mfa`;
const cookieBase = { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/' };

const hashPassword = (pw) => bcrypt.hashSync(String(pw), config.isTest ? 4 : 11);
const checkPassword = (pw, hash) => typeof pw === 'string' && !!hash && bcrypt.compareSync(pw, hash);

// Most-used passwords (and site-specific ones) are always refused.
const COMMON_PASSWORDS = new Set(
  `password password1 password12 password123 password1234 passw0rd p@ssword p@ssw0rd 12345678 123456789 1234567890 0123456789
   87654321 11111111 00000000 12341234 11223344 qwertyui qwerty123 qwertyuiop 1q2w3e4r 1qaz2wsx zaq12wsx asdfghjk
   iloveyou letmein1 welcome1 welcome123 sunshine princess football baseball superman starwars trustno1 whatever
   admin123 administrator changeme changeme1 default1 abc12345 abcd1234 qazwsxedc monkey12 dragon12 master12
   chewnetwork chew1234 chew12345 chewchew chewnetwork1 chewnetwork123 seeitcookit affiliate affiliate1`.split(/\s+/),
);

// opts: { email, staff } — staff accounts need 12+ characters.
function passwordProblem(pw, { email = '', staff = false } = {}) {
  if (typeof pw !== 'string' || !pw) return 'Enter a password.';
  const min = staff ? 12 : 8;
  if (pw.length < min) return `Use at least ${min} characters for your password.`;
  if (pw.length > 200) return 'That password is too long.';
  const lower = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(pw)) return 'That password is too common. Please choose something harder to guess.';
  const e = String(email).toLowerCase();
  if (e && (lower === e || lower === e.split('@')[0])) return 'Don’t use your email address as your password.';
  return null;
}

// Letters (any language), spaces, apostrophes, hyphens and periods only — no
// links or symbols, so names can't be used to inject text into emails.
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}' .\-]{0,59}$/u;
const validName = (s) => NAME_RE.test(String(s || '').trim());

// ---- Account lockout (persists across restarts) --------------------------
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
const isLocked = (user) => !!(user && user.locked_until && user.locked_until > now());
function recordFailedLogin(user) {
  if (!user) return;
  const failed = (user.failed_logins || 0) + 1;
  if (failed >= MAX_FAILED_LOGINS) {
    db.run('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?', addMinutes(LOCK_MINUTES), user.id);
  } else {
    db.run('UPDATE users SET failed_logins = ? WHERE id = ?', failed, user.id);
  }
}
const clearFailedLogins = (userId) => db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', userId);

function createSession(req, res, userId, { remember = false } = {}) {
  const user = db.get('SELECT role FROM users WHERE id = ?', userId);
  const staff = !!user && STAFF_ROLES.includes(user.role);
  // Staff sessions last at most 12 hours; affiliates can stay signed in for 30 days.
  const days = staff ? 0.5 : remember ? 30 : 1;
  const token = randomToken(32);
  db.run(
    'INSERT INTO sessions (id, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    req.ip,
    (req.get('user-agent') || '').slice(0, 300),
    addDays(days),
  );
  const persistent = staff || remember;
  res.cookie(SESSION_COOKIE, token, persistent ? { ...cookieBase, maxAge: days * 86_400_000 } : cookieBase);
}

// ---- Pending two-step sign-in (password OK, code still needed) -------------
function setMfaTicket(res, data) {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + 5 * 60_000 })).toString('base64url');
  res.cookie(MFA_COOKIE, `${payload}.${hmac(`mfa:${payload}`)}`, { ...cookieBase, maxAge: 5 * 60_000 });
}
function readMfaTicket(req) {
  const raw = req.cookies[MFA_COOKIE];
  if (typeof raw !== 'string') return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(`mfa:${payload}`))) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return t.exp > Date.now() ? t : null;
  } catch {
    return null;
  }
}
const clearMfaTicket = (res) => res.clearCookie(MFA_COOKIE, cookieBase);

function destroySession(req, res) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) db.run('DELETE FROM sessions WHERE id = ?', sha256(token));
  res.clearCookie(SESSION_COOKIE, cookieBase);
}

function destroyAllSessions(userId) {
  db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

// Attaches req.user for a valid session; closed / suspended accounts are signed out.
function loadUser(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    const user = db.get(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`,
      sha256(token),
    );
    if (user && (user.status === 'suspended' || user.status === 'closed')) {
      destroySession(req, res);
    } else if (user) {
      req.user = user;
    }
  }
  res.locals.user = req.user || null;
  res.locals.can = (perm) => can(req.user, perm);
  res.locals.isStaff = isStaff(req.user);
  next();
}

// Double-submit CSRF token: an httpOnly cookie that must match a form field / header.
function csrf(req, res, next) {
  let token = req.cookies[CSRF_COOKIE];
  if (!token) {
    token = randomToken(24);
    res.cookie(CSRF_COOKIE, token, cookieBase);
    req.cookies[CSRF_COOKIE] = token;
  }
  res.locals.csrfToken = token;
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const multipart = (req.get('content-type') || '').startsWith('multipart/form-data');
  if (unsafe && !req.path.startsWith('/api/') && !multipart && !csrfValid(req)) return csrfFail(req, res);
  next();
}

function csrfValid(req) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  const cookie = req.cookies[CSRF_COOKIE];
  return !!(sent && cookie && safeEqual(sent, cookie));
}

function csrfFail(req, res) {
  if ((req.get('accept') || '').includes('application/json')) return res.status(403).json({ error: 'csrf' });
  return res.status(403).page('public/message', {
    title: 'Session expired',
    heading: 'Please try that again',
    message: 'Your form session expired. Go back, refresh the page and submit again.',
  });
}

// For multipart routes: call after multer has parsed the body.
function verifyCsrf(req, res, next) {
  if (!csrfValid(req)) return csrfFail(req, res);
  next();
}

function flash(req, res, next) {
  const incoming = req.cookies[FLASH_COOKIE];
  res.locals.flash = Array.isArray(incoming) ? incoming : [];
  if (incoming) res.clearCookie(FLASH_COOKIE, cookieBase);
  const pending = [];
  res.flash = (type, message) => {
    pending.push({ type, message: String(message).slice(0, 500) });
    res.cookie(FLASH_COOKIE, pending, { ...cookieBase, maxAge: 60_000 });
  };
  next();
}

// Where an unfinished signup should continue.
function nextSignupStep(user) {
  if (user.status === 'pending_verification') return '/join/verify';
  if (user.status === 'pending_agreement') return '/join/agreement';
  return null;
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/signin?next=' + encodeURIComponent(req.originalUrl));
  next();
}

// Back office: active account with an Affiliate ID.
function requireAffiliate(req, res, next) {
  if (!req.user) return res.redirect('/signin?next=' + encodeURIComponent(req.originalUrl));
  const step = nextSignupStep(req.user);
  if (step) return res.redirect(step);
  if (!req.user.affiliate_id) {
    if (isStaff(req.user)) return res.redirect('/admin');
    return res.redirect('/signin');
  }
  next();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/signin?next=' + encodeURIComponent(req.originalUrl));
    if (!can(req.user, perm)) {
      return res.status(403).page('admin/forbidden', { layout: isStaff(req.user) ? 'admin' : 'public', title: 'No access' });
    }
    next();
  };
}

module.exports = {
  COOKIE_PREFIX,
  hashPassword,
  checkPassword,
  passwordProblem,
  validName,
  isLocked,
  recordFailedLogin,
  clearFailedLogins,
  setMfaTicket,
  readMfaTicket,
  clearMfaTicket,
  createSession,
  destroySession,
  destroyAllSessions,
  loadUser,
  csrf,
  verifyCsrf,
  flash,
  nextSignupStep,
  requireLogin,
  requireAffiliate,
  requirePerm,
};
