'use strict';
// Tracking answers one question for every result:
//   WHO → WHAT CONTENT → WHAT SOURCE → WHAT LINK → WHAT PRODUCT → WHAT RESULT
// Clicks record affiliate_id, campaign_id, content_id, source, destination and time.
// Events (signups, app events, qualifying actions) inherit that attribution
// from the click that led to them and feed the commission rules.
const db = require('../db');
const config = require('../config');
const settings = require('./settings');
const { randomCode, randomToken, hmac, safeEqual, sha256 } = require('./util');

const EVENT_TYPES = {
  affiliate_signup: 'Referred affiliate joined',
  app_download_clicked: 'App download clicked',
  app_account_linked: 'App account linked',
  activation_completed: 'App activation completed',
  qualifying_action: 'Qualifying action',
  purchase: 'Purchase',
};
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

const ATTR_COOKIE = 'chew_attr';
const VISITOR_COOKIE = 'chew_vid';

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
function recordClick(req, res, { affiliate, link = null, source = null, campaignId = null, contentId = null, destinationKey = null }) {
  const ua = (req.get('user-agent') || '').slice(0, 300);
  const isBot = !ua || BOT_RE.test(ua) ? 1 : 0;
  const isSelf = req.user && req.user.id === affiliate.id ? 1 : 0;
  const clickId = randomToken(12);
  db.run(
    `INSERT INTO clicks (click_id, link_id, affiliate_user_id, campaign_id, content_id, source, destination_key,
                         visitor_id, ip_hash, user_agent, referer, is_bot, is_self)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    clickId,
    link ? link.id : null,
    affiliate.id,
    campaignId,
    contentId,
    source,
    destinationKey,
    isBot ? null : visitorId(req, res),
    sha256(`${config.secret}:${req.ip}`).slice(0, 32),
    ua,
    (req.get('referer') || '').slice(0, 300) || null,
    isBot,
    isSelf,
  );
  // Link previews and the affiliate's own clicks never overwrite attribution.
  if (!isBot && !isSelf) writeAttribution(res, affiliate.id, clickId);
  return { clickId, isBot, isSelf };
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
  for (const rule of db.all('SELECT * FROM commission_rules WHERE active = 1 AND event_type = ?', event.type)) {
    const pct = event.value_cents ? Math.round((event.value_cents * rule.percent_bps) / 10000) : 0;
    const amount = rule.amount_cents + pct;
    if (amount <= 0) continue;
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
