'use strict';
// Analytics built only from real tracked rows (clicks, events, commissions).
// Bot/link-preview clicks and an affiliate's own clicks are excluded.
const db = require('../db');
const { daysAgo } = require('./util');
const { QUALIFYING_TYPES, sourceLabel } = require('./tracking');

const QUAL_IN = QUALIFYING_TYPES.map((t) => `'${t}'`).join(',');

// scope: { userId } for one affiliate, {} for the whole program.
function scopeSql(scope, col = 'affiliate_user_id') {
  return scope.userId ? { sql: ` AND ${col} = ?`, params: [scope.userId] } : { sql: '', params: [] };
}

function summary(scope, days) {
  const since = daysAgo(days);
  const s = scopeSql(scope);
  const clicks = db.get(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT visitor_id) AS uniq FROM clicks WHERE is_bot = 0 AND is_self = 0 AND created_at >= ?${s.sql}`,
    since,
    ...s.params,
  );
  const ev = Object.fromEntries(
    db
      .all(`SELECT type, COUNT(*) AS n FROM events WHERE created_at >= ?${s.sql} AND affiliate_user_id IS NOT NULL GROUP BY type`, since, ...s.params)
      .map((r) => [r.type, r.n]),
  );
  const qualifying = QUALIFYING_TYPES.reduce((n, t) => n + (ev[t] || 0), 0);
  const cs = scopeSql(scope, 'user_id');
  const commissions = { pending: 0, approved: 0, paid: 0, reversed: 0 };
  for (const r of db.all(`SELECT status, SUM(amount_cents) AS total FROM commissions WHERE 1 = 1${cs.sql} GROUP BY status`, ...cs.params)) {
    commissions[r.status] = r.total || 0;
  }
  const referralsAll = scope.userId
    ? db.get("SELECT COUNT(*) AS n FROM users WHERE referred_by = ? AND status = 'active'", scope.userId).n
    : db.get("SELECT COUNT(*) AS n FROM users WHERE referred_by IS NOT NULL AND status = 'active'").n;
  return {
    days,
    clicks: clicks.n,
    uniqueVisitors: clicks.uniq,
    signups: ev.affiliate_signup || 0,
    appDownloads: ev.app_download_clicked || 0,
    appLinked: ev.app_account_linked || 0,
    activations: ev.activation_completed || 0,
    qualifying,
    events: ev,
    referralsAll,
    commissions,
  };
}

function clicksByDay(scope, days) {
  const s = scopeSql(scope);
  const rows = db.all(
    `SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM clicks
     WHERE is_bot = 0 AND is_self = 0 AND created_at >= ?${s.sql} GROUP BY d`,
    daysAgo(days - 1).slice(0, 10),
    ...s.params,
  );
  const byDay = Object.fromEntries(rows.map((r) => [r.d, r.n]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = daysAgo(i).slice(0, 10);
    out.push({ date: d, n: byDay[d] || 0 });
  }
  return out;
}

const DIMENSIONS = {
  source: { col: 'source', label: (k) => sourceLabel(k) },
  content: { col: 'content_id', join: 'content_assets', labelCol: 'title' },
  campaign: { col: 'campaign_id', join: 'campaigns', labelCol: 'name' },
  link: { col: 'link_id', join: 'tracked_links', labelCol: "COALESCE(label, code)" },
  destination: { col: 'destination_key' },
};

// Clicks + qualifying results grouped by one tracking dimension.
function breakdown(scope, days, dim) {
  const d = DIMENSIONS[dim];
  if (!d) return [];
  const since = daysAgo(days);
  const s = scopeSql(scope);
  const clicks = db.all(
    `SELECT ${d.col} AS k, COUNT(*) AS clicks, COUNT(DISTINCT visitor_id) AS uniq FROM clicks
     WHERE is_bot = 0 AND is_self = 0 AND created_at >= ?${s.sql} GROUP BY ${d.col}`,
    since,
    ...s.params,
  );
  const results = db.all(
    `SELECT ${d.col} AS k, COUNT(*) AS results FROM events
     WHERE type IN (${QUAL_IN}) AND affiliate_user_id IS NOT NULL AND created_at >= ?${s.sql} GROUP BY ${d.col}`,
    since,
    ...s.params,
  );
  const map = new Map();
  for (const r of clicks) map.set(r.k, { key: r.k, clicks: r.clicks, uniq: r.uniq, results: 0 });
  for (const r of results) {
    const row = map.get(r.k) || { key: r.k, clicks: 0, uniq: 0, results: 0 };
    row.results = r.results;
    map.set(r.k, row);
  }
  const rows = [...map.values()];
  for (const row of rows) {
    if (d.label) row.label = d.label(row.key);
    else if (d.join && row.key != null) {
      const r = db.get(`SELECT ${d.labelCol} AS l FROM ${d.join} WHERE id = ?`, row.key);
      row.label = r ? r.l : `#${row.key}`;
    } else if (dim === 'destination' && row.key) {
      const r = db.get('SELECT label FROM destinations WHERE key = ?', row.key);
      row.label = r ? r.label : row.key;
    } else {
      row.label = { link: 'Primary referral link', source: 'Direct', content: 'No specific content', campaign: 'No campaign', destination: 'Not recorded' }[dim];
    }
  }
  return rows.sort((a, b) => b.clicks - a.clicks || b.results - a.results).slice(0, 20);
}

function recentEvents(scope, limit = 20) {
  const s = scopeSql(scope, 'e.affiliate_user_id');
  return db.all(
    `SELECT e.*, ca.title AS content_title, cp.name AS campaign_name, d.label AS destination_label
     FROM events e
     LEFT JOIN content_assets ca ON ca.id = e.content_id
     LEFT JOIN campaigns cp ON cp.id = e.campaign_id
     LEFT JOIN destinations d ON d.key = e.destination_key
     WHERE e.affiliate_user_id IS NOT NULL${s.sql}
     ORDER BY e.id DESC LIMIT ${Number(limit) | 0}`,
    ...s.params,
  );
}

module.exports = { summary, clicksByDay, breakdown, recentEvents, DIMENSIONS };
