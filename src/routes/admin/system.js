'use strict';
// Settings (copy, app-store URLs, reward config), legal pages, staff, API keys, audit log.
const router = require('express').Router();
const db = require('../../db');
const settings = require('../../lib/settings');
const audit = require('../../lib/audit');
const { requirePerm, hashPassword, destroyAllSessions } = require('../../lib/auth');
const { ROLES, STAFF_ROLES, PERMISSIONS } = require('../../lib/permissions');
const { LEGAL_PAGES } = require('../../lib/constants');
const { sendPasswordReset } = require('../auth');
const { clampStr, randomToken, sha256, paginate } = require('../../lib/util');

// ---- Settings -------------------------------------------------------------------
router.get('/settings', requirePerm('settings.manage'), (req, res) => {
  res.page('admin/settings', { title: 'Settings', nav: 'settings', groups: settings.GROUPS, values: settings.all(), errors: {} });
});

router.post('/settings', requirePerm('settings.manage'), (req, res) => {
  const errors = {};
  const next = {};
  const group = settings.GROUPS.find((g) => g.id === req.body._group);
  for (const f of group ? group.fields : []) {
    let v = req.body[f.key];
    if (f.type === 'checkbox') v = v === '1' ? '1' : '0';
    else v = clampStr(v, f.type === 'textarea' ? 5000 : 500);
    if (f.type === 'url' && v && !/^https:\/\//i.test(v)) errors[f.key] = 'Use a full https:// URL (or leave blank).';
    if (f.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errors[f.key] = 'Enter a valid email.';
    if (f.type === 'number' && (!/^\d+$/.test(v) || Number(v) < 1)) errors[f.key] = 'Enter a whole number.';
    next[f.key] = v;
  }
  if (Object.keys(errors).length) {
    return res.status(422).page('admin/settings', { title: 'Settings', nav: 'settings', groups: settings.GROUPS, values: { ...settings.all(), ...next }, errors });
  }
  const current = settings.all();
  const changed = {};
  for (const [k, v] of Object.entries(next)) {
    if (current[k] !== v) {
      settings.set(k, v, req.user.id);
      changed[k] = { from: current[k], to: v };
    }
  }
  if (Object.keys(changed).length) audit(req, 'settings.update', 'settings', group.id, changed);
  res.flash('success', `${group ? group.title : 'Settings'} saved — live immediately, no deployment needed.`);
  res.redirect(`/admin/settings#${group ? group.id : ''}`);
});

// ---- Legal pages ------------------------------------------------------------------
router.get('/pages', requirePerm('pages.manage'), (req, res) => {
  const pages = db.all(`SELECT p.*, u.first_name AS editor FROM pages p LEFT JOIN users u ON u.id = p.updated_by ORDER BY p.title`);
  res.page('admin/pages', { title: 'Legal pages', nav: 'pages', pages });
});

router.get('/pages/:slug', requirePerm('pages.manage'), (req, res, next) => {
  const page = LEGAL_PAGES.includes(req.params.slug) && db.get('SELECT * FROM pages WHERE slug = ?', req.params.slug);
  if (!page) return next();
  res.page('admin/page-form', { title: `Edit ${page.title}`, nav: 'pages', page, agreementVersion: settings.get('agreement_version') });
});

router.post('/pages/:slug', requirePerm('pages.manage'), (req, res, next) => {
  const page = LEGAL_PAGES.includes(req.params.slug) && db.get('SELECT * FROM pages WHERE slug = ?', req.params.slug);
  if (!page) return next();
  const title = clampStr(req.body.title, 120) || page.title;
  const body = clampStr(req.body.body, 100000);
  const version = clampStr(req.body.version, 40) || page.version;
  db.run("UPDATE pages SET title = ?, body = ?, version = ?, updated_by = ?, updated_at = datetime('now') WHERE slug = ?", title, body, version, req.user.id, page.slug);
  audit(req, 'page.update', 'page', page.slug, { version });
  res.flash('success', page.slug === 'affiliate-agreement' ? 'Saved. If the terms changed, update the agreement version in Settings → Signup.' : 'Page saved.');
  res.redirect(`/admin/pages/${page.slug}`);
});

// ---- Staff & roles --------------------------------------------------------------------
router.get('/staff', requirePerm('staff.manage'), (req, res) => {
  const staff = db.all(`SELECT * FROM users WHERE role != 'affiliate' ORDER BY status = 'active' DESC, role, first_name`);
  res.page('admin/staff', { title: 'Staff & roles', nav: 'staff', staff, roles: ROLES, staffRoles: STAFF_ROLES, permissions: PERMISSIONS, form: {}, errors: {} });
});

router.post('/staff', requirePerm('staff.manage'), async (req, res) => {
  const form = {
    first_name: clampStr(req.body.first_name, 60),
    last_name: clampStr(req.body.last_name, 60),
    email: clampStr(req.body.email, 200).toLowerCase(),
    role: STAFF_ROLES.includes(req.body.role) ? req.body.role : '',
  };
  const errors = {};
  if (!form.first_name) errors.first_name = 'Required.';
  if (!form.last_name) errors.last_name = 'Required.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = 'Enter a valid email.';
  if (!form.role) errors.role = 'Choose a role.';
  const existing = form.email && db.get('SELECT * FROM users WHERE email = ?', form.email);
  if (existing && existing.role !== 'affiliate') errors.email = 'That person already has a staff role.';
  if (Object.keys(errors).length) {
    const staff = db.all(`SELECT * FROM users WHERE role != 'affiliate' ORDER BY role, first_name`);
    return res.status(422).page('admin/staff', { title: 'Staff & roles', nav: 'staff', staff, roles: ROLES, staffRoles: STAFF_ROLES, permissions: PERMISSIONS, form, errors });
  }
  let user;
  if (existing) {
    // Existing affiliate gets a staff role but keeps their Affiliate ID and back office.
    db.run("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?", form.role, existing.id);
    user = db.get('SELECT * FROM users WHERE id = ?', existing.id);
    res.flash('success', `${user.first_name} now has the ${ROLES[form.role].label} role.`);
  } else {
    const { lastInsertRowid } = db.run(
      `INSERT INTO users (first_name, last_name, email, password_hash, role, status, email_verified_at, terms_accepted_at)
       VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
      form.first_name,
      form.last_name,
      form.email,
      hashPassword(randomToken(24)),
      form.role,
    );
    user = db.get('SELECT * FROM users WHERE id = ?', lastInsertRowid);
    await sendPasswordReset(user);
    res.flash('success', `Staff account created. ${user.first_name} has been emailed a link to set a password.`);
  }
  audit(req, 'staff.add', 'user', user.id, { role: form.role });
  res.redirect('/admin/staff');
});

router.post('/staff/:id(\\d+)', requirePerm('staff.manage'), (req, res) => {
  const u = db.get("SELECT * FROM users WHERE id = ? AND role != 'affiliate'", req.params.id);
  const role = req.body.role;
  const status = req.body.status === 'suspended' ? 'suspended' : 'active';
  const admins = db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").n;
  if (!u || !(STAFF_ROLES.includes(role) || (role === 'affiliate' && u.affiliate_id))) {
    res.flash('error', 'Invalid change.');
  } else if (u.id === req.user.id && (role !== u.role || status !== 'active')) {
    res.flash('error', 'You can’t change your own role or status.');
  } else if (u.role === 'admin' && (role !== 'admin' || status !== 'active') && admins <= 1) {
    res.flash('error', 'There must always be at least one active administrator.');
  } else {
    db.run("UPDATE users SET role = ?, status = ?, updated_at = datetime('now') WHERE id = ?", role, status, u.id);
    if (status !== 'active' || role !== u.role) destroyAllSessions(u.id);
    audit(req, 'staff.update', 'user', u.id, { from: { role: u.role, status: u.status }, to: { role, status } });
    res.flash('success', 'Staff member updated.');
  }
  res.redirect('/admin/staff');
});

// ---- API keys -------------------------------------------------------------------------
function renderKeys(res, extra = {}) {
  res.page('admin/api-keys', {
    title: 'API keys',
    nav: 'api',
    keys: db.all('SELECT k.*, u.first_name AS creator FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.revoked_at IS NOT NULL, k.id DESC'),
    newKey: null,
    ...extra,
  });
}

router.get('/api-keys', requirePerm('api.manage'), (req, res) => renderKeys(res));

router.post('/api-keys', requirePerm('api.manage'), (req, res) => {
  const name = clampStr(req.body.name, 80) || 'Integration';
  const key = `chk_${randomToken(30)}`;
  const { lastInsertRowid } = db.run('INSERT INTO api_keys (name, prefix, key_hash, created_by) VALUES (?, ?, ?, ?)', name, key.slice(0, 10), sha256(key), req.user.id);
  audit(req, 'api_key.create', 'api_key', lastInsertRowid, { name });
  // Shown exactly once — only the hash is stored.
  res.set('Cache-Control', 'no-store');
  renderKeys(res, { newKey: { name, key } });
});

router.post('/api-keys/:id(\\d+)/revoke', requirePerm('api.manage'), (req, res) => {
  db.run("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL", req.params.id);
  audit(req, 'api_key.revoke', 'api_key', req.params.id);
  res.flash('success', 'API key revoked.');
  res.redirect('/admin/api-keys');
});

// ---- Audit log -------------------------------------------------------------------------
router.get('/audit', requirePerm('audit.view'), (req, res) => {
  const q = clampStr(req.query.q, 60);
  const w = q ? 'WHERE a.action LIKE ? OR a.target_id = ?' : '';
  const params = q ? [`${q}%`, q] : [];
  const total = db.get(`SELECT COUNT(*) AS n FROM audit_log a ${w}`, ...params).n;
  const pg = paginate(total, req.query.page, 50);
  const rows = db.all(
    `SELECT a.*, u.first_name, u.last_name, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ${w} ORDER BY a.id DESC LIMIT ${pg.perPage} OFFSET ${pg.offset}`,
    ...params,
  );
  res.page('admin/audit', { title: 'Audit log', nav: 'audit', rows, q, pg });
});

module.exports = router;
