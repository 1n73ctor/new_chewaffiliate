'use strict';
// "My account" for staff: every staff role can change their own name and password.
const router = require('express').Router();
const db = require('../../db');
const audit = require('../../lib/audit');
const totp = require('../../lib/totp');
const qr = require('../../lib/qr');
const { checkPassword, hashPassword, passwordProblem, validName, destroyAllSessions, createSession } = require('../../lib/auth');
const { clampStr } = require('../../lib/util');

async function render(req, res, errors = {}, status = 200, extra = {}) {
  const me = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  const pending = !me.totp_enabled_at ? totp.pendingSecret(me) : null;
  res.status(status).page('admin/account', {
    title: 'My account',
    nav: 'account',
    me,
    errors,
    twoStep: {
      enabled: !!me.totp_enabled_at,
      pendingKey: pending ? pending.replace(/(.{4})/g, '$1 ').trim() : null,
      pendingQr: pending ? await qr.svg(totp.otpauthUrl(me.email, pending)) : null,
      recoveryLeft: me.totp_enabled_at ? totp.recoveryLeft(me.id) : 0,
      recoveryCodes: null,
      ...extra,
    },
  });
}

router.get('/account', (req, res) => render(req, res));

router.post('/account/profile', (req, res) => {
  const first = clampStr(req.body.first_name, 60);
  const last = clampStr(req.body.last_name, 60);
  const errors = {};
  if (!validName(first)) errors.first_name = first ? 'Use letters only.' : 'Enter your first name.';
  if (!validName(last)) errors.last_name = last ? 'Use letters only.' : 'Enter your last name.';
  if (Object.keys(errors).length) return render(req, res, errors, 422);
  db.run("UPDATE users SET first_name = ?, last_name = ?, updated_at = datetime('now') WHERE id = ?", first, last, req.user.id);
  res.flash('success', 'Name saved.');
  res.redirect('/admin/account');
});

router.post('/account/password', (req, res) => {
  if (!checkPassword(req.body.current_password, req.user.password_hash)) {
    return render(req, res, { current_password: 'Your current password is incorrect.' }, 422);
  }
  const problem = passwordProblem(req.body.new_password, { email: req.user.email, staff: true });
  if (problem) return render(req, res, { new_password: problem }, 422);
  if (req.body.new_password !== req.body.confirm_password) return render(req, res, { confirm_password: 'The two new passwords don’t match.' }, 422);
  db.run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", hashPassword(req.body.new_password), req.user.id);
  // Sign out every other device, keep this one.
  destroyAllSessions(req.user.id);
  createSession(req, res, req.user.id);
  audit(req, 'staff.password_changed', 'user', req.user.id);
  res.flash('success', 'Password updated. Any other devices have been signed out.');
  res.redirect('/admin/account');
});

// ---- Two-step sign-in (authenticator app) ---------------------------------------
router.post('/account/2fa/start', async (req, res) => {
  if (!req.user.totp_enabled_at) totp.startEnrollment(req.user.id);
  res.redirect('/admin/account#two-step');
});

router.post('/account/2fa/cancel', (req, res) => {
  db.run('UPDATE users SET totp_pending_secret = NULL WHERE id = ?', req.user.id);
  res.redirect('/admin/account#two-step');
});

router.post('/account/2fa/confirm', async (req, res) => {
  const me = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  const codes = totp.confirmEnrollment(me, req.body.code);
  if (!codes) return render(req, res, { totp_code: 'That code didn’t match. Check the time on your phone and try the newest code.' }, 422);
  audit(req, 'staff.2fa_enabled', 'user', req.user.id);
  // Recovery codes are shown exactly once.
  res.set('Cache-Control', 'no-store');
  return render(req, res, {}, 200, { recoveryCodes: codes, justEnabled: true });
});

router.post('/account/2fa/disable', async (req, res) => {
  const me = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!checkPassword(req.body.current_password, me.password_hash)) return render(req, res, { disable: 'Your password is incorrect.' }, 422);
  if (!totp.verifyLogin(me, req.body.code)) return render(req, res, { disable: 'That code isn’t right.' }, 422);
  totp.disable(me.id);
  audit(req, 'staff.2fa_disabled', 'user', req.user.id);
  res.flash('success', 'Two-step sign-in is off. We recommend turning it back on.');
  res.redirect('/admin/account#two-step');
});

module.exports = router;
