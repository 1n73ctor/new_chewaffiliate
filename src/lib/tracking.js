'use strict';
// Tracking answers one question for every result:
//   WHO → WHAT CONTENT → WHAT SOURCE → WHAT LINK → WHAT PRODUCT → WHAT RESULT
// Clicks record affiliate_id, campaign_id, content_id, source, destination and time.
// Events (signups, app events, qualifying actions) inherit that attribution
// from the click that led to them and feed the commission rules.
const db = require('../db');
const config = require('../config');
const settings = require('./settings');
const { randomCode, randomToken, hmac, safeEqual, ipHash } = require('./util');

const EVENT_TYPES = {
  affiliate_signup: 'Referred affiliate joined',
  app_download_clicked: 'App download clicked',
  app_account_linked: 'App account linked',
  activation_completed: 'App activation completed',
  qualifying_action: 'Qualifying action',
  purchase: 'Purchase',
  qualified_click: 'Paid click (verified)',
};
// Event types whose commissions add up into one ledger line per affiliate per day.
const DAILY_AGGREGATE_TYPES = ['qualified_click'];
// Activity that counts as "qualifying" in dashboards (clicks never do).
const QUALIFYING_TYPES = ['affiliate_signup', 'app_account_linked', 'activation_completed', 'qualifying_action', 'purchase'];
// Types external systems (the app backend, commerce partners) may report through the API.
const API_EVENT_TYPES = ['app_account_linked', 'activation_completed', 'qualifying_action', 'purchase'];

const SOURCES = [
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['tiktok', 'TikTok'],
  ['youtube', 'YouTube'],
  ['whatsapp', 'WhatsApp'],
  ['sms', 'Text message'],
  ['email', 'Email'],
  ['x', 'X (Twitter)'],
  ['pinterest', 'Pinterest'],
  ['linkedin', 'LinkedIn'],
  ['qr', 'QR code / in person'],
  ['ai-agent', 'AI agent handoff'],
  ['other', 'Other'],
];
const SOURCE_LABELS = Object.fromEntries(SOURCES);
const sourceLabel = (s) => SOURCE_LABELS[s] || (s ? s : 'Direct');
const cleanSource = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40) || null;

const BOT_RE =
  /bot|crawl|spider|slurp|facebookexternalhit|facebot|embedly|preview|whatsapp|telegram|discord|slack|linkedin|twitter|pinterest|skype|vkshare|reddit|headless|lighthouse|curl|wget|python-requests|go-http-client/i;

const COOKIE_PREFIX = config.isProd ? '__Host-' : '';
const ATTR_COOKIE = `${COOKIE_PREFIX}chew_attr`;
const VISITOR_COOKIE = `${COOKIE_PREFIX}chew_vid`;

// ---- IDs --------------------------------------------------------------------
function generateAffiliateId() {
  for (let i = 0; i < 20; i++) {
    const id = 'CHW' + randomCode(6);
    if (!db.get('SELECT 1 FROM users WHERE affiliate_id = ?', id)) return id;
  }
  throw new Error('Could not allocate a unique Affiliate ID');
}

function generateLinkCode() {
  for (let i = 0; i < 20; i++) {
    const code = randomCode(7);
    if (!db.get('SELECT 1 FROM tracked_links WHERE code = ?', code)) return code;
  }
  throw new Error('Could not allocate a unique link code');
}

const primaryLink = (user) => `${config.baseUrl}/a/${user.affiliate_id}`;
const linkUrl = (code) => `${config.baseUrl}/r/${code}`;

// ---- Attribution cookie (signed, last click wins) ---------------------------
function attributionDays() {
  const d = Number(settings.get('attribution_days'));
  return Number.isFinite(d) && d > 0 ? Math.min(d, 365) : 30;
}

function writeAttribution(res, affiliateUserId, clickId) {
  const payload = Buffer.from(JSON.stringify({ a: affiliateUserId, c: clickId, t: Date.now() })).toString('base64url');
  res.cookie(ATTR_COOKIE, `${payload}.${hmac(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: attributionDays() * 86_400_000,
    path: '/',
  });
}

function readAttribution(req) {
  const raw = req.cookies[ATTR_COOKIE];
  if (!raw || typeof raw !== 'string') return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (Date.now() - data.t > attributionDays() * 86_400_000) return null;
    const affiliate = db.get("SELECT * FROM users WHERE id = ? AND status = 'active' AND affiliate_id IS NOT NULL", data.a);
    if (!affiliate) return null;
    return { affiliate, clickId: data.c };
  } catch {
    return null;
  }
}

function visitorId(req, res) {
  let vid = req.cookies[VISITOR_COOKIE];
  if (!vid || typeof vid !== 'string' || vid.length > 40) {
    vid = randomToken(12);
    res.cookie(VISITOR_COOKIE, vid, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 365 * 86_400_000, path: '/' });
  }
  return vid;
}

// ---- Clicks -------------------------------------------------------------------
// ppc: true for shared affiliate links (/a, /r) while a per-click commission rule
// is active — those clicks start "pending" until the browser confirms them.
function recordClick(req, res, { affiliate, link = null, source = null, campaignId = null, contentId = null, destinationKey = null, ppc = false }) {
  const ua = (req.get('user-agent') || '').slice(0, 300);
  const isBot = !ua || BOT_RE.test(ua) ? 1 : 0;
  const isSelf = req.user && req.user.id === affiliate.id ? 1 : 0;
  const clickId = randomToken(12);
  let status = 'ineligible';
  let reason = null;
  if (ppc) {
    status = 'pending';
    if (isBot) [status, reason] = ['rejected', 'bot'];
    else if (isSelf) [status, reason] = ['rejected', 'own_click'];
    else if (!req.get('accept-language')) [status, reason] = ['rejected', 'not_a_browser'];
  }
  db.run(
    `INSERT INTO clicks (click_id, link_id, affiliate_user_id, campaign_id, content_id, source, destination_key,
                         visitor_id, ip_hash, user_agent, referer, is_bot, is_self, status, reject_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    clickId,
    link ? link.id : null,
    affiliate.id,
    campaignId,
    contentId,
    source,
    destinationKey,
    isBot ? null : visitorId(req, res),
    ipHash(req.ip),
    ua,
    (req.get('referer') || '').slice(0, 300) || null,
    isBot,
    isSelf,
    status,
    reason,
  );
  // Link previews and the affiliate's own clicks never overwrite attribution.
  if (!isBot && !isSelf) writeAttribution(res, affiliate.id, clickId);
  return { clickId, isBot, isSelf, status };
}

// ---- Events + commissions ---------------------------------------------------
function recordEvent(e) {
  const ev = {
    type: e.type,
    affiliate_user_id: e.affiliateUserId ?? null,
    subject_user_id: e.subjectUserId ?? null,
    click_id: e.clickId ?? null,
    link_id: null,
    campaign_id: e.campaignId ?? null,
    content_id: e.contentId ?? null,
    source: e.source ?? null,
    destination_key: e.destinationKey ?? null,
    value_cents: e.valueCents ?? null,
    currency: e.currency ?? null,
    external_id: e.externalId ?? null,
    origin: e.origin || 'web',
    metadata: e.metadata ? JSON.stringify(e.metadata).slice(0, 4000) : null,
  };

  if (ev.external_id) {
    const existing = db.get('SELECT * FROM events WHERE type = ? AND external_id = ?', ev.type, ev.external_id);
    if (existing) return { event: existing, duplicate: true };
  }

  // Inherit attribution from the originating click where the caller didn't supply it.
  if (ev.click_id) {
    const c = db.get('SELECT * FROM clicks WHERE click_id = ?', ev.click_id);
    if (c) {
      ev.affiliate_user_id ??= c.affiliate_user_id;
      ev.link_id = c.link_id;
      ev.campaign_id ??= c.campaign_id;
      ev.content_id ??= c.content_id;
      ev.source ??= c.source;
      ev.destination_key ??= c.destination_key;
    } else {
      ev.click_id = null;
    }
  }

  const info = db.run(
    `INSERT INTO events (type, affiliate_user_id, subject_user_id, click_id, link_id, campaign_id, content_id, source,
                         destination_key, value_cents, currency, external_id, origin, metadata)
     VALUES (@type, @affiliate_user_id, @subject_user_id, @click_id, @link_id, @campaign_id, @content_id, @source,
             @destination_key, @value_cents, @currency, @external_id, @origin, @metadata)`,
    ev,
  );
  const event = db.get('SELECT * FROM events WHERE id = ?', info.lastInsertRowid);
  applyCommissionRules(event);
  return { event, duplicate: false };
}

function applyCommissionRules(event) {
  if (!event.affiliate_user_id || event.affiliate_user_id === event.subject_user_id) return [];
  const affiliate = db.get('SELECT id, status FROM users WHERE id = ?', event.affiliate_user_id);
  if (!affiliate || affiliate.status !== 'active') return [];
  const created = [];
  const daily = DAILY_AGGREGATE_TYPES.includes(event.type);
  for (const rule of db.all('SELECT * FROM commission_rules WHERE active = 1 AND event_type = ?', event.type)) {
    const pct = event.value_cents ? Math.round((event.value_cents * rule.percent_bps) / 10000) : 0;
    const amount = rule.amount_cents + pct;
    if (amount <= 0) continue;
    if (daily) {
      // One pending line per affiliate, rule and UTC day: amount and count add up.
      const r = db.run(
        `INSERT INTO commissions (user_id, rule_id, amount_cents, currency, status, description, period, quantity)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, 1)
         ON CONFLICT (user_id, rule_id, period) WHERE period IS NOT NULL AND status = 'pending'
         DO UPDATE SET amount_cents = amount_cents + excluded.amount_cents, quantity = quantity + 1`,
        event.affiliate_user_id,
        rule.id,
        amount,
        rule.currency,
        rule.name,
        String(event.created_at).slice(0, 10),
      );
      if (r.changes) created.push(r.lastInsertRowid);
      continue;
    }
    const r = db.run(
      `INSERT OR IGNORE INTO commissions (user_id, event_id, rule_id, amount_cents, currency, status, description)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      event.affiliate_user_id,
      event.id,
      rule.id,
      amount,
      rule.currency,
      rule.name,
    );
    if (r.changes) created.push(r.lastInsertRowid);
  }
  return created;
}

// ---- Pay-per-click verification -------------------------------------------------
// A click on a shared link earns only after the visitor's browser confirms it
// from the "Opening…" page and it passes every check below.
const ppcActive = () =>
  !!db.get("SELECT 1 FROM commission_rules WHERE active = 1 AND event_type = 'qualified_click' AND amount_cents > 0");

const CONFIRM_MIN_MS = 200;
const CONFIRM_MAX_MS = 10 * 60_000;

function clickToken(clickId) {
  const ts = Date.now();
  return `${clickId}.${ts}.${hmac(`click:${clickId}.${ts}`)}`;
}

function readClickToken(token) {
  const [clickId, ts, sig] = String(token || '').split('.');
  if (!clickId || !/^\d{13}$/.test(ts || '') || !sig || !safeEqual(sig, hmac(`click:${clickId}.${ts}`))) return null;
  return { clickId, ts: Number(ts) };
}

function numSetting(key, fallback) {
  const n = Number(settings.get(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Why a click wasn't paid, in words affiliates and admins can understand.
const REJECT_REASONS = {
  bot: 'Bot or link preview',
  not_a_browser: 'Not a real browser',
  automation: 'Automated browser',
  too_fast: 'Confirmed too fast (automated)',
  expired: 'Never confirmed in time',
  no_cookies: 'Browser check failed',
  changed_browser: 'Browser check failed',
  own_click: 'Your own click',
  own_ip: 'From your own network',
  repeat_visitor: 'Repeat visitor (same IP or device)',
  click_farm: 'Suspicious click volume from this IP',
  daily_cap: 'Daily paid-click limit reached',
  affiliate_inactive: 'Affiliate account not active',
};

function confirmClick(req, { token, webdriver }) {
  const t = readClickToken(token);
  if (!t) return { ok: false, reason: 'bad_token' };
  return db.tx(() => {
    const click = db.get('SELECT * FROM clicks WHERE click_id = ?', t.clickId);
    if (!click || click.status !== 'pending') return { ok: false, reason: 'not_pending' };
    const reject = (reason) => {
      db.run("UPDATE clicks SET status = 'rejected', reject_reason = ?, confirmed_at = datetime('now') WHERE id = ?", reason, click.id);
      return { ok: false, reason };
    };
    const age = Date.now() - t.ts;
    if (age < CONFIRM_MIN_MS) return reject('too_fast');
    if (age > CONFIRM_MAX_MS) return reject('expired');
    if (webdriver === true) return reject('automation');
    if (!click.visitor_id || req.cookies[VISITOR_COOKIE] !== click.visitor_id) return reject('no_cookies');
    if ((req.get('user-agent') || '').slice(0, 300) !== click.user_agent) return reject('changed_browser');

    const affiliate = db.get('SELECT id, status, signup_ip FROM users WHERE id = ?', click.affiliate_user_id);
    if (!affiliate || affiliate.status !== 'active') return reject('affiliate_inactive');
    if (req.user && req.user.id === affiliate.id) return reject('own_click');
    // Any network the affiliate has signed up or signed in from.
    const own = db.get('SELECT 1 FROM login_ips WHERE user_id = ? AND ip_hash = ?', affiliate.id, click.ip_hash);
    if (own || (affiliate.signup_ip && ipHash(affiliate.signup_ip) === click.ip_hash)) return reject('own_ip');

    const window = `-${numSetting('ppc_unique_hours', 24)} hours`;
    const repeat = db.get(
      `SELECT 1 FROM clicks WHERE affiliate_user_id = ? AND status = 'qualified' AND (ip_hash = ? OR visitor_id = ?)
         AND created_at >= datetime('now', ?) LIMIT 1`,
      affiliate.id,
      click.ip_hash,
      click.visitor_id,
      window,
    );
    if (repeat) return reject('repeat_visitor');
    const ipHour = db.get("SELECT COUNT(*) AS n FROM clicks WHERE ip_hash = ? AND created_at >= datetime('now', '-1 hour')", click.ip_hash).n;
    if (ipHour > numSetting('ppc_ip_hourly_limit', 60)) return reject('click_farm');
    const today = db.get("SELECT COUNT(*) AS n FROM clicks WHERE affiliate_user_id = ? AND status = 'qualified' AND created_at >= date('now')", affiliate.id).n;
    if (today >= numSetting('ppc_daily_cap', 500)) return reject('daily_cap');

    db.run("UPDATE clicks SET status = 'qualified', reject_reason = NULL, confirmed_at = datetime('now') WHERE id = ?", click.id);
    recordEvent({
      type: 'qualified_click',
      affiliateUserId: affiliate.id,
      clickId: click.click_id,
      externalId: `click:${click.click_id}`,
    });
    return { ok: true };
  });
}

// Clicks whose browser never confirmed them (no JavaScript, closed the tab…)
// become "expired" — tracked, never paid.
function expireStaleClicks() {
  return db.run(
    "UPDATE clicks SET status = 'rejected', reject_reason = 'expired' WHERE status = 'pending' AND created_at < datetime('now', '-15 minutes')",
  ).changes;
}

// ---- Destinations & app stores ---------------------------------------------
const getDestination = (key) => db.get('SELECT * FROM destinations WHERE key = ? AND active = 1', key);

function detectPlatform(req) {
  const ua = req.get('user-agent') || '';
  if (/iPhone|iPad|iPod|Macintosh.*Mobile/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return null;
}

function appStoreUrl(platform, { affiliateId = null, clickId = null } = {}) {
  const s = settings.all();
  const base = platform === 'ios' ? s.app_store_url_ios : platform === 'android' ? s.app_store_url_android : '';
  if (!base) return null;
  let url;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (s.app_attribution_params === '1' && affiliateId) {
    if (platform === 'ios') {
      url.searchParams.set('ct', [affiliateId, clickId].filter(Boolean).join('.').slice(0, 40));
      if (s.app_ios_provider_token) url.searchParams.set('pt', s.app_ios_provider_token);
    } else {
      const ref = new URLSearchParams({ utm_source: 'chew_affiliate', utm_campaign: affiliateId });
      if (clickId) ref.set('click_id', clickId);
      url.searchParams.set('referrer', ref.toString());
    }
  }
  return url.toString();
}

// Records app_download_clicked and returns the store URL (or a fallback page).
function trackAppDownload(req, res, platform, attribution = {}) {
  const resolved = platform === 'auto' ? detectPlatform(req) : platform;
  const attr = attribution.affiliate ? attribution : readAttribution(req) || {};
  let affiliateUserId = attr.affiliate ? attr.affiliate.id : null;
  let clickId = attr.clickId || null;
  // Signed-in affiliates downloading for themselves are credited to their sponsor.
  if (req.user && (!affiliateUserId || affiliateUserId === req.user.id)) {
    affiliateUserId = req.user.referred_by || null;
    clickId = null;
  }
  const affiliate = affiliateUserId ? db.get('SELECT affiliate_id FROM users WHERE id = ?', affiliateUserId) : null;
  if (!BOT_RE.test(req.get('user-agent') || '')) {
    recordEvent({
      type: 'app_download_clicked',
      affiliateUserId,
      subjectUserId: req.user ? req.user.id : null,
      clickId,
      destinationKey: resolved ? `app-${resolved}` : 'app',
      metadata: { platform: resolved || 'unknown' },
    });
  }
  if (!resolved) return '/see-it-cook-it#download';
  return appStoreUrl(resolved, { affiliateId: affiliate && affiliate.affiliate_id, clickId }) || `/see-it-cook-it?store=${resolved}#download`;
}

// Reuse an identical link when the affiliate asks for it again.
function getOrCreateLink(userId, { destinationKey, campaignId = null, contentId = null, source = null, label = null }) {
  const existing = db.get(
    `SELECT * FROM tracked_links WHERE user_id = ? AND destination_key = ? AND active = 1
       AND campaign_id IS ? AND content_id IS ? AND source IS ?`,
    userId,
    destinationKey,
    campaignId,
    contentId,
    source,
  );
  if (existing) return existing;
  const code = generateLinkCode();
  const info = db.run(
    'INSERT INTO tracked_links (code, user_id, label, campaign_id, content_id, source, destination_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
    code,
    userId,
    label,
    campaignId,
    contentId,
    source,
    destinationKey,
  );
  return db.get('SELECT * FROM tracked_links WHERE id = ?', info.lastInsertRowid);
}

module.exports = {
  EVENT_TYPES,
  DAILY_AGGREGATE_TYPES,
  REJECT_REASONS,
  ppcActive,
  clickToken,
  confirmClick,
  expireStaleClicks,
  BOT_RE,
  QUALIFYING_TYPES,
  API_EVENT_TYPES,
  SOURCES,
  sourceLabel,
  cleanSource,
  generateAffiliateId,
  generateLinkCode,
  primaryLink,
  linkUrl,
  readAttribution,
  writeAttribution,
  recordClick,
  recordEvent,
  applyCommissionRules,
  getDestination,
  detectPlatform,
  appStoreUrl,
  trackAppDownload,
  getOrCreateLink,
};
