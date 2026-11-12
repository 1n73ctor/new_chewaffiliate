'use strict';
// Admin: See It. Cook It. wholesale accounts, inventory, creators & attribution,
// credit ledger and reconciliation. View: wholesale.view · Changes: wholesale.manage.
const router = require('express').Router();
const db = require('../../db');
const audit = require('../../lib/audit');
const credits = require('../../lib/credits');
const wholesale = require('../../lib/wholesale');
const stripe = require('../../lib/stripe');
const { requirePerm } = require('../../lib/auth');
const { paginate, clampStr } = require('../../lib/util');

const view = requirePerm('wholesale.view');
const manage = requirePerm('wholesale.manage');

const fail = (req, res, back, err) => {
  if (!(err instanceof credits.CreditError)) throw err;
  res.flash('error', err.message);
  res.redirect(back);
};

router.get('/wholesale', view, (req, res) => {
  const accounts = db.all(
    `SELECT w.*, u.id AS uid, u.affiliate_id, u.first_name, u.last_name, u.email,
       (SELECT COALESCE(SUM(credits_available), 0) FROM credit_batches b WHERE b.user_id = w.user_id AND b.status = 'active') AS available,
       (SELECT COALESCE(SUM(credits_total), 0) FROM credit_batches b WHERE b.user_id = w.user_id) AS purchased,
       (SELECT COUNT(*) FROM creator_attribution a WHERE a.affiliate_user_id = w.user_id) AS creators,
       (SELECT COUNT(*) FROM credit_grants g WHERE g.user_id = w.user_id AND g.status = 'pending') AS pending_claims
     FROM wholesale_accounts w JOIN users u ON u.id = w.user_id ORDER BY w.created_at DESC`,
  );
  res.page('admin/wholesale', {
    title: 'Wholesale & credits',
    nav: 'wholesale',
    accounts,
    totals: db.get(
      `SELECT (SELECT COALESCE(SUM(credits_total), 0) FROM credit_batches) AS purchased,
              (SELECT COALESCE(SUM(credits_available), 0) FROM credit_batches WHERE status = 'active') AS available,
              (SELECT COALESCE(SUM(credits), 0) FROM credit_consumptions WHERE status = 'consumed') AS consumed,
              (SELECT COUNT(*) FROM creators) AS creators,
              (SELECT COUNT(*) FROM creator_attribution) AS assigned,
              (SELECT COUNT(*) FROM credit_grants WHERE status = 'pending') AS pending_claims`,
    ),
    orders: db.all('SELECT o.*, u.affiliate_id FROM package_orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 15'),
    purchasesWaiting: db.get("SELECT COUNT(*) AS n, COALESCE(SUM(credits), 0) AS credits FROM credit_purchases WHERE status = 'paid'"),
    coupons: db.all(
      `SELECT c.*, p.name AS package_name,
         (SELECT COUNT(*) FROM package_orders o WHERE o.coupon_id = c.id AND o.status = 'paid')
           + (SELECT COUNT(*) FROM credit_purchases x WHERE x.coupon_id = c.id AND x.status IN ('paid', 'credited')) AS uses,
         (SELECT COALESCE(SUM(discount_cents), 0) FROM package_orders o WHERE o.coupon_id = c.id AND o.status = 'paid')
           + (SELECT COALESCE(SUM(discount_cents), 0) FROM credit_purchases x WHERE x.coupon_id = c.id AND x.status IN ('paid', 'credited')) AS discount_total
       FROM coupons c LEFT JOIN credit_packages p ON p.id = c.package_id ORDER BY c.active DESC, c.id DESC LIMIT 50`,
    ),
    recon: credits.reconcile(),
    stripeReady: stripe.configured(),
    webhookReady: !!require('../../config').stripe.webhookSecret,
    siteRequests: db.all("SELECT w.*, u.affiliate_id FROM wholesale_accounts w JOIN users u ON u.id = w.user_id WHERE w.site_request_status = 'requested' ORDER BY w.site_requested_at"),
    domains: db.all("SELECT d.*, u.affiliate_id FROM promo_domains d JOIN users u ON u.id = d.user_id ORDER BY d.status = 'verified', d.id DESC LIMIT 30"),
  });
});

function loadAccount(req, res, next) {
  const a = db.get(
    'SELECT w.*, u.id AS uid, u.affiliate_id, u.first_name, u.last_name, u.email, u.status AS user_status FROM wholesale_accounts w JOIN users u ON u.id = w.user_id WHERE w.user_id = ?',
    Number(req.params.userId) || 0,
  );
  if (!a) return next('route');
  req.account = a;
  next();
}

router.get('/wholesale/accounts/:userId(\\d+)', view, loadAccount, (req, res) => {
  const a = req.account;
  res.page('admin/wholesale-account', {
    title: `Wholesale · ${a.affiliate_id}`,
    nav: 'wholesale',
    a,
    inv: credits.inventory(a.user_id),
    batches: db.all('SELECT b.*, o.ref AS order_ref FROM credit_batches b LEFT JOIN package_orders o ON o.id = b.order_id WHERE b.user_id = ? ORDER BY b.id DESC', a.user_id),
    grants: db.all('SELECT g.*, c.ref AS creator_ref FROM credit_grants g LEFT JOIN creators c ON c.id = g.creator_id WHERE g.user_id = ? ORDER BY g.id DESC LIMIT 50', a.user_id),
    creators: wholesale.creatorsReport(a.user_id).rows.slice(0, 50),
    orders: db.all('SELECT * FROM package_orders WHERE user_id = ? ORDER BY id DESC', a.user_id),
    domains: db.all('SELECT * FROM promo_domains WHERE user_id = ? ORDER BY id', a.user_id),
    limits: credits.grantLimits(),
  });
});

const back = (req) => `/admin/wholesale/accounts/${req.account.user_id}`;

// Manual inventory (paid offline, goodwill, correction) — always audited with a note.
router.post('/wholesale/accounts/:userId(\\d+)/credits', manage, loadAccount, (req, res) => {
  const amount = Math.floor(Number(req.body.credits));
  const note = clampStr(req.body.note, 300);
  if (!(amount > 0) || !note) {
    res.flash('error', 'Enter a positive number of credits and a note.');
    return res.redirect(back(req));
  }
  try {
    const b = credits.addBatch({ userId: req.account.user_id, credits: amount, source: 'admin', note, actorId: req.user.id });
    audit(req, 'wholesale.credits_added', 'credit_batch', b.id, { ref: b.ref, credits: amount, note });
    res.flash('success', `Added ${amount.toLocaleString('en-US')} credits (${b.ref}).`);
  } catch (err) {
    return fail(req, res, back(req), err);
  }
  res.redirect(back(req));
});

router.post('/wholesale/accounts/:userId(\\d+)/status', manage, loadAccount, (req, res) => {
  const to = req.body.status === 'suspended' ? 'suspended' : 'active';
  const hasInventory = !!db.get('SELECT 1 FROM credit_batches WHERE user_id = ?', req.account.user_id);
  const status = to === 'active' && !hasInventory ? 'prospect' : to;
  db.run("UPDATE wholesale_accounts SET status = ?, updated_at = datetime('now') WHERE user_id = ?", status, req.account.user_id);
  audit(req, `wholesale.account_${to}`, 'user', req.account.user_id);
  res.flash('success', to === 'suspended' ? 'Wholesale account suspended — no new grants or claims.' : 'Wholesale account reactivated.');
  res.redirect(back(req));
});

// Admin override: give credits even if the creator still has unused credits.
router.post('/wholesale/accounts/:userId(\\d+)/grant', manage, loadAccount, (req, res) => {
  const amount = Math.floor(Number(req.body.credits));
  const reason = clampStr(req.body.reason, 300);
  if (!(amount > 0) || !reason) {
    res.flash('error', 'Enter credits and a reason for the override.');
    return res.redirect(back(req));
  }
  try {
    const g = credits.grantToCreator({ userId: req.account.user_id, creatorRef: req.body.creator, credits: amount, actorId: req.user.id, override: true });
    audit(req, 'wholesale.grant_override', 'credit_grant', g.id, { ref: g.ref, creator: req.body.creator, credits: amount, reason });
    res.flash('success', `Override grant ${g.ref} created.`);
  } catch (err) {
    return fail(req, res, back(req), err);
  }
  res.redirect(back(req));
});

router.post('/wholesale/accounts/:userId(\\d+)/site-request', manage, loadAccount, (req, res) => {
  const status = ['requested', 'in_progress', 'live', 'declined'].includes(req.body.status) ? req.body.status : null;
  if (status) {
    db.run("UPDATE wholesale_accounts SET site_request_status = ?, updated_at = datetime('now') WHERE user_id = ?", status, req.account.user_id);
    audit(req, 'wholesale.site_request_status', 'user', req.account.user_id, { status });
  }
  res.redirect(back(req));
});

router.post('/wholesale/grants/:id(\\d+)/revoke', manage, (req, res) => {
  const g = db.get('SELECT * FROM credit_grants WHERE id = ?', req.params.id);
  const to = g ? `/admin/wholesale/accounts/${g.user_id}` : '/admin/wholesale';
  try {
    const reason = clampStr(req.body.reason, 200) || 'revoked_by_admin';
    credits.revokeGrant(Number(req.params.id), { reason, actorId: req.user.id });
    audit(req, 'wholesale.grant_revoked', 'credit_grant', req.params.id, { reason });
    res.flash('success', 'Grant revoked — unused credits went back to the affiliate’s inventory.');
  } catch (err) {
    return fail(req, res, to, err);
  }
  res.redirect(to);
});

router.post('/wholesale/batches/:id(\\d+)/reverse', manage, (req, res) => {
  const b = db.get('SELECT * FROM credit_batches WHERE id = ?', req.params.id);
  if (!b) return res.redirect('/admin/wholesale');
  const reason = clampStr(req.body.reason, 200);
  if (!reason) {
    res.flash('error', 'A reason is required to reverse a batch.');
    return res.redirect(`/admin/wholesale/accounts/${b.user_id}`);
  }
  credits.reverseBatch(b.id, { reason, actorId: req.user.id });
  audit(req, 'wholesale.batch_reversed', 'credit_batch', b.id, { ref: b.ref, reason });
  res.flash('success', `Batch ${b.ref} reversed — its unissued credits were written off.`);
  res.redirect(`/admin/wholesale/accounts/${b.user_id}`);
});

router.post('/wholesale/domains/:id(\\d+)', manage, (req, res) => {
  const d = db.get('SELECT * FROM promo_domains WHERE id = ?', req.params.id);
  if (d && ['verified', 'rejected', 'pending'].includes(req.body.status)) {
    db.run("UPDATE promo_domains SET status = ?, verified_at = CASE WHEN ? = 'verified' THEN datetime('now') ELSE verified_at END WHERE id = ?", req.body.status, req.body.status, d.id);
    audit(req, `wholesale.domain_${req.body.status}`, 'user', d.user_id, { domain: d.domain });
  }
  res.redirect(d ? `/admin/wholesale/accounts/${d.user_id}` : '/admin/wholesale');
});

// ---- Direct purchases ("Buy credits") ------------------------------------------------------
const PURCHASE_STATUSES = { paid: 'Paid — credits to add', credited: 'Credited', pending: 'Checkout started', refunded: 'Refunded', canceled: 'Canceled', failed: 'Failed' };

router.get('/wholesale/purchases', view, (req, res) => {
  const status = PURCHASE_STATUSES[req.query.status] ? req.query.status : '';
  const q = clampStr(req.query.q, 200).toLowerCase();
  const where = [];
  const params = [];
  if (status) {
    where.push('p.status = ?');
    params.push(status);
  } else {
    where.push("p.status != 'pending' OR p.created_at >= datetime('now', '-1 day')");
  }
  if (q) {
    where.push('(p.email LIKE ? OR p.ref = ? OR p.name LIKE ?)');
    params.push(`%${q}%`, q.toUpperCase(), `%${q}%`);
  }
  const rows = db.all(
    `SELECT p.*, u.affiliate_id AS match_affiliate_id, u.first_name AS match_first, u.last_name AS match_last,
            cu.affiliate_id AS credited_affiliate_id, b.ref AS batch_ref, a.email AS credited_by_email
     FROM credit_purchases p
     LEFT JOIN users u ON u.email = p.email AND u.affiliate_id IS NOT NULL
     LEFT JOIN users cu ON cu.id = p.credited_user_id LEFT JOIN credit_batches b ON b.id = p.credited_batch_id
     LEFT JOIN users a ON a.id = p.credited_by
     WHERE ${where.map((w) => `(${w})`).join(' AND ')}
     ORDER BY CASE p.status WHEN 'paid' THEN 0 ELSE 1 END, p.id DESC LIMIT 200`,
    ...params,
  );
  res.page('admin/wholesale-purchases', {
    title: 'Credit purchases',
    nav: 'wholesale-purchases',
    rows,
    status,
    q,
    statuses: PURCHASE_STATUSES,
    waiting: db.get("SELECT COUNT(*) AS n, COALESCE(SUM(credits), 0) AS credits FROM credit_purchases WHERE status = 'paid'"),
  });
});

router.post('/wholesale/purchases/:id(\\d+)/credit', manage, (req, res) => {
  const backTo = '/admin/wholesale/purchases';
  try {
    const r = wholesale.creditPurchase(Number(req.params.id), { affiliateId: req.body.affiliate_id, actorId: req.user.id, note: clampStr(req.body.note, 200) || null });
    audit(req, 'wholesale.purchase_credited', 'credit_purchase', r.purchase.id, { ref: r.purchase.ref, affiliate: r.user.affiliate_id, credits: r.batch.credits_total });
    res.flash('success', `Added ${r.batch.credits_total.toLocaleString('en-US')} credits to ${r.user.affiliate_id} (${r.purchase.ref}). They were emailed.`);
  } catch (err) {
    return fail(req, res, backTo, err);
  }
  res.redirect(backTo);
});

// ---- Creators & attribution (dispute / transfer) ----------------------------------------
router.get('/wholesale/creators', view, (req, res) => {
  const q = clampStr(req.query.q, 120);
  const rows = db.all(
    `SELECT c.*, a.affiliate_user_id, a.source, a.assigned_at, u.affiliate_id,
       (SELECT COALESCE(SUM(credits_remaining), 0) FROM credit_grants g WHERE g.creator_id = c.id AND g.status = 'active') AS balance
     FROM creators c LEFT JOIN creator_attribution a ON a.creator_id = c.id LEFT JOIN users u ON u.id = a.affiliate_user_id
     ${q ? 'WHERE c.ref = ? OR c.app_user_id = ? OR u.affiliate_id = ?' : ''} ORDER BY c.id DESC LIMIT 100`,
    ...(q ? [q.toUpperCase(), q, q.toUpperCase()] : []),
  );
  res.page('admin/wholesale-creators', { title: 'Creators & attribution', nav: 'wholesale-creators', q, rows });
});

router.get('/wholesale/creators/:id(\\d+)', view, (req, res, next) => {
  const c = db.get('SELECT * FROM creators WHERE id = ?', req.params.id);
  if (!c) return next();
  const attr = credits.attribution(c.id);
  res.page('admin/wholesale-creator', {
    title: `Creator ${c.ref}`,
    nav: 'wholesale-creators',
    c,
    attr,
    affiliate: attr ? db.get('SELECT id, affiliate_id, first_name, last_name FROM users WHERE id = ?', attr.affiliate_user_id) : null,
    balance: credits.creatorBalance(c.id),
    grants: db.all('SELECT g.*, u.affiliate_id FROM credit_grants g JOIN users u ON u.id = g.user_id WHERE g.creator_id = ? OR (g.email_hash IS NOT NULL AND g.email_hash = ?) ORDER BY g.id DESC', c.id, c.email_hash || '-'),
    consumptions: db.all('SELECT * FROM credit_consumptions WHERE creator_id = ? ORDER BY id DESC LIMIT 50', c.id),
    transfers: db.all(
      `SELECT t.*, f.affiliate_id AS from_id, tt.affiliate_id AS to_id, b.email AS by_email FROM attribution_transfers t
       LEFT JOIN users f ON f.id = t.from_user_id JOIN users tt ON tt.id = t.to_user_id LEFT JOIN users b ON b.id = t.by_user_id
       WHERE t.creator_id = ? ORDER BY t.id DESC`,
      c.id,
    ),
    revenue: db.all(`SELECT * FROM events WHERE creator_id = ? AND type IN ('sic_subscription','sic_download','sic_refund') ORDER BY id DESC LIMIT 50`, c.id),
  });
});

router.post('/wholesale/creators/:id(\\d+)/transfer', manage, (req, res) => {
  const to = db.get("SELECT id FROM users WHERE affiliate_id = ? AND status = 'active'", clampStr(req.body.affiliate_id, 20).toUpperCase());
  const backTo = `/admin/wholesale/creators/${req.params.id}`;
  if (!to) {
    res.flash('error', 'Enter the Affiliate ID of an active wholesale affiliate.');
    return res.redirect(backTo);
  }
  try {
    const reason = clampStr(req.body.reason, 500);
    credits.transferCreator(Number(req.params.id), to.id, { reason, by: req.user.id });
    audit(req, 'wholesale.creator_transferred', 'creator', req.params.id, { to: req.body.affiliate_id, reason });
    res.flash('success', 'Creator reassigned. Future credits and earnings go to the new affiliate.');
  } catch (err) {
    return fail(req, res, backTo, err);
  }
  res.redirect(backTo);
});

// ---- Credit ledger -------------------------------------------------------------------------
router.get('/wholesale/ledger', view, (req, res) => {
  const where = [];
  const params = [];
  const aff = clampStr(req.query.affiliate, 20).toUpperCase();
  const type = clampStr(req.query.type, 40);
  if (aff) {
    where.push('u.affiliate_id = ?');
    params.push(aff);
  }
  if (type) {
    where.push('l.type = ?');
    params.push(type);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM credit_ledger l LEFT JOIN users u ON u.id = l.user_id ${w}`, ...params).n;
  const pg = paginate(total, req.query.page, 100);
  res.page('admin/wholesale-ledger', {
    title: 'Credit ledger',
    nav: 'wholesale-ledger',
    aff,
    type,
    pg,
    types: db.all('SELECT DISTINCT type FROM credit_ledger ORDER BY type').map((r) => r.type),
    rows: db.all(
      `SELECT l.*, u.affiliate_id, c.ref AS creator_ref, b.ref AS batch_ref, g.ref AS grant_ref, k.ref AS consumption_ref, a.email AS actor_email
       FROM credit_ledger l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN creators c ON c.id = l.creator_id
       LEFT JOIN credit_batches b ON b.id = l.batch_id LEFT JOIN credit_grants g ON g.id = l.grant_id
       LEFT JOIN credit_consumptions k ON k.id = l.consumption_id LEFT JOIN users a ON a.id = l.actor_id
       ${w} ORDER BY l.id DESC LIMIT ${pg.perPage} OFFSET ${pg.offset}`,
      ...params,
    ),
  });
});

module.exports = router;
