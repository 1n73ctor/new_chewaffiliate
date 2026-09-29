'use strict';
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { sha256, randomToken, addDays, safeEqual } = require('./util');
const { can, isStaff } = require('./permissions');

const SESSION_COOKIE = 'chew_sid';
const CSRF_COOKIE = 'chew_csrf';
const FLASH_COOKIE = 'chew_flash';
const cookieBase = { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/' };

const hashPassword = (pw) => bcrypt.hashSync(pw, config.isTest ? 4 : 11);
const checkPassword = (pw, hash) => !!hash && bcrypt.compareSync(pw, hash);

function passwordProblem(pw) {
  if (!pw || pw.length < 8) return 'Use at least 8 characters for your password.';
  if (pw.length > 200) return 'That password is too long.';
  return null;
}

function createSession(req, res, userId, { remember = false } = {}) {
  const token = randomToken(32);
  const days = remember ? 30 : 1;
  db.run(
    'INSERT INTO sessions (id, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    req.ip,
    (req.get('user-agent') || '').slice(0, 300),
    addDays(days),
  );
  // "remember" keeps a persistent cookie; otherwise a browser-session cookie.
  res.cookie(SESSION_COOKIE, token, remember ? { ...cookieBase, maxAge: days * 86_400_000 } : cookieBase);
}

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
  hashPassword,
  checkPassword,
  passwordProblem,
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
