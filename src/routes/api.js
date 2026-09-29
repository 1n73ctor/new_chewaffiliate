'use strict';
// Server-to-server API for the See It. Cook It. backend and commerce partners.
// Auth: "Authorization: Bearer <key>" — keys are created in Admin → API keys.
// Full reference: docs/API.md
const router = require('express').Router();
const db = require('../db');
const rateLimit = require('../lib/rateLimit');
const activation = require('../lib/activation');
const { recordEvent, API_EVENT_TYPES } = require('../lib/tracking');
const { sha256, clampStr } = require('../lib/util');

function requireKey(req, res, next) {
  const m = String(req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  const key = m && db.get('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', sha256(m[1]));
  if (!key) return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid API key.' });
  db.run("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?", key.id);
  req.apiKey = key;
  next();
}

const bad = (res, message, error = 'invalid_request') => res.status(400).json({ error, message });

// Find the Chew account an app event belongs to.
function findUser(u = {}) {
  if (u.affiliate_id) return db.get("SELECT * FROM users WHERE affiliate_id = ? AND status = 'active'", String(u.affiliate_id).toUpperCase());
  if (u.app_user_id) {
    const byRef = db.get("SELECT * FROM users WHERE app_user_ref = ? AND status = 'active'", String(u.app_user_id));
    if (byRef) return byRef;
  }
  if (u.email) return db.get("SELECT * FROM users WHERE email = ? AND status = 'active'", String(u.email).toLowerCase());
  return null;
}

const publicUser = (u) => ({
  affiliate_id: u.affiliate_id,
  first_name: u.first_name,
  app_linked: !!u.app_linked_at,
  activated: !!u.app_activated_at,
});

router.get('/health', (req, res) => res.json({ ok: true }));

router.use(requireKey);
router.use(rateLimit({ windowMs: 60_000, max: 600, key: (req) => `api:${req.apiKey.id}` }));

// Validate an Affiliate ID (e.g. a referral code typed in the app).
router.get('/affiliates/:affiliateId', (req, res) => {
  const u = db.get("SELECT * FROM users WHERE affiliate_id = ? AND status = 'active'", String(req.params.affiliateId).toUpperCase());
  if (!u) return res.status(404).json({ error: 'not_found' });
  res.json({ affiliate_id: u.affiliate_id, display_name: `${u.first_name} ${u.last_name.charAt(0)}.` });
});

// Link (or recognize) a Chew account from the app.
// Body: { link_code } — code shown in Back Office → See It. Cook It.
//   or  { email, email_verified: true } — recognize by an email the app has verified
// Optional: app_user_id, external_id
router.post('/app/link', (req, res) => {
  const b = req.body || {};
  let user = null;
  if (b.link_code) user = activation.findByLinkCode(b.link_code);
  else if (b.email && b.email_verified === true) user = findUser({ email: b.email });
  else return bad(res, 'Provide link_code, or email with email_verified: true.');
  if (!user) return res.status(404).json({ error: 'user_not_found', message: 'No active Chew account matches (the link code may have expired).' });
  const appUserRef = b.app_user_id ? clampStr(b.app_user_id, 120) : null;
  const other = appUserRef && db.get('SELECT id FROM users WHERE app_user_ref = ? AND id != ?', appUserRef, user.id);
  if (other) return res.status(409).json({ error: 'app_user_already_linked', message: 'That app user is linked to a different Chew account.' });
  const result = activation.linkAccount(user, {
    appUserRef,
    origin: 'api',
    externalId: b.external_id ? clampStr(b.external_id, 120) : null,
    metadata: { api_key: req.apiKey.prefix, method: b.link_code ? 'link_code' : 'email' },
  });
  res.json({ ok: true, already_linked: result.alreadyLinked, user: publicUser(result.user) });
});

// Report an event.
// { type, external_id, user: {affiliate_id|app_user_id|email}, attribution: {click_id|affiliate_id},
//   destination, value_cents, currency, metadata }
router.post('/events', (req, res) => {
  const b = req.body || {};
  if (!API_EVENT_TYPES.includes(b.type)) return bad(res, `type must be one of: ${API_EVENT_TYPES.join(', ')}`);
  const externalId = clampStr(b.external_id, 120);
  if (!externalId) return bad(res, 'external_id is required (used to make retries safe).');
  const metadata = b.metadata && typeof b.metadata === 'object' ? { ...b.metadata, api_key: req.apiKey.prefix } : { api_key: req.apiKey.prefix };

  const existing = db.get('SELECT * FROM events WHERE type = ? AND external_id = ?', b.type, externalId);
  if (existing) return res.json({ ok: true, duplicate: true, event_id: existing.id });

  if (b.type === 'app_account_linked' || b.type === 'activation_completed') {
    const user = findUser(b.user);
    if (!user) return res.status(404).json({ error: 'user_not_found', message: 'Identify the Chew account with user.affiliate_id, user.app_user_id or user.email.' });
    const result =
      b.type === 'app_account_linked'
        ? activation.linkAccount(user, { appUserRef: b.user && b.user.app_user_id ? clampStr(b.user.app_user_id, 120) : null, externalId, metadata })
        : activation.completeActivation(user, { externalId, metadata });
    return res.json({
      ok: true,
      duplicate: !result.event,
      event_id: result.event ? result.event.id : null,
      user: publicUser(result.user),
      reward: result.reward ? { label: result.reward.label, amount: result.reward.amount, unit: result.reward.unit, status: result.reward.status } : null,
    });
  }

  // qualifying_action / purchase — credited through attribution.
  const attr = b.attribution || {};
  let affiliateUserId = null;
  if (attr.affiliate_id) {
    const a = db.get("SELECT id FROM users WHERE affiliate_id = ? AND status = 'active'", String(attr.affiliate_id).toUpperCase());
    if (!a) return res.status(404).json({ error: 'affiliate_not_found' });
    affiliateUserId = a.id;
  }
  const clickId = attr.click_id ? clampStr(attr.click_id, 64) : null;
  if (!affiliateUserId && !clickId) return bad(res, 'Provide attribution.click_id or attribution.affiliate_id.');
  const subject = b.user ? findUser(b.user) : null;
  const value = Number.isInteger(b.value_cents) && b.value_cents >= 0 ? b.value_cents : null;
  const { event, duplicate } = recordEvent({
    type: b.type,
    affiliateUserId,
    subjectUserId: subject ? subject.id : null,
    clickId,
    destinationKey: b.destination ? clampStr(b.destination, 80) : null,
    valueCents: value,
    currency: b.currency ? clampStr(b.currency, 3).toUpperCase() : value != null ? 'USD' : null,
    externalId,
    origin: 'api',
    metadata,
  });
  if (!event.affiliate_user_id) return res.status(422).json({ ok: false, error: 'unattributed', message: 'click_id not found and no affiliate_id given.', event_id: event.id });
  const commissions = db.get('SELECT COUNT(*) AS n FROM commissions WHERE event_id = ?', event.id).n;
  res.json({ ok: true, duplicate, event_id: event.id, commissions_created: commissions });
});

module.exports = router;
