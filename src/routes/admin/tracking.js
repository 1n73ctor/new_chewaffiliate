'use strict';
// WHO → WHAT CONTENT → WHAT SOURCE → WHAT LINK → WHAT PRODUCT → WHAT RESULT
const router = require('express').Router();
const db = require('../../db');
const stats = require('../../lib/stats');
const audit = require('../../lib/audit');
const { requirePerm } = require('../../lib/auth');
const { EVENT_TYPES, SOURCES, sourceLabel, linkUrl } = require('../../lib/tracking');
const { paginate, clampStr } = require('../../lib/util');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function filters(req) {
  const f = {
    view: req.query.view === 'results' ? 'results' : 'clicks',
    from: DATE_RE.test(req.query.from || '') ? req.query.from : '',
    to: DATE_RE.test(req.query.to || '') ? req.query.to : '',
    affiliate: clampStr(req.query.affiliate, 20).toUpperCase(),
    campaign: Number(req.query.campaign) || '',
    content: Number(req.query.content) || '',
    source: SOURCES.some(([k]) => k === req.query.source) ? req.query.source : '',
    destination: clampStr(req.query.destination, 60),
    type: EVENT_TYPES[req.query.type] ? req.query.type : '',
    converted: req.query.converted === '1' ? '1' : '',
    bots: req.query.bots === '1' ? '1' : '',
  };
  const t = f.view === 'clicks' ? 'k' : 'e';
  const where = [];
  const params = [];
  const add = (sql, v) => {
    where.push(sql);
    params.push(v);
  };
  if (f.from) add(`${t}.created_at >= ?`, `${f.from} 00:00:00`);
  if (f.to) add(`${t}.created_at <= ?`, `${f.to} 23:59:59`);
  if (f.affiliate) add('u.affiliate_id = ?', f.affiliate);
  if (f.campaign) add(`${t}.campaign_id = ?`, f.campaign);
  if (f.content) add(`${t}.content_id = ?`, f.content);
  if (f.source) add(`${t}.source = ?`, f.source);
  if (f.destination) add(`${t}.destination_key = ?`, f.destination);
  if (f.view === 'clicks') {
    if (!f.bots) where.push('k.is_bot = 0 AND k.is_self = 0');
    if (f.converted) where.push('EXISTS (SELECT 1 FROM events x WHERE x.click_id = k.click_id)');
  } else {
    if (f.type) add('e.type = ?', f.type);
  }
  return { f, where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

const CLICKS_SQL = (where) => `
  SELECT k.created_at, k.click_id, u.affiliate_id, u.first_name || ' ' || u.last_name AS affiliate_name,
         ca.title AS content, k.source, l.code AS link_code, COALESCE(l.label, CASE WHEN k.link_id IS NULL THEN 'Primary link' END) AS link_label,
         cp.name AS campaign, COALESCE(d.label, k.destination_key) AS destination, k.is_bot, k.is_self,
         (SELECT GROUP_CONCAT(x.type, ', ') FROM events x WHERE x.click_id = k.click_id) AS results
  FROM clicks k JOIN users u ON u.id = k.affiliate_user_id
  LEFT JOIN content_assets ca ON ca.id = k.content_id
  LEFT JOIN campaigns cp ON cp.id = k.campaign_id
  LEFT JOIN tracked_links l ON l.id = k.link_id
  LEFT JOIN destinations d ON d.key = k.destination_key
  ${where} ORDER BY k.id DESC`;

const RESULTS_SQL = (where) => `
  SELECT e.created_at, e.id AS event_id, e.type, u.affiliate_id, u.first_name || ' ' || u.last_name AS affiliate_name,
         ca.title AS content, e.source, l.code AS link_code, l.label AS link_label, cp.name AS campaign,
         COALESCE(d.label, e.destination_key) AS destination, e.value_cents, e.currency, e.origin, e.click_id,
         s.affiliate_id AS subject_affiliate_id
  FROM events e LEFT JOIN users u ON u.id = e.affiliate_user_id
  LEFT JOIN users s ON s.id = e.subject_user_id
  LEFT JOIN content_assets ca ON ca.id = e.content_id
  LEFT JOIN campaigns cp ON cp.id = e.campaign_id
  LEFT JOIN tracked_links l ON l.id = e.link_id
  LEFT JOIN destinations d ON d.key = e.destination_key
  ${where} ORDER BY e.id DESC`;

function csv(rows, cols) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return `"${(/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

router.get('/tracking', requirePerm('tracking.view'), (req, res) => {
  const { f, where, params } = filters(req);
  const sql = f.view === 'clicks' ? CLICKS_SQL(where) : RESULTS_SQL(where);
  const from = f.view === 'clicks' ? 'clicks k JOIN users u ON u.id = k.affiliate_user_id' : 'events e LEFT JOIN users u ON u.id = e.affiliate_user_id';

  if (req.query.format === 'csv') {
    const rows = db.all(`${sql} LIMIT 50000`, ...params);
    audit(req, 'tracking.export', f.view, null, { rows: rows.length });
    const cols =
      f.view === 'clicks'
        ? ['created_at', 'affiliate_id', 'affiliate_name', 'content', 'source', 'link_code', 'link_label', 'campaign', 'destination', 'results', 'click_id', 'is_bot', 'is_self']
        : ['created_at', 'type', 'affiliate_id', 'affiliate_name', 'content', 'source', 'link_code', 'campaign', 'destination', 'value_cents', 'currency', 'origin', 'subject_affiliate_id', 'click_id', 'event_id'];
    res.attachment(`chew-tracking-${f.view}.csv`).type('text/csv');
    return res.send(csv(rows, cols));
  }

  const total = db.get(`SELECT COUNT(*) AS n FROM ${from} ${where}`, ...params).n;
  const pg = paginate(total, req.query.page, 50);
  const rows = db.all(`${sql} LIMIT ${pg.perPage} OFFSET ${pg.offset}`, ...params);
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString();

  res.page('admin/tracking', {
    title: 'Tracking report',
    nav: 'tracking',
    f,
    qs,
    rows,
    pg,
    days,
    summary: stats.summary({}, days),
    series: stats.clicksByDay({}, days),
    bySource: stats.breakdown({}, days, 'source'),
    byContent: stats.breakdown({}, days, 'content'),
    byCampaign: stats.breakdown({}, days, 'campaign'),
    byDestination: stats.breakdown({}, days, 'destination'),
    campaigns: db.all('SELECT id, name FROM campaigns ORDER BY name'),
    contents: db.all('SELECT id, title FROM content_assets ORDER BY title'),
    destinations: db.all('SELECT key, label FROM destinations ORDER BY sort'),
    sources: SOURCES,
    eventTypes: EVENT_TYPES,
    sourceLabel,
  });
});

// ---- All tracked links ---------------------------------------------------------
router.get('/links', requirePerm('campaigns.manage'), (req, res) => {
  const q = clampStr(req.query.q, 40).toUpperCase();
  const where = q ? 'WHERE l.code = ? OR u.affiliate_id = ?' : '';
  const params = q ? [q, q] : [];
  const total = db.get(`SELECT COUNT(*) AS n FROM tracked_links l JOIN users u ON u.id = l.user_id ${where}`, ...params).n;
  const pg = paginate(total, req.query.page, 50);
  const rows = db.all(
    `SELECT l.*, u.affiliate_id, u.first_name, u.last_name, d.label AS destination_label, c.name AS campaign_name, a.title AS content_title,
       (SELECT COUNT(*) FROM clicks k WHERE k.link_id = l.id AND k.is_bot = 0 AND k.is_self = 0) AS clicks
     FROM tracked_links l JOIN users u ON u.id = l.user_id
     LEFT JOIN destinations d ON d.key = l.destination_key
     LEFT JOIN campaigns c ON c.id = l.campaign_id
     LEFT JOIN content_assets a ON a.id = l.content_id
     ${where} ORDER BY l.id DESC LIMIT ${pg.perPage} OFFSET ${pg.offset}`,
    ...params,
  );
  res.page('admin/links', { title: 'Tracked links', nav: 'links', rows: rows.map((l) => ({ ...l, url: linkUrl(l.code) })), q, pg, sourceLabel });
});

router.post('/links/:id(\\d+)/toggle', requirePerm('campaigns.manage'), (req, res) => {
  const l = db.get('SELECT * FROM tracked_links WHERE id = ?', req.params.id);
  if (l) {
    db.run('UPDATE tracked_links SET active = ? WHERE id = ?', l.active ? 0 : 1, l.id);
    audit(req, l.active ? 'link.disable' : 'link.enable', 'tracked_link', l.id, { code: l.code });
    res.flash('success', l.active ? `Link ${l.code} disabled.` : `Link ${l.code} enabled.`);
  }
  res.redirect('/admin/links' + (req.body.q ? `?q=${encodeURIComponent(req.body.q)}` : ''));
});

module.exports = router;
