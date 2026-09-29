'use strict';
const router = require('express').Router();
const db = require('../db');
const { recordClick, getDestination, trackAppDownload, cleanSource } = require('../lib/tracking');

const activeAffiliate = (affiliateId) =>
  db.get("SELECT * FROM users WHERE affiliate_id = ? AND status = 'active'", String(affiliateId || '').toUpperCase().slice(0, 20));

// Destination → redirect URL. App destinations also record app_download_clicked.
function resolve(req, res, dest, attribution) {
  if (dest.kind === 'app') return trackAppDownload(req, res, ['ios', 'android'].includes(dest.url) ? dest.url : 'auto', attribution);
  if (dest.kind === 'external' && /^https?:\/\//i.test(dest.url || '')) return dest.url;
  return dest.url && dest.url.startsWith('/') && !dest.url.startsWith('//') ? dest.url : '/';
}

// Primary referral link: /a/CHW7K3M9Q  (optional ?s=source&c=campaign-slug&ct=contentId&d=destination-key)
router.get('/a/:affiliateId', (req, res) => {
  const affiliate = activeAffiliate(req.params.affiliateId);
  if (!affiliate) return res.redirect('/');
  const campaign = req.query.c ? db.get('SELECT * FROM campaigns WHERE slug = ? AND active = 1', String(req.query.c)) : null;
  const content = /^\d{1,9}$/.test(String(req.query.ct || '')) ? db.get('SELECT id FROM content_assets WHERE id = ?', Number(req.query.ct)) : null;
  const dest = getDestination(String(req.query.d || '')) || (campaign && getDestination(campaign.destination_key)) || getDestination('home');
  const { clickId } = recordClick(req, res, {
    affiliate,
    source: cleanSource(req.query.s),
    campaignId: campaign ? campaign.id : null,
    contentId: content ? content.id : null,
    destinationKey: dest ? dest.key : 'home',
  });
  res.redirect(dest ? resolve(req, res, dest, { affiliate, clickId }) : '/');
});

// Tracked link created in the back office / Content Kitchen: /r/AB3K9QZ
router.get('/r/:code', (req, res) => {
  const link = db.get('SELECT * FROM tracked_links WHERE code = ?', String(req.params.code).toUpperCase().slice(0, 20));
  const affiliate = link && link.active ? db.get("SELECT * FROM users WHERE id = ? AND status = 'active'", link.user_id) : null;
  if (!affiliate) return res.redirect('/');
  const dest = getDestination(link.destination_key) || getDestination('home');
  const { clickId } = recordClick(req, res, {
    affiliate,
    link,
    source: link.source,
    campaignId: link.campaign_id,
    contentId: link.content_id,
    destinationKey: dest ? dest.key : link.destination_key,
  });
  res.redirect(dest ? resolve(req, res, dest, { affiliate, clickId }) : '/');
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
  res.redirect(req.path + (qs ? `?${qs}` : ''));
});

module.exports = router;
