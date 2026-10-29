'use strict';
// Back office: See It. Cook It. command center (activation for everyone; wholesale
// inventory, packages, claim links and credit grants for wholesale affiliates).
const dns = require('dns').promises;
const router = require('express').Router();
const db = require('../db');
const settings = require('../lib/settings');
const qr = require('../lib/qr');
const activation = require('../lib/activation');
const credits = require('../lib/credits');
const wholesale = require('../lib/wholesale');
const audit = require('../lib/audit');
const { linkUrl, getOrCreateLink, generateLinkCode, appStoreUrl, SOURCES, cleanSource } = require('../lib/tracking');
const { clampStr, now, randomToken } = require('../lib/util');

// ---- Command center ---------------------------------------------------------------------
function claimLinks(userId) {
  return db
    .all(
      `SELECT o.*, l.code, l.label, l.active AS link_active, l.source, c.name AS campaign_name,
         (SELECT COUNT(*) FROM clicks k WHERE k.link_id = l.id AND k.is_bot = 0 AND k.is_self = 0) AS clicks
       FROM claim_offers o JOIN tracked_links l ON l.id = o.link_id LEFT JOIN campaigns c ON c.id = l.campaign_id
       WHERE o.user_id = ? ORDER BY o.active DESC, o.id DESC`,
      userId,
    )
    .map((o) => ({ ...o, ...credits.offerStats(o.id), url: linkUrl(o.code) }));
}

function eligibleCreators(userId) {
  const cost = credits.videoCost();
  return db.all(
    `SELECT c.ref,
       (SELECT COALESCE(SUM(credits_remaining), 0) FROM credit_grants g WHERE g.creator_id = c.id AND g.status = 'active') AS remaining
     FROM creator_attribution a JOIN creators c ON c.id = a.creator_id
     WHERE a.affiliate_user_id = ?
       AND NOT EXISTS (SELECT 1 FROM credit_grants g WHERE g.creator_id = c.id AND (g.status = 'pending' OR (g.status = 'active' AND g.credits_remaining >= ?)))
     ORDER BY a.assigned_at DESC LIMIT 200`,
    userId,
    cost,
  );
}

router.get('/see-it-cook-it', async (req, res) => {
  const appLink = getOrCreateLink(req.user.id, { destinationKey: 'app', label: 'See It. Cook It. app link' });
  const appLinkUrl = linkUrl(appLink.code);
  const code = req.user.app_link_code && req.user.app_link_code_expires > now() ? req.user.app_link_code : null;
  const acct = credits.account(req.user.id);
  const ws = acct ? wholesale.summary(req.user.id) : null;
  res.page('office/see-it-cook-it', {
    title: 'See It. Cook It.',
    nav: 'app',
    activation: activation.status(req.user),
    linkCode: code,
    linkCodeExpires: code ? req.user.app_link_code_expires : null,
    deepLink: code ? `${settings.get('app_deep_link_scheme') || 'seeitcookit://'}link?code=${code}` : null,
    appLinkUrl,
    appLinkCode: appLink.code,
    appQrSvg: await qr.svg(appLinkUrl),
    storesReady: { ios: !!appStoreUrl('ios'), android: !!appStoreUrl('android') },
    reward: settings.get('reward_enabled') === '1' ? settings.all() : null,
    // Wholesale
    programOn: wholesale.enabled(),
    acct,
    ws,
    checklist: wholesale.checklist(req.user.id),
    limits: credits.grantLimits(),
    packages: wholesale.packages(),
    claimLinks: acct ? claimLinks(req.user.id) : [],
    creators: acct ? eligibleCreators(req.user.id) : [],
    recentCreators: acct ? wholesale.creatorsReport(req.user.id).rows.slice(0, 8) : [],
    campaigns: db.all("SELECT * FROM campaigns WHERE active = 1 AND (ends_on IS NULL OR ends_on = '' OR ends_on >= date('now')) ORDER BY name"),
    sources: SOURCES,
    termsVersion: wholesale.termsVersion(),
  });
});

router.post('/see-it-cook-it/link-code', (req, res) => {
  activation.issueLinkCode(req.user.id);
  res.redirect('/office/see-it-cook-it#link-code');
});

router.post('/see-it-cook-it/acknowledge', (req, res) => {
  if (req.body.ack !== '1') {
    res.flash('error', 'Tick the box to acknowledge the Wholesale Terms and attribution policy.');
    return res.redirect('/office/see-it-cook-it#policy');
  }
  wholesale.acknowledge(req);
  res.flash('success', 'Thanks — attribution policy acknowledged.');
  res.redirect(req.body.next === 'packages' ? '/office/see-it-cook-it/packages' : '/office/see-it-cook-it');
});

// ---- Packages & checkout --------------------------------------------------------------------
router.get('/see-it-cook-it/packages', (req, res) => {
  const acct = credits.account(req.user.id);
  res.page('office/sic-packages', {
    title: 'Credit packages',
    nav: 'app',
    packages: wholesale.packages(),
    blocker: wholesale.purchaseBlocker(req.user.id),
    acct,
    needsAck: !acct || !acct.attribution_ack_at || acct.attribution_ack_version !== wholesale.termsVersion(),
    available: acct ? credits.available(req.user.id) : 0,
    orders: db.all('SELECT * FROM package_orders WHERE user_id = ? AND status != ? ORDER BY id DESC LIMIT 10', req.user.id, 'pending'),
    canceled: req.query.canceled ? true : false,
    videoCost: credits.videoCost(),
    termsVersion: wholesale.termsVersion(),
  });
});

router.post('/see-it-cook-it/checkout', async (req, res, next) => {
  const blocker = wholesale.purchaseBlocker(req.user.id);
  if (blocker) {
    res.flash('error', blocker);
    return res.redirect('/office/see-it-cook-it/packages');
  }
  const order = wholesale.createOrder(req.user.id, req.body.package_id);
  if (!order) {
    res.flash('error', 'Choose a package.');
    return res.redirect('/office/see-it-cook-it/packages');
  }
  audit(req, 'wholesale.checkout_started', 'package_order', order.id, { ref: order.ref, package: order.package_name });
  try {
    res.redirect(303, await wholesale.startCheckout(order, req.user));
  } catch (err) {
    console.error('Stripe checkout failed:', err.message);
    db.run("UPDATE package_orders SET status = 'failed' WHERE id = ?", order.id);
    res.flash('error', 'We couldn’t start the payment. Please try again, or contact support if it keeps happening.');
    res.redirect('/office/see-it-cook-it/packages');
  }
});

router.get('/see-it-cook-it/checkout/return', async (req, res) => {
  let order = null;
  try {
    order = (await wholesale.syncReturn(clampStr(req.query.session_id, 200), req.user.id)).order;
  } catch (err) {
    console.error('Stripe session check failed:', err.message);
  }
  if (order && order.status === 'paid') res.flash('success', `Payment received — ${order.credits.toLocaleString('en-US')} credits were added to your inventory.`);
  else res.flash('info', 'Thanks! We’re confirming your payment with Stripe — your credits appear here as soon as it’s confirmed.');
  res.redirect('/office/see-it-cook-it');
});

// Without online payment: ask the team for more credits.
router.post('/see-it-cook-it/request-credits', (req, res) => {
  const note = clampStr(req.body.note, 2000);
  const { lastInsertRowid: id } = db.run(
    "INSERT INTO support_tickets (user_id, name, email, topic, subject, message) VALUES (?, ?, ?, 'Wholesale credits', ?, ?)",
    req.user.id,
    `${req.user.first_name} ${req.user.last_name}`,
    req.user.email,
    'Request for more See It. Cook It. credits',
    note || 'I’d like to buy more See It. Cook It. credits.',
  );
  audit(req, 'wholesale.credits_requested', 'support_ticket', id);
  res.flash('success', `Request #${id} sent — our team will contact you about more credits.`);
  res.redirect('/office/see-it-cook-it');
});

// ---- Claim links --------------------------------------------------------------------------------
router.post('/see-it-cook-it/claim-links', (req, res) => {
  const back = '/office/see-it-cook-it#issue';
  if (!credits.isWholesaler(req.user.id)) {
    res.flash('error', 'Claim links are available once you have credits.');
    return res.redirect(back);
  }
  const limits = credits.grantLimits();
  const opt = limits.options.find((o) => o.videos === Number(req.body.videos));
  const maxClaims = Math.floor(Number(req.body.max_claims));
  if (!opt || !(maxClaims >= 1 && maxClaims <= 10000)) {
    res.flash('error', 'Choose credits per creator and how many creators can claim (1–10,000).');
    return res.redirect(back);
  }
  const campaign = req.body.campaign_id ? db.get('SELECT id FROM campaigns WHERE id = ? AND active = 1', Number(req.body.campaign_id)) : null;
  const source = cleanSource(req.body.source);
  const offerId = db.txImmediate(() => {
    const { lastInsertRowid: linkId } = db.run(
      'INSERT INTO tracked_links (code, user_id, label, campaign_id, source, destination_key, utm_campaign) VALUES (?, ?, ?, ?, ?, ?, ?)',
      generateLinkCode(),
      req.user.id,
      clampStr(req.body.label, 80) || `Free credits · ${opt.videos} video${opt.videos === 1 ? '' : 's'}`,
      campaign ? campaign.id : null,
      SOURCES.some(([k]) => k === source) ? source : null,
      'claim',
      clampStr(req.body.utm_campaign, 60) || null,
    );
    return db.run('INSERT INTO claim_offers (link_id, user_id, credits, max_claims) VALUES (?, ?, ?, ?)', linkId, req.user.id, opt.credits, maxClaims).lastInsertRowid;
  });
  audit(req, 'wholesale.claim_link_created', 'claim_offer', offerId, { credits: opt.credits, max_claims: maxClaims });
  res.flash('success', 'Your claim link is ready. Credits are only taken from your inventory when someone claims.');
  res.redirect('/office/see-it-cook-it#claims');
});

router.post('/see-it-cook-it/claim-links/:id(\\d+)/toggle', (req, res) => {
  const o = db.get('SELECT * FROM claim_offers WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (o) {
    db.run('UPDATE claim_offers SET active = ? WHERE id = ?', o.active ? 0 : 1, o.id);
    audit(req, o.active ? 'wholesale.claim_link_closed' : 'wholesale.claim_link_reopened', 'claim_offer', o.id);
    res.flash('success', o.active ? 'Claim link closed — open claims still complete.' : 'Claim link reopened.');
  }
  res.redirect('/office/see-it-cook-it#claims');
});

// ---- Issue free credits to a creator: review → confirm ----------------------------------------
function reviewGrant(req) {
  const limits = credits.grantLimits();
  const opt = limits.options.find((o) => o.videos === Number(req.body.videos));
  const creator = db.get(
    'SELECT c.* FROM creators c JOIN creator_attribution a ON a.creator_id = c.id WHERE c.ref = ? AND a.affiliate_user_id = ?',
    clampStr(req.body.creator, 20).toUpperCase(),
    req.user.id,
  );
  return { opt, creator, balance: credits.available(req.user.id) };
}

router.post('/see-it-cook-it/grant', (req, res) => {
  const { opt, creator, balance } = reviewGrant(req);
  if (!opt || !creator) {
    res.flash('error', 'Choose one of your creators and an approved amount.');
    return res.redirect('/office/see-it-cook-it#issue');
  }
  const blocked = credits.hasUnusedGrant(creator.id);
  res.page('office/sic-grant-confirm', { title: 'Confirm free credits', nav: 'app', opt, creator, balance, blocked, creatorBalance: credits.creatorBalance(creator.id) });
});

router.post('/see-it-cook-it/grant/confirm', (req, res) => {
  const { opt, creator } = reviewGrant(req);
  if (!opt || !creator) {
    res.flash('error', 'Choose one of your creators and an approved amount.');
    return res.redirect('/office/see-it-cook-it#issue');
  }
  try {
    const g = credits.grantToCreator({ userId: req.user.id, creatorRef: creator.ref, credits: opt.credits, actorId: req.user.id });
    audit(req, 'wholesale.credits_granted', 'credit_grant', g.id, { ref: g.ref, creator: creator.ref, credits: g.credits });
    wholesale.checkLowBalance(req.user.id);
    res.flash('success', `${g.credits.toLocaleString('en-US')} free credits given to ${creator.ref}. Transaction ${g.ref}.`);
  } catch (err) {
    if (!(err instanceof credits.CreditError)) throw err;
    res.flash('error', err.message);
  }
  res.redirect('/office/see-it-cook-it#issue');
});

// ---- Account: wholesale settings ------------------------------------------------------------------
router.post('/account/wholesale', (req, res) => {
  const acct = credits.account(req.user.id);
  if (!acct) return res.redirect('/office/account');
  const url = clampStr(req.body.site_request_url, 300);
  if (url && !/^https:\/\/[^\s]+$/i.test(url)) {
    res.flash('error', 'Use a full https:// address for your site.');
    return res.redirect('/office/account#wholesale');
  }
  const changedSite = (url || null) !== (acct.site_request_url || null) || clampStr(req.body.site_request_note, 1000) !== (acct.site_request_note || '');
  db.run(
    `UPDATE wholesale_accounts SET notify_low_balance = ?, notify_claims = ?, notify_earnings = ?,
       site_request_url = ?, site_request_note = ?,
       site_request_status = CASE WHEN ? THEN 'requested' ELSE site_request_status END,
       site_requested_at = CASE WHEN ? THEN datetime('now') ELSE site_requested_at END,
       updated_at = datetime('now') WHERE user_id = ?`,
    req.body.notify_low_balance === '1' ? 1 : 0,
    req.body.notify_claims === '1' ? 1 : 0,
    req.body.notify_earnings === '1' ? 1 : 0,
    url || null,
    clampStr(req.body.site_request_note, 1000) || null,
    changedSite && (url || req.body.site_request_note) ? 1 : 0,
    changedSite && (url || req.body.site_request_note) ? 1 : 0,
    req.user.id,
  );
  audit(req, 'wholesale.settings_updated', 'user', req.user.id, changedSite ? { branded_site_request: url || 'note' } : null);
  res.flash('success', 'Wholesale settings saved.');
  res.redirect('/office/account#wholesale');
});

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

router.post('/account/domains', (req, res) => {
  const domain = clampStr(req.body.domain, 253).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!credits.account(req.user.id) || !DOMAIN_RE.test(domain)) {
    res.flash('error', 'Enter a domain like mycookingsite.com.');
    return res.redirect('/office/account#domains');
  }
  if (db.get('SELECT COUNT(*) AS n FROM promo_domains WHERE user_id = ?', req.user.id).n >= 10) {
    res.flash('error', 'You can add up to 10 domains.');
    return res.redirect('/office/account#domains');
  }
  db.run('INSERT OR IGNORE INTO promo_domains (user_id, domain, token) VALUES (?, ?, ?)', req.user.id, domain, randomToken(12));
  audit(req, 'wholesale.domain_added', 'user', req.user.id, { domain });
  res.flash('success', `Added ${domain}. Add the TXT record below, then press Verify.`);
  res.redirect('/office/account#domains');
});

// Verified when the domain has a TXT record "chew-verify=<token>".
router.post('/account/domains/:id(\\d+)/verify', async (req, res) => {
  const d = db.get('SELECT * FROM promo_domains WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!d) return res.redirect('/office/account#domains');
  let found = false;
  try {
    const records = await dns.resolveTxt(d.domain);
    found = records.some((parts) => parts.join('').trim() === `chew-verify=${d.token}`);
  } catch {
    found = false;
  }
  db.run(
    `UPDATE promo_domains SET checked_at = datetime('now'), status = CASE WHEN ? THEN 'verified' ELSE status END,
       verified_at = CASE WHEN ? THEN datetime('now') ELSE verified_at END WHERE id = ?`,
    found ? 1 : 0,
    found ? 1 : 0,
    d.id,
  );
  if (found) audit(req, 'wholesale.domain_verified', 'user', req.user.id, { domain: d.domain });
  res.flash(found ? 'success' : 'error', found ? `${d.domain} is verified.` : `We couldn’t find the TXT record on ${d.domain} yet. DNS changes can take a while — try again later.`);
  res.redirect('/office/account#domains');
});

router.post('/account/domains/:id(\\d+)/delete', (req, res) => {
  const d = db.get('SELECT * FROM promo_domains WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (d) {
    db.run('DELETE FROM promo_domains WHERE id = ?', d.id);
    audit(req, 'wholesale.domain_removed', 'user', req.user.id, { domain: d.domain });
  }
  res.redirect('/office/account#domains');
});

module.exports = router;
