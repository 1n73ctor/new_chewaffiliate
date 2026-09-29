'use strict';
// Commission ledger. View: commissions.view · Approve / pay / reverse / adjust: commissions.manage.
const router = require('express').Router();
const db = require('../../db');
const audit = require('../../lib/audit');
const { requirePerm } = require('../../lib/auth');
const { COMMISSION_STATUSES } = require('../../lib/constants');
const { EVENT_TYPES } = require('../../lib/tracking');
const { paginate, clampStr } = require('../../lib/util');

const TRANSITIONS = {
  pending: ['approved', 'reversed'],
  approved: ['paid', 'reversed'],
  paid: ['reversed'],
  reversed: [],
};

router.get('/commissions', requirePerm('commissions.view'), (req, res) => {
  const status = COMMISSION_STATUSES[req.query.status] ? req.query.status : '';
  const affiliate = clampStr(req.query.affiliate, 20).toUpperCase();
  const where = [];
  const params = [];
  if (status) {
    where.push('c.status = ?');
    params.push(status);
  }
  if (affiliate) {
    where.push('u.affiliate_id = ?');
    params.push(affiliate);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM commissions c JOIN users u ON u.id = c.user_id ${w}`, ...params).n;
  const pg = paginate(total, req.query.page, 50);
  const rows = db.all(
    `SELECT c.*, u.affiliate_id, u.first_name, u.last_name, e.type AS event_type, e.created_at AS event_at, r.name AS rule_name
     FROM commissions c JOIN users u ON u.id = c.user_id
     LEFT JOIN events e ON e.id = c.event_id LEFT JOIN commission_rules r ON r.id = c.rule_id
     ${w} ORDER BY c.id DESC LIMIT ${pg.perPage} OFFSET ${pg.offset}`,
    ...params,
  );
  const totals = Object.fromEntries(db.all('SELECT status, COUNT(*) AS n, SUM(amount_cents) AS cents FROM commissions GROUP BY status').map((r) => [r.status, r]));
  res.page('admin/commissions', {
    title: 'Commission ledger',
    nav: 'commissions',
    rows,
    pg,
    status,
    affiliate,
    totals,
    transitions: TRANSITIONS,
    eventTypes: EVENT_TYPES,
    activeRules: db.get('SELECT COUNT(*) AS n FROM commission_rules WHERE active = 1').n,
  });
});

function changeStatus(req, ids, to) {
  let changed = 0;
  db.tx(() => {
    for (const id of ids) {
      const c = db.get('SELECT * FROM commissions WHERE id = ?', id);
      if (!c || !TRANSITIONS[c.status].includes(to)) continue;
      db.run("UPDATE commissions SET status = ?, status_changed_by = ?, status_changed_at = datetime('now') WHERE id = ?", to, req.user.id, id);
      audit(req, `commission.${to}`, 'commission', id, { from: c.status, amount_cents: c.amount_cents });
      changed++;
    }
  });
  return changed;
}

router.post('/commissions/status', requirePerm('commissions.manage'), (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const to = req.body.to;
  if (!COMMISSION_STATUSES[to] || !ids.length) {
    res.flash('error', 'Select entries and an action.');
  } else {
    const n = changeStatus(req, ids, to);
    res.flash(n ? 'success' : 'error', n ? `${n} entr${n === 1 ? 'y' : 'ies'} marked ${COMMISSION_STATUSES[to].toLowerCase()}.` : 'None of the selected entries can move to that status.');
  }
  res.redirect('/admin/commissions' + (req.body.back ? `?${new URLSearchParams(req.body.back)}` : ''));
});

// Manual adjustment (bonus, correction or clawback) — always audited, note required.
router.post('/commissions/adjust', requirePerm('commissions.manage'), (req, res) => {
  const a = db.get("SELECT id FROM users WHERE affiliate_id = ? AND role = 'affiliate'", clampStr(req.body.affiliate_id, 20).toUpperCase());
  const cents = Math.round(Number(String(req.body.amount || '').replace(/[^0-9.-]/g, '')) * 100);
  const note = clampStr(req.body.note, 500);
  if (!a || !Number.isFinite(cents) || cents === 0 || !note) {
    res.flash('error', 'Enter a valid Affiliate ID, a non-zero amount and a note.');
    return res.redirect('/admin/commissions');
  }
  const { lastInsertRowid } = db.run(
    `INSERT INTO commissions (user_id, amount_cents, currency, status, description, note, created_by) VALUES (?, ?, ?, 'pending', 'Manual adjustment', ?, ?)`,
    a.id,
    cents,
    clampStr(req.body.currency, 3).toUpperCase() || 'USD',
    note,
    req.user.id,
  );
  audit(req, 'commission.adjustment', 'commission', lastInsertRowid, { affiliate: req.body.affiliate_id, cents, note });
  res.flash('success', 'Adjustment added as Pending.');
  res.redirect('/admin/commissions');
});

module.exports = router;
