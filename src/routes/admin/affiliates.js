'use strict';
// Affiliate management. Support-level staff (Vanessa) can look people up,
// resend codes, send reset links, verify manually, suspend/reactivate and add
// notes — without developer or finance permissions.
const router = require('express').Router();
const db = require('../../db');
const audit = require('../../lib/audit');
const stats = require('../../lib/stats');
const { requirePerm, destroyAllSessions } = require('../../lib/auth');
const { can } = require('../../lib/permissions');
const { USER_STATUSES } = require('../../lib/constants');
const { paginate, clampStr } = require('../../lib/util');
const { linkUrl, EVENT_TYPES } = require('../../lib/tracking');
const { sendCode } = require('../join');
const { sendPasswordReset } = require('../auth');

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Neutralize spreadsheet formulas and quote everything.
  return `"${(/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`;
}

router.get('/affiliates', requirePerm('affiliates.view'), (req, res) => {
  const q = clampStr(req.query.q, 80);
  const status = USER_STATUSES[req.query.status] ? req.query.status : '';
  const where = ["u.role = 'affiliate'"];
  const params = [];
  if (q) {
    where.push("(u.email LIKE ? OR u.affiliate_id LIKE ? OR u.mobile LIKE ? OR (u.first_name || ' ' || u.last_name) LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status) {
    where.push('u.status = ?');
    params.push(status);
  }
  const whereSql = where.join(' AND ');
  const select = `SELECT u.*, s.affiliate_id AS sponsor_affiliate_id,
      (SELECT COUNT(*) FROM users r WHERE r.referred_by = u.id AND r.status = 'active') AS referrals
    FROM users u LEFT JOIN users s ON s.id = u.referred_by WHERE ${whereSql} ORDER BY u.id DESC`;

  if (req.query.format === 'csv') {
    if (!can(req.user, 'affiliates.manage')) return res.status(403).send('Forbidden');
    const rows = db.all(select, ...params);
    const cols = ['affiliate_id', 'first_name', 'last_name', 'email', 'mobile', 'country', 'status', 'sponsor_affiliate_id', 'referrals', 'marketing_consent', 'sms_consent', 'agreement_version', 'agreement_accepted_at', 'app_activated_at', 'created_at'];
    audit(req, 'affiliates.export', 'users', null, { count: rows.length });
    res.attachment('chew-affiliates.csv').type('text/csv');
    return res.send([cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n'));
  }

  const total = db.get(`SELECT COUNT(*) AS n FROM users u WHERE ${whereSql}`, ...params).n;
  const pg = paginate(total, req.query.page, 30);
  const rows = db.all(`${select} LIMIT ${pg.perPage} OFFSET ${pg.offset}`, ...params);
  const statusCounts = Object.fromEntries(db.all("SELECT status, COUNT(*) AS n FROM users WHERE role = 'affiliate' GROUP BY status").map((r) => [r.status, r.n]));
  res.page('admin/affiliates', { title: 'Affiliates', nav: 'affiliates', rows, q, status, pg, statusCounts });
});

function loadAffiliate(req, res, next) {
  const a = db.get('SELECT * FROM users WHERE id = ?', Number(req.params.id) || 0);
  if (!a) return next('route');
  req.affiliate = a;
  next();
}

router.get('/affiliates/:id(\\d+)', requirePerm('affiliates.view'), loadAffiliate, (req, res) => {
  const a = req.affiliate;
  res.page('admin/affiliate', {
    title: `${a.first_name} ${a.last_name}`,
    nav: 'affiliates',
    a,
    sponsor: a.referred_by ? db.get('SELECT id, first_name, last_name, affiliate_id FROM users WHERE id = ?', a.referred_by) : null,
    referrals: db.all('SELECT id, first_name, last_name, affiliate_id, status, created_at FROM users WHERE referred_by = ? ORDER BY id DESC LIMIT 20', a.id),
    summary: stats.summary({ userId: a.id }, 30),
    links: db.all(
      `SELECT l.*, (SELECT COUNT(*) FROM clicks k WHERE k.link_id = l.id AND k.is_bot = 0 AND k.is_self = 0) AS clicks
       FROM tracked_links l WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 20`,
      a.id,
    ).map((l) => ({ ...l, url: linkUrl(l.code) })),
    events: db.all('SELECT * FROM events WHERE affiliate_user_id = ? OR subject_user_id = ? ORDER BY id DESC LIMIT 20', a.id, a.id),
    commissions: can(req.user, 'commissions.view') ? db.all('SELECT * FROM commissions WHERE user_id = ? ORDER BY id DESC LIMIT 20', a.id) : null,
    messages: db.all('SELECT id, channel, recipient, subject, status, error, created_at FROM outbox WHERE user_id = ? ORDER BY id DESC LIMIT 10', a.id),
    notes: db.all('SELECT n.*, u.first_name AS author FROM affiliate_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.user_id = ? ORDER BY n.id DESC', a.id),
    training: db.get('SELECT COUNT(*) AS n FROM training_progress WHERE user_id = ?', a.id).n,
    eventTypes: EVENT_TYPES,
  });
});

router.post('/affiliates/:id(\\d+)/status', requirePerm('affiliates.status'), loadAffiliate, (req, res) => {
  const a = req.affiliate;
  const to = req.body.status;
  const allowed = can(req.user, 'affiliates.manage') ? ['active', 'suspended', 'closed'] : ['active', 'suspended'];
  if (a.role !== 'affiliate' || !allowed.includes(to)) {
    res.flash('error', 'That status change isn’t allowed.');
  } else if (to === 'active' && !a.affiliate_id) {
    res.flash('error', 'This person hasn’t finished signing up yet (no Affiliate ID), so they can’t be activated. Resend their code or verify them instead.');
  } else {
    db.run("UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?", to, a.id);
    if (to !== 'active') destroyAllSessions(a.id);
    audit(req, 'affiliate.status', 'user', a.id, { from: a.status, to, reason: clampStr(req.body.reason, 300) || null });
    if (req.body.reason) db.run('INSERT INTO affiliate_notes (user_id, author_id, body) VALUES (?, ?, ?)', a.id, req.user.id, `Status → ${to}: ${clampStr(req.body.reason, 300)}`);
    res.flash('success', `Status changed to ${USER_STATUSES[to]}.`);
  }
  res.redirect(`/admin/affiliates/${a.id}`);
});

router.post('/affiliates/:id(\\d+)/resend-code', requirePerm('affiliates.support'), loadAffiliate, async (req, res) => {
  const a = req.affiliate;
  if (a.status !== 'pending_verification') {
    res.flash('error', 'This account is already verified.');
  } else {
    await sendCode(a, req.body.channel === 'sms' && a.mobile ? 'sms' : 'email');
    audit(req, 'affiliate.resend_code', 'user', a.id);
    res.flash('success', 'A new verification code was sent.');
  }
  res.redirect(`/admin/affiliates/${a.id}`);
});

router.post('/affiliates/:id(\\d+)/verify', requirePerm('affiliates.support'), loadAffiliate, (req, res) => {
  const a = req.affiliate;
  if (a.status === 'pending_verification') {
    db.run("UPDATE users SET email_verified_at = datetime('now'), status = 'pending_agreement', updated_at = datetime('now') WHERE id = ?", a.id);
    db.run('INSERT INTO affiliate_notes (user_id, author_id, body) VALUES (?, ?, ?)', a.id, req.user.id, `Email verified manually by support. ${clampStr(req.body.reason, 300)}`.trim());
    audit(req, 'affiliate.manual_verify', 'user', a.id);
    res.flash('success', 'Marked as verified. They’ll be asked to accept the Affiliate Agreement next time they sign in.');
  }
  res.redirect(`/admin/affiliates/${a.id}`);
});

router.post('/affiliates/:id(\\d+)/reset', requirePerm('affiliates.support'), loadAffiliate, async (req, res) => {
  await sendPasswordReset(req.affiliate);
  audit(req, 'affiliate.password_reset_sent', 'user', req.affiliate.id);
  res.flash('success', `Password reset link sent to ${req.affiliate.email}.`);
  res.redirect(`/admin/affiliates/${req.affiliate.id}`);
});

router.post('/affiliates/:id(\\d+)/note', requirePerm('affiliates.support'), loadAffiliate, (req, res) => {
  const body = clampStr(req.body.body, 2000);
  if (body) db.run('INSERT INTO affiliate_notes (user_id, author_id, body) VALUES (?, ?, ?)', req.affiliate.id, req.user.id, body);
  res.redirect(`/admin/affiliates/${req.affiliate.id}#notes`);
});

module.exports = router;
