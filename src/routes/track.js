'use strict';
const router = require('express').Router();
const db = require('../db');
const { recordClick, getDestination, trackAppDownload, cleanSource, ppcActive, clickToken, confirmClick } = require('../lib/tracking');
const { safeNext } = require('../lib/util');
const rateLimit = require('../lib/rateLimit');

// Send the visitor on. Clicks that can earn (pending) first pass through a tiny
// "Opening…" page whose script confirms a real browser made the click.
function forward(res, url, click) {
  if (click.status !== 'pending') return res.redirect(url);
  res.set('X-Robots-Tag', 'noindex');
  res.page('public/redirect', { layout: 'bare', title: 'Opening…', dest: url, token: clickToken(click.clickId), noindex: true });
}

const activeAffiliate = (affiliateId) =>
  db.get("SELECT * FROM users WHERE affiliate_id = ? AND status = 'active'", String(affiliateId || '').toUpperCase().slice(0, 20));

// Destination → redirect URL. App destinations also record app_download_clicked.
function resolve(req, res, dest, attribution, link = null) {
  // Claim links open their own free-credit claim page.
  if (dest.key === 'claim') return link ? `/claim/${link.code}` : '/';
  if (dest.kind === 'app') return trackAppDownload(req, res, ['ios', 'android'].includes(dest.url) ? dest.url : 'auto', attribution);
  if (dest.kind === 'external' && /^https?:\/\//i.test(dest.url || '')) {
    if (!link || !link.utm_campaign) return dest.url;
    const url = new URL(dest.url);
    url.searchParams.set('utm_source', 'chew_affiliate');
    url.searchParams.set('utm_medium', 'affiliate');
    url.searchParams.set('utm_campaign', link.utm_campaign);
    return url.toString();
  }
  return dest.url && dest.url.startsWith('/') && !dest.url.startsWith('//') ? dest.url : '/';
}

// Primary referral link: /a/CHW7K3M9Q  (optional ?s=source&c=campaign-slug&ct=contentId&d=destination-key)
router.get('/a/:affiliateId', (req, res) => {
  const affiliate = activeAffiliate(req.params.affiliateId);
  if (!affiliate) return res.redirect('/');
  const campaign = req.query.c ? db.get('SELECT * FROM campaigns WHERE slug = ? AND active = 1', String(req.query.c)) : null;
  const content = /^\d{1,9}$/.test(String(req.query.ct || '')) ? db.get('SELECT id FROM content_assets WHERE id = ?', Number(req.query.ct)) : null;
  const dest = getDestination(String(req.query.d || '')) || (campaign && getDestination(campaign.destination_key)) || getDestination('home');
  const click = recordClick(req, res, {
    affiliate,
    source: cleanSource(req.query.s),
    campaignId: campaign ? campaign.id : null,
    contentId: content ? content.id : null,
    destinationKey: dest ? dest.key : 'home',
    ppc: ppcActive(),
  });
  forward(res, dest ? resolve(req, res, dest, { affiliate, clickId: click.clickId }) : '/', click);
});

// Tracked link created in the back office / Content Kitchen: /r/AB3K9QZ
router.get('/r/:code', (req, res) => {
  const link = db.get('SELECT * FROM tracked_links WHERE code = ?', String(req.params.code).toUpperCase().slice(0, 20));
  // "Test link": the owner sees where it goes and what it records — no click is counted.
  if (link && req.query.preview && req.user && req.user.id === link.user_id) return previewLink(req, res, link);
  const affiliate = link && link.active ? db.get("SELECT * FROM users WHERE id = ? AND status = 'active'", link.user_id) : null;
  if (!affiliate) return res.redirect('/');
  const dest = getDestination(link.destination_key) || getDestination('home');
  const click = recordClick(req, res, {
    affiliate,
    link,
    source: link.source,
    campaignId: link.campaign_id,
    contentId: link.content_id,
    destinationKey: dest ? dest.key : link.destination_key,
    ppc: ppcActive(),
  });
  forward(res, dest ? resolve(req, res, dest, { affiliate, clickId: click.clickId }, link) : '/', click);
});

function previewLink(req, res, link) {
  const dest = getDestination(link.destination_key) || getDestination('home');
  const offer = dest && dest.key === 'claim' ? db.get('SELECT * FROM claim_offers WHERE link_id = ?', link.id) : null;
  res.set('X-Robots-Tag', 'noindex');
  res.page('public/link-preview', {
    title: 'Test link',
    noindex: true,
    link,
    dest,
    offer,
    campaign: link.campaign_id ? db.get('SELECT name FROM campaigns WHERE id = ?', link.campaign_id) : null,
    content: link.content_id ? db.get('SELECT title FROM content_assets WHERE id = ?', link.content_id) : null,
    target: link.active ? (dest ? (dest.key === 'claim' ? `/claim/${link.code}` : dest.kind === 'app' ? 'The App Store or Google Play (detected from the visitor’s phone)' : dest.url) : '/') : '/ (paused — no tracking)',
  });
}

// Called by /js/redirect.js on the "Opening…" page. Always 204: the visitor is
// never told whether the click earned (that would help someone game the checks).
router.post('/r/confirm', rateLimit({ windowMs: 60_000, max: 120 }), (req, res) => {
  const body = req.body || {};
  confirmClick(req, { token: typeof body.t === 'string' ? body.t : '', webdriver: body.wd === true });
  res.status(204).end();
});

// App-store buttons across the site. Attribution comes from the visitor's cookie.
router.get('/go/app/:platform(ios|android|auto)', (req, res) => {
  res.redirect(trackAppDownload(req, res, req.params.platform));
});

// ?ref=AFFILIATEID on any page records a click, then redirects to the clean URL.
router.use((req, res, next) => {
  if (req.method !== 'GET' || !req.query.ref || req.path.startsWith('/api/')) return next();
  const affiliate = activeAffiliate(req.query.ref);
  if (affiliate) recordClick(req, res, { affiliate, source: cleanSource(req.query.s), destinationKey: null });
  const params = new URLSearchParams(req.query);
  params.delete('ref');
  params.delete('s');
  const qs = params.toString();
  // req.path can start with "//" or "/\\" (e.g. //evil.com/?ref=…) — never redirect off-site.
  res.redirect(safeNext(req.path + (qs ? `?${qs}` : ''), '/'));
});

module.exports = router;
