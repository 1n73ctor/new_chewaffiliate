'use strict';
// Affiliate back office. Everything shown here comes from real tracked activity.
const router = require('express').Router();
const db = require('../db');
const settings = require('../lib/settings');
const qr = require('../lib/qr');
const stats = require('../lib/stats');
const activation = require('../lib/activation');
const content = require('../lib/content');
const credits = require('../lib/credits');
const wholesale = require('../lib/wholesale');
const { requireAffiliate, checkPassword, hashPassword, passwordProblem, validName, destroyAllSessions, createSession } = require('../lib/auth');
const { primaryLink, linkUrl, getOrCreateLink, SOURCES, cleanSource, EVENT_TYPES, ppcActive } = require('../lib/tracking');
const { COMMISSION_STATUSES, TRAINING_TRACKS, PROMO_KINDS } = require('../lib/constants');
const { COUNTRIES, BY_CODE, normalizePhone, validPhone } = require('../lib/countries');
const { clampStr, markdown } = require('../lib/util');
const { waysData } = require('./public');

router.use(requireAffiliate);
router.use((req, res, next) => {
  res.locals.layout = 'office';
  res.locals.primaryLink = primaryLink(req.user);
  res.locals.ppcOn = ppcActive();
  next();
});

const wantsJson = (req) => (req.get('accept') || '').includes('application/json');
const RANGES = [7, 30, 90];
const rangeOf = (req) => (RANGES.includes(Number(req.query.days)) ? Number(req.query.days) : 30);

function trainingProgress(userId) {
  const total = db.get('SELECT COUNT(*) AS n FROM training_lessons l JOIN training_modules m ON m.id = l.module_id WHERE l.published = 1 AND m.published = 1 AND l.coming_soon = 0').n;
  const done = db.get(
    `SELECT COUNT(*) AS n FROM training_progress p JOIN training_lessons l ON l.id = p.lesson_id
     JOIN training_modules m ON m.id = l.module_id WHERE p.user_id = ? AND l.published = 1 AND m.published = 1 AND l.coming_soon = 0`,
    userId,
  ).n;
  const next = db.get(
    `SELECT l.*, m.title AS module_title FROM training_lessons l JOIN training_modules m ON m.id = l.module_id
     WHERE l.published = 1 AND m.published = 1 AND l.coming_soon = 0 AND l.id NOT IN (SELECT lesson_id FROM training_progress WHERE user_id = ?)
     ORDER BY m.sort, l.sort LIMIT 1`,
    userId,
  );
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0, next };
}

function announcements(limit = 5) {
  return db.all(
    `SELECT * FROM announcements WHERE published = 1
       AND (publish_on IS NULL OR publish_on = '' OR publish_on <= date('now'))
       AND (expires_on IS NULL OR expires_on = '' OR expires_on >= date('now'))
     ORDER BY pinned DESC, created_at DESC, id DESC LIMIT ${Number(limit) | 0}`,
  );
}

// ---- Dashboard ---------------------------------------------------------------
router.get('/', async (req, res) => {
  const usage = content.usageMap(req.user.id);
  const sponsor = req.user.referred_by ? db.get('SELECT first_name, last_name, affiliate_id FROM users WHERE id = ?', req.user.referred_by) : null;
  res.page('office/dashboard', {
    title: 'Dashboard',
    nav: 'dashboard',
    summary: stats.summary({ userId: req.user.id }, 30),
    todays3: content.todays3().map((a) => ({ ...a, usage: content.usageStatus(usage[a.id]) })),
    training: trainingProgress(req.user.id),
    activation: activation.status(req.user),
    announcements: announcements(),
    qrSvg: await qr.svg(primaryLink(req.user)),
    sponsor,
    sic: wholesale.summary(req.user.id),
    sicProgramOn: wholesale.enabled(),
  });
});

// ---- Content Kitchen -----------------------------------------------------------
router.get('/content-kitchen', (req, res) => {
  const categories = db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM content_assets a WHERE a.category_id = c.id AND a.status = 'published') AS n
     FROM content_categories c ORDER BY c.sort, c.name`,
  );
  const category = categories.find((c) => c.slug === req.query.category) || null;
  const q = clampStr(req.query.q, 60);
  const where = ["a.status = 'published'"];
  const params = [];
  if (category) {
    where.push('a.category_id = ?');
    params.push(category.id);
  }
  if (q) {
    where.push('(a.title LIKE ? OR a.caption LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const usage = content.usageMap(req.user.id);
  const withUsage = (a) => ({ ...a, usage: content.usageStatus(usage[a.id]), platformList: content.platforms(a) });
  const assets = db.all(`${content.ASSET_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC`, ...params).map(withUsage);
  const sicCategory = categories.find((c) => c.slug === 'see-it-cook-it');
  const showSic = !q && (!category || category === sicCategory);
  res.page('office/content-kitchen', {
    title: 'Content Kitchen',
    nav: 'content',
    categories,
    category,
    q,
    // See It. Cook It. assets live in their own gallery above the main grid.
    assets: showSic && sicCategory ? assets.filter((a) => a.category_id !== sicCategory.id) : assets,
    todays3: content.todays3().map(withUsage),
    sicGallery: showSic && sicCategory
      ? db.all(`${content.ASSET_SELECT} WHERE a.status = 'published' AND a.category_id = ? ORDER BY a.created_at DESC, a.id DESC`, sicCategory.id).map(withUsage)
      : [],
    sicCategory,
    ads: showSic ? promoCopy(req.user, 'ad') : [],
  });
});

// Approved copy with the affiliate's own link: their newest open claim link if they
// run a giveaway, otherwise a tracked link to the See It. Cook It. page.
function sicShareLink(user) {
  const claim = db.get(
    `SELECT l.code FROM claim_offers o JOIN tracked_links l ON l.id = o.link_id
     WHERE o.user_id = ? AND o.active = 1 AND l.active = 1 ORDER BY o.id DESC LIMIT 1`,
    user.id,
  );
  if (claim) return { url: linkUrl(claim.code), claim: true };
  return { url: linkUrl(getOrCreateLink(user.id, { destinationKey: 'see-it-cook-it', label: 'See It. Cook It. promo copy' }).code), claim: false };
}

function promoCopy(user, kind) {
  const rows = db.all('SELECT * FROM promo_copy WHERE published = 1 AND kind = ? ORDER BY sort, id', kind);
  if (!rows.length) return [];
  const link = kind === 'creator_faq' ? null : sicShareLink(user);
  return rows.map((r) => ({ ...r, text: settings.fill(link ? r.body.replace(/\{link\}/g, link.url) : r.body), viaClaim: link && link.claim }));
}

function publishedAsset(id) {
  return db.get(`${content.ASSET_SELECT} WHERE a.id = ? AND a.status = 'published'`, Number(id) || 0);
}

router.get('/content-kitchen/:id(\\d+)', (req, res, next) => {
  const asset = publishedAsset(req.params.id);
  if (!asset) return next();
  content.recordUsage(req.user.id, asset.id, 'preview');
  const usage = content.usageMap(req.user.id)[asset.id];
  const link = req.query.link ? db.get('SELECT * FROM tracked_links WHERE code = ? AND user_id = ?', String(req.query.link), req.user.id) : null;
  res.page('office/asset', {
    title: asset.title,
    nav: 'content',
    asset: { ...asset, platformList: content.platforms(asset), usage: content.usageStatus(usage) },
    player: asset.file_path ? null : content.embedVideo(asset.external_url),
    sources: SOURCES,
    link: link ? { ...link, url: linkUrl(link.code) } : null,
    captionFilled: link ? content.fillCaption(asset.caption, linkUrl(link.code)) : null,
  });
});

function linkForAsset(req, asset) {
  const source = cleanSource(req.body.source);
  const link = getOrCreateLink(req.user.id, {
    destinationKey: asset.destination_key || 'home',
    campaignId: asset.campaign_id || null,
    contentId: asset.id,
    source: SOURCES.some(([k]) => k === source) ? source : null,
    label: `Content Kitchen: ${asset.title}`.slice(0, 120),
  });
  return { ...link, url: linkUrl(link.code) };
}

// Get My Link
router.post('/content-kitchen/:id(\\d+)/link', (req, res, next) => {
  const asset = publishedAsset(req.params.id);
  if (!asset) return next();
  const link = linkForAsset(req, asset);
  content.recordUsage(req.user.id, asset.id, 'link');
  if (wantsJson(req)) return res.json({ url: link.url, code: link.code });
  res.redirect(`/office/content-kitchen/${asset.id}?link=${link.code}#share`);
});

// Copy Caption (caption with the affiliate's own tracked link filled in)
router.post('/content-kitchen/:id(\\d+)/caption', (req, res, next) => {
  const asset = publishedAsset(req.params.id);
  if (!asset) return next();
  const link = linkForAsset(req, asset);
  content.recordUsage(req.user.id, asset.id, 'caption');
  if (wantsJson(req)) return res.json({ caption: content.fillCaption(asset.caption, link.url), url: link.url });
  res.redirect(`/office/content-kitchen/${asset.id}?link=${link.code}#caption`);
});

// Download
router.get('/content-kitchen/:id(\\d+)/download', (req, res, next) => {
  const asset = publishedAsset(req.params.id);
  if (!asset) return next();
  if (!asset.download_allowed) {
    res.flash('error', 'This asset can be shared with your link, but not downloaded.');
    return res.redirect(`/office/content-kitchen/${asset.id}`);
  }
  content.recordUsage(req.user.id, asset.id, 'download');
  const file = content.assetFile(asset);
  if (file) return res.download(file);
  if (asset.external_url && /^https?:\/\//i.test(asset.external_url)) return res.redirect(asset.external_url);
  res.flash('error', 'This asset has no downloadable file yet.');
  res.redirect(`/office/content-kitchen/${asset.id}`);
});

// ---- My Links ------------------------------------------------------------------
function linkFormData() {
  return {
    // Claim links are created in See It. Cook It. (they hand out credits).
    destinations: db.all("SELECT * FROM destinations WHERE active = 1 AND key != 'claim' ORDER BY sort, id"),
    campaigns: db.all("SELECT * FROM campaigns WHERE active = 1 AND (ends_on IS NULL OR ends_on = '' OR ends_on >= date('now')) ORDER BY name"),
    sources: SOURCES,
  };
}

router.get('/links', async (req, res) => {
  const links = db.all(
    `SELECT l.*, d.label AS destination_label, c.name AS campaign_name, a.title AS content_title,
       (SELECT COUNT(*) FROM clicks k WHERE k.link_id = l.id AND k.is_bot = 0 AND k.is_self = 0) AS clicks,
       (SELECT COUNT(*) FROM clicks k WHERE k.link_id = l.id AND k.status = 'qualified') AS paid,
       (SELECT COUNT(*) FROM events e WHERE e.link_id = l.id AND e.type IN ('affiliate_signup','app_account_linked','activation_completed','qualifying_action','purchase')) AS results,
       (SELECT COUNT(*) FROM events e WHERE e.link_id = l.id AND e.type = 'affiliate_signup') AS signups,
       (SELECT COUNT(*) FROM credit_grants g WHERE g.link_id = l.id AND g.status IN ('active','exhausted')) AS claims,
       (SELECT COUNT(*) FROM creator_attribution ca WHERE ca.link_id = l.id) AS creators
     FROM tracked_links l
     LEFT JOIN destinations d ON d.key = l.destination_key
     LEFT JOIN campaigns c ON c.id = l.campaign_id
     LEFT JOIN content_assets a ON a.id = l.content_id
     WHERE l.user_id = ? ORDER BY l.active DESC, l.id DESC`,
    req.user.id,
  );
  const primaryClicks = db.get('SELECT COUNT(*) AS n FROM clicks WHERE affiliate_user_id = ? AND link_id IS NULL AND is_bot = 0 AND is_self = 0', req.user.id).n;
  const created = req.query.created ? links.find((l) => l.code === req.query.created) : null;
  res.page('office/links', {
    title: 'My Links',
    nav: 'links',
    links: links.map((l) => ({ ...l, url: linkUrl(l.code) })),
    primaryClicks,
    qrSvg: await qr.svg(primaryLink(req.user)),
    created: created ? { ...created, url: linkUrl(created.code) } : null,
    sicDestinations: db.all("SELECT * FROM destinations WHERE active = 1 AND key IN ('see-it-cook-it', 'wholesale', 'app') ORDER BY sort"),
    isWholesaler: !!credits.account(req.user.id),
    ...linkFormData(),
  });
});

router.post('/links', (req, res) => {
  const { destinations, campaigns } = linkFormData();
  const dest = destinations.find((d) => d.key === req.body.destination_key);
  const campaign = campaigns.find((c) => String(c.id) === String(req.body.campaign_id)) || null;
  const source = cleanSource(req.body.source);
  if (!dest) {
    res.flash('error', 'Choose where the link should go.');
    return res.redirect('/office/links');
  }
  const link = getOrCreateLink(req.user.id, {
    destinationKey: dest.key,
    campaignId: campaign ? campaign.id : null,
    source: SOURCES.some(([k]) => k === source) ? source : null,
    label: clampStr(req.body.label, 80) || null,
  });
  const utm = clampStr(req.body.utm_campaign, 60).replace(/[^\w .-]/g, '');
  if (utm && utm !== link.utm_campaign) db.run('UPDATE tracked_links SET utm_campaign = ? WHERE id = ?', utm, link.id);
  res.flash('success', 'Your tracked link is ready.');
  res.redirect(`/office/links?created=${link.code}#new-link`);
});

router.post('/links/:code/toggle', (req, res) => {
  const link = db.get('SELECT * FROM tracked_links WHERE code = ? AND user_id = ?', req.params.code, req.user.id);
  if (link) db.run('UPDATE tracked_links SET active = ? WHERE id = ?', link.active ? 0 : 1, link.id);
  res.flash('success', link && link.active ? 'Link paused — it now sends visitors to the homepage without tracking.' : 'Link re-activated.');
  res.redirect('/office/links');
});

// QR codes for the primary link or one of the affiliate's own links.
router.get('/qr/:code.:ext(svg|png)', async (req, res, next) => {
  let url;
  if (req.params.code === 'primary') url = primaryLink(req.user);
  else {
    const link = db.get('SELECT * FROM tracked_links WHERE code = ? AND user_id = ?', req.params.code, req.user.id);
    if (!link) return next();
    url = linkUrl(link.code);
  }
  const filename = `chew-qr-${req.params.code === 'primary' ? req.user.affiliate_id : req.params.code}.${req.params.ext}`;
  if (req.query.download) res.attachment(filename);
  if (req.params.ext === 'svg') return res.type('image/svg+xml').send(await qr.svg(url));
  res.type('image/png').send(await qr.png(url));
});

// ---- Ways to Earn --------------------------------------------------------------
router.get('/ways-to-earn', (req, res) => {
  const rules = db.all("SELECT event_type FROM commission_rules WHERE active = 1 AND event_type IN ('sic_subscription', 'sic_download')").map((r) => r.event_type);
  res.page('office/ways', {
    title: 'Ways to Earn',
    nav: 'ways',
    ...waysData(req.query),
    sic: { on: wholesale.enabled(), isWholesaler: !!credits.account(req.user.id), subscriptionRule: rules.includes('sic_subscription'), downloadRule: rules.includes('sic_download') },
  });
});

// ---- Analytics -------------------------------------------------------------------
router.get('/analytics', (req, res) => {
  const days = rangeOf(req);
  const scope = { userId: req.user.id };
  res.page('office/analytics', {
    title: 'Analytics',
    nav: 'analytics',
    days,
    ranges: RANGES,
    summary: stats.summary(scope, days),
    series: stats.clicksByDay(scope, days),
    bySource: stats.breakdown(scope, days, 'source'),
    byContent: stats.breakdown(scope, days, 'content'),
    byLink: stats.breakdown(scope, days, 'link'),
    byCampaign: stats.breakdown(scope, days, 'campaign'),
    byDestination: stats.breakdown(scope, days, 'destination'),
    recent: stats.recentEvents(scope, 15),
    eventTypes: EVENT_TYPES,
    sicFilters: sicFilters(req.query),
    sicReport: credits.account(req.user.id) ? wholesale.creatorsReport(req.user.id, sicFilters(req.query)) : null,
  });
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function sicFilters(q) {
  return {
    from: ISO_DATE.test(q.from || '') ? q.from : '',
    to: ISO_DATE.test(q.to || '') ? q.to : '',
    link: /^\d{1,9}$/.test(q.link || '') ? q.link : '',
    subscribed: ['yes', 'no'].includes(q.subscribed) ? q.subscribed : '',
    activity: ['active', 'inactive'].includes(q.activity) ? q.activity : '',
  };
}

// Export: only the affiliate's own creators, masked IDs, no personal data.
router.get('/analytics/sic-users.csv', (req, res) => {
  if (!credits.account(req.user.id)) return res.redirect('/office/analytics');
  const { rows } = wholesale.creatorsReport(req.user.id, sicFilters(req.query));
  const cell = (v) => {
    const t = String(v ?? '');
    return /^[=+\-@]/.test(t) ? `"'${t.replace(/"/g, '""')}"` : `"${t.replace(/"/g, '""')}"`;
  };
  const header = ['creator_id', 'joined', 'referral_campaign', 'credit_grants', 'credits_granted', 'credits_used', 'credits_remaining', 'subscription', 'last_activity', 'affiliate_id'];
  const lines = rows.map((r) => [r.ref, r.assigned_at, r.campaign_name || r.link_label || r.source, r.grants, r.granted, r.used, r.remaining, r.subscription_status, r.last_active_at || '', r.affiliate_id].map(cell).join(','));
  res.attachment(`see-it-cook-it-users-${req.user.affiliate_id}.csv`).type('text/csv').send([header.join(','), ...lines].join('\n'));
});

// ---- Commissions -----------------------------------------------------------------
router.get('/commissions', (req, res) => {
  const status = COMMISSION_STATUSES[req.query.status] ? req.query.status : null;
  if (req.query.tab === 'sic') {
    return res.page('office/commissions-sic', {
      title: 'Commissions · See It. Cook It.',
      nav: 'commissions',
      status,
      rows: wholesale.commissionRows(req.user.id, status),
      totals: wholesale.commissionTotals(req.user.id),
      rules: db.all("SELECT * FROM commission_rules WHERE active = 1 AND event_type IN ('sic_subscription', 'sic_download') ORDER BY event_type, name"),
      eventTypes: EVENT_TYPES,
      isWholesaler: !!credits.account(req.user.id),
    });
  }
  const rows = db.all(
    `SELECT c.*, e.type AS event_type, e.created_at AS event_at FROM commissions c LEFT JOIN events e ON e.id = c.event_id
     WHERE c.user_id = ? ${status ? 'AND c.status = ?' : ''} ORDER BY c.id DESC LIMIT 200`,
    req.user.id,
    ...(status ? [status] : []),
  );
  res.page('office/commissions', {
    title: 'Commissions',
    nav: 'commissions',
    rows,
    status,
    summary: stats.summary({ userId: req.user.id }, 30).commissions,
    rules: db.all('SELECT * FROM commission_rules WHERE active = 1 ORDER BY event_type, name'),
    eventTypes: EVENT_TYPES,
    rewards: db.all('SELECT * FROM rewards WHERE user_id = ? ORDER BY id DESC', req.user.id),
  });
});

// ---- Training --------------------------------------------------------------------
router.get('/training', (req, res) => {
  const modules = db.all("SELECT * FROM training_modules WHERE published = 1 ORDER BY CASE track WHEN 'general' THEN 0 WHEN 'creators' THEN 1 ELSE 2 END, sort, id");
  const lessons = db.all('SELECT * FROM training_lessons WHERE published = 1 ORDER BY sort, id');
  const done = new Set(db.all('SELECT lesson_id FROM training_progress WHERE user_id = ?', req.user.id).map((r) => r.lesson_id));
  res.page('office/training', {
    title: 'Training',
    nav: 'training',
    modules: modules.map((m) => {
      const items = lessons.filter((l) => l.module_id === m.id).map((l) => ({ ...l, done: done.has(l.id) }));
      return { ...m, lessons: items, done: items.filter((l) => l.done).length, ready: items.filter((l) => !l.coming_soon).length };
    }),
    progress: trainingProgress(req.user.id),
    tracks: TRAINING_TRACKS,
  });
});

// Downloadable checklist for a training track (plain text, prints anywhere).
router.get('/training/checklist/:track(creators|wholesale)', (req, res) => {
  const lessons = db.all(
    `SELECT l.title, l.summary, l.coming_soon FROM training_lessons l JOIN training_modules m ON m.id = l.module_id
     WHERE m.track = ? AND l.published = 1 AND m.published = 1 ORDER BY m.sort, l.sort, l.id`,
    req.params.track,
  );
  const lines = [`See It. Cook It. — ${TRAINING_TRACKS[req.params.track]} checklist`, ''];
  for (const l of lessons) lines.push(`[ ] ${l.title}${l.coming_soon ? ' (coming soon)' : ''}${l.summary ? `\n    ${settings.fill(l.summary)}` : ''}`);
  lines.push('', 'Credits are free and promotional. Never present them as a cash prize. Always disclose #ad or #sponsored.');
  res.attachment(`see-it-cook-it-${req.params.track}-checklist.txt`).type('text/plain').send(lines.join('\n'));
});

function orderedLessons() {
  return db.all(
    `SELECT l.id FROM training_lessons l JOIN training_modules m ON m.id = l.module_id
     WHERE l.published = 1 AND m.published = 1 AND l.coming_soon = 0
     ORDER BY CASE m.track WHEN 'general' THEN 0 WHEN 'creators' THEN 1 ELSE 2 END, m.sort, m.id, l.sort, l.id`,
  ).map((r) => r.id);
}

router.get('/training/:id(\\d+)', (req, res, next) => {
  const lesson = db.get(
    `SELECT l.*, m.title AS module_title FROM training_lessons l JOIN training_modules m ON m.id = l.module_id
     WHERE l.id = ? AND l.published = 1 AND m.published = 1`,
    req.params.id,
  );
  if (!lesson || lesson.coming_soon) return next();
  const order = orderedLessons();
  const i = order.indexOf(lesson.id);
  res.page('office/lesson', {
    title: lesson.title,
    nav: 'training',
    lesson,
    bodyHtml: markdown(settings.fill(lesson.body)),
    video: content.embedVideo(lesson.video_url),
    done: !!db.get('SELECT 1 FROM training_progress WHERE user_id = ? AND lesson_id = ?', req.user.id, lesson.id),
    prevId: i > 0 ? order[i - 1] : null,
    nextId: i >= 0 && i < order.length - 1 ? order[i + 1] : null,
  });
});

router.post('/training/:id(\\d+)/complete', (req, res) => {
  const lesson = db.get('SELECT id FROM training_lessons WHERE id = ? AND published = 1 AND coming_soon = 0', req.params.id);
  if (lesson) db.run('INSERT OR IGNORE INTO training_progress (user_id, lesson_id) VALUES (?, ?)', req.user.id, lesson.id);
  const order = orderedLessons();
  const next = order[order.indexOf(Number(req.params.id)) + 1];
  res.redirect(next ? `/office/training/${next}` : '/office/training');
});

// ---- Resources -------------------------------------------------------------------
router.get('/resources', (req, res) => {
  const resources = db.all('SELECT * FROM resources WHERE published = 1 ORDER BY category, sort, id');
  res.page('office/resources', {
    title: 'Resources',
    nav: 'resources',
    resources,
    promo: { ad: promoCopy(req.user, 'ad'), giveaway: promoCopy(req.user, 'giveaway'), creator_faq: promoCopy(req.user, 'creator_faq') },
    promoKinds: PROMO_KINDS,
  });
});

// One-click download of a piece of approved copy, with the affiliate's link filled in.
router.get('/resources/copy/:id(\\d+).txt', (req, res, next) => {
  const row = db.get('SELECT * FROM promo_copy WHERE id = ? AND published = 1', req.params.id);
  if (!row) return next();
  const filled = promoCopy(req.user, row.kind).find((r) => r.id === row.id);
  const text = [filled.title, '', filled.text, '', filled.guidance ? `Usage: ${filled.guidance}` : '', 'Always disclose #ad or #sponsored. Credits are free and have no cash value.'].filter((l, i, all) => l || all[i - 1]).join('\n');
  res.attachment(`chew-${row.kind}-${row.id}.txt`).type('text/plain').send(text);
});

// ---- See It. Cook It. (activation + wholesale command center) ---------------------
router.use(require('./office-sic'));

// ---- Account -----------------------------------------------------------------------
function renderAccount(req, res, extra = {}) {
  const user = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  res.status(extra.status || 200).page('office/account', {
    title: 'Account',
    nav: 'account',
    me: user,
    countries: COUNTRIES,
    sponsor: user.referred_by ? db.get('SELECT first_name, last_name, affiliate_id FROM users WHERE id = ?', user.referred_by) : null,
    wsAccount: credits.account(user.id),
    domains: db.all('SELECT * FROM promo_domains WHERE user_id = ? ORDER BY id', user.id),
    termsVersion: wholesale.termsVersion(),
    history: db.all(
      `SELECT action, created_at FROM audit_log WHERE (target_type = 'user' AND target_id = ?) OR (actor_id = ? AND action LIKE 'wholesale.%')
       ORDER BY id DESC LIMIT 15`,
      String(user.id),
      user.id,
    ),
    errors: {},
    ...extra,
  });
}

router.get('/account', (req, res) => renderAccount(req, res));

router.post('/account/profile', (req, res) => {
  const first = clampStr(req.body.first_name, 60);
  const last = clampStr(req.body.last_name, 60);
  const country = BY_CODE[req.body.country] ? req.body.country : req.user.country;
  const mobile = normalizePhone(req.body.mobile, country);
  const errors = {};
  if (!validName(first)) errors.first_name = first ? 'Use letters only (spaces, hyphens and apostrophes are fine).' : 'Enter your first name.';
  if (!validName(last)) errors.last_name = last ? 'Use letters only (spaces, hyphens and apostrophes are fine).' : 'Enter your last name.';
  if (!validPhone(mobile)) errors.mobile = 'Enter a valid mobile number.';
  if (Object.keys(errors).length) return renderAccount(req, res, { errors, status: 422 });
  const phoneChanged = mobile !== req.user.mobile;
  db.run(
    `UPDATE users SET first_name = ?, last_name = ?, country = ?, mobile = ?,
       phone_verified_at = CASE WHEN ? THEN NULL ELSE phone_verified_at END, updated_at = datetime('now') WHERE id = ?`,
    first,
    last,
    country,
    mobile,
    phoneChanged ? 1 : 0,
    req.user.id,
  );
  res.flash('success', 'Profile saved.');
  res.redirect('/office/account');
});

router.post('/account/password', (req, res) => {
  if (!checkPassword(req.body.current_password, req.user.password_hash)) {
    return renderAccount(req, res, { errors: { current_password: 'Your current password is incorrect.' }, status: 422 });
  }
  const problem = passwordProblem(req.body.new_password, { email: req.user.email });
  if (problem) return renderAccount(req, res, { errors: { new_password: problem }, status: 422 });
  db.run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", hashPassword(req.body.new_password), req.user.id);
  // Sign out other devices, keep this one.
  destroyAllSessions(req.user.id);
  createSession(req, res, req.user.id);
  res.flash('success', 'Password updated. Other devices have been signed out.');
  res.redirect('/office/account');
});

// Marketing + SMS consent: separate, optional, changeable any time.
router.post('/account/preferences', (req, res) => {
  const marketing = req.body.marketing_consent === '1' ? 1 : 0;
  const sms = req.body.sms_consent === '1' ? 1 : 0;
  db.run(
    `UPDATE users SET
       marketing_consent_at = CASE WHEN marketing_consent != ? THEN datetime('now') ELSE marketing_consent_at END,
       sms_consent_at = CASE WHEN sms_consent != ? THEN datetime('now') ELSE sms_consent_at END,
       marketing_consent = ?, sms_consent = ?, updated_at = datetime('now') WHERE id = ?`,
    marketing,
    sms,
    marketing,
    sms,
    req.user.id,
  );
  res.flash('success', 'Communication preferences saved.');
  res.redirect('/office/account#preferences');
});

module.exports = router;
