'use strict';
// "My account" for staff: every staff role can change their own name and password.
const router = require('express').Router();
const db = require('../../db');
const audit = require('../../lib/audit');
const { checkPassword, hashPassword, passwordProblem, destroyAllSessions, createSession } = require('../../lib/auth');
const { clampStr } = require('../../lib/util');

function render(req, res, errors = {}, status = 200) {
  res.status(status).page('admin/account', {
    title: 'My account',
    nav: 'account',
    me: db.get('SELECT * FROM users WHERE id = ?', req.user.id),
    errors,
  });
}

router.get('/account', (req, res) => render(req, res));

router.post('/account/profile', (req, res) => {
  const first = clampStr(req.body.first_name, 60);
  const last = clampStr(req.body.last_name, 60);
  const errors = {};
  if (!first) errors.first_name = 'Enter your first name.';
  if (!last) errors.last_name = 'Enter your last name.';
  if (Object.keys(errors).length) return render(req, res, errors, 422);
  db.run("UPDATE users SET first_name = ?, last_name = ?, updated_at = datetime('now') WHERE id = ?", first, last, req.user.id);
  res.flash('success', 'Name saved.');
  res.redirect('/admin/account');
});

router.post('/account/password', (req, res) => {
  if (!checkPassword(String(req.body.current_password || ''), req.user.password_hash)) {
    return render(req, res, { current_password: 'Your current password is incorrect.' }, 422);
  }
  const problem = passwordProblem(req.body.new_password);
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

module.exports = router;
