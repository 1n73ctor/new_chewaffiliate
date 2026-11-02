'use strict';
// See It. Cook It. credits ledger.
//
//   Package purchase → inventory batch (wholesale affiliate)
//   → grant to a creator (directly, or reserved by a website claim until the creator
//     signs in to the app) → the app reports each completed video → credits consumed.
//
// Rules enforced here and in the schema (migration 5):
//   - balances never go negative (CHECK constraints) and every change runs in one
//     BEGIN IMMEDIATE transaction, so concurrent spends can't double-spend;
//   - every movement is an append-only credit_ledger row with its own reference;
//   - a creator belongs to exactly one wholesale affiliate (creator_attribution
//     PRIMARY KEY), and grants can only come from that affiliate (trigger);
//   - app callbacks are idempotent on the app's transaction reference.
const db = require('../db');
const settings = require('./settings');
const { randomCode, hmac, addDays, now } = require('./util');

class CreditError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---- Settings ------------------------------------------------------------------
const videoCost = () => Math.max(1, settings.int('sic_video_cost', 399));
function grantLimits() {
  const cost = videoCost();
  const min = Math.max(1, settings.int('sic_grant_min', cost));
  const max = Math.max(min, settings.int('sic_grant_max', cost * 5));
  // The approved amounts affiliates can pick: whole videos between min and max.
  const options = [];
  for (let v = 1; v * cost <= max && v <= 50; v++) if (v * cost >= min) options.push({ videos: v, credits: v * cost });
  return { min, max, cost, options };
}

// ---- References & hashing -----------------------------------------------------------
const PREFIX = { batch: 'B', grant: 'G', ledger: 'L', creator: 'CR', order: 'ORD', purchase: 'BUY' };
function newRef(kind, table) {
  for (let i = 0; i < 20; i++) {
    const ref = `${PREFIX[kind]}-${randomCode(kind === 'creator' ? 6 : 10)}`;
    if (!db.get(`SELECT 1 FROM ${table} WHERE ref = ?`, ref)) return ref;
  }
  throw new Error(`Could not allocate a ${kind} reference`);
}
const emailHash = (email) => (email ? hmac(`email:${String(email).trim().toLowerCase()}`) : null);

function newClaimCode() {
  for (let i = 0; i < 20; i++) {
    const code = randomCode(8);
    if (!db.get('SELECT 1 FROM credit_grants WHERE claim_code = ?', code)) return code;
  }
  throw new Error('Could not allocate a claim code');
}

function ledger(e) {
  return db.run(
    `INSERT INTO credit_ledger (ref, type, user_id, creator_id, batch_id, grant_id, consumption_id, credits, source, reversal_of, actor_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newRef('ledger', 'credit_ledger'),
    e.type,
    e.userId ?? null,
    e.creatorId ?? null,
    e.batchId ?? null,
    e.grantId ?? null,
    e.consumptionId ?? null,
    e.credits,
    e.source ?? null,
    e.reversalOf ?? null,
    e.actorId ?? null,
    e.note ?? null,
  ).lastInsertRowid;
}

// ---- Wholesale accounts ---------------------------------------------------------------
const account = (userId) => db.get('SELECT * FROM wholesale_accounts WHERE user_id = ?', userId);

// Accounts start as "prospect" (policy acknowledged, nothing bought yet) and become
// "active" with their first inventory. Admins can suspend them.
function ensureAccount(userId) {
  const existing = account(userId);
  if (existing) return existing;
  const u = db.get('SELECT affiliate_id FROM users WHERE id = ?', userId);
  if (!u || !u.affiliate_id) throw new CreditError('not_affiliate', 'Only affiliates can hold wholesale credits.', 400);
  db.run("INSERT INTO wholesale_accounts (user_id, wholesale_id, status) VALUES (?, ?, 'prospect')", userId, `WS-${u.affiliate_id}`);
  return account(userId);
}

const isWholesaler = (userId) => !!db.get("SELECT 1 FROM wholesale_accounts WHERE user_id = ? AND status = 'active'", userId);

// ---- Inventory -------------------------------------------------------------------------
function addBatch({ userId, credits, source, orderId = null, note = null, actorId = null }) {
  credits = Math.floor(Number(credits));
  if (!(credits > 0)) throw new CreditError('invalid_amount', 'Enter a positive number of credits.', 400);
  return db.txImmediate(() => {
    ensureAccount(userId);
    const ref = newRef('batch', 'credit_batches');
    const { lastInsertRowid: batchId } = db.run(
      `INSERT INTO credit_batches (ref, user_id, order_id, source, credits_total, credits_available, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ref,
      userId,
      orderId,
      source,
      credits,
      credits,
      note,
      actorId,
    );
    ledger({ type: 'batch_created', userId, batchId, credits, source, actorId, note });
    db.run(
      "UPDATE wholesale_accounts SET status = CASE WHEN status = 'prospect' THEN 'active' ELSE status END, low_balance_notified_at = NULL, updated_at = datetime('now') WHERE user_id = ?",
      userId,
    );
    return db.get('SELECT * FROM credit_batches WHERE id = ?', batchId);
  });
}

const available = (userId) =>
  db.get("SELECT COALESCE(SUM(credits_available), 0) AS n FROM credit_batches WHERE user_id = ? AND status = 'active'", userId).n;

function inventory(userId) {
  const b = db.get(
    `SELECT COALESCE(SUM(credits_total), 0) AS purchased, COALESCE(SUM(CASE WHEN status = 'active' THEN credits_available ELSE 0 END), 0) AS available,
            COALESCE(SUM(credits_written_off), 0) AS written_off, COUNT(*) AS batches
     FROM credit_batches WHERE user_id = ?`,
    userId,
  );
  const g = db.get(
    `SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN credits_remaining ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_claims,
            COALESCE(SUM(CASE WHEN status IN ('active','exhausted','revoked') THEN credits ELSE 0 END), 0) AS issued,
            COALESCE(SUM(CASE WHEN status = 'active' THEN credits_remaining ELSE 0 END), 0) AS with_creators
     FROM credit_grants WHERE user_id = ?`,
    userId,
  );
  const consumed = db.get(
    `SELECT COALESCE(SUM(cp.credits), 0) AS n FROM credit_consumption_parts cp
     JOIN credit_consumptions c ON c.id = cp.consumption_id AND c.status = 'consumed'
     JOIN credit_grant_parts p ON p.id = cp.part_id JOIN credit_grants g ON g.id = p.grant_id WHERE g.user_id = ?`,
    userId,
  ).n;
  const returned = db.get(
    "SELECT COALESCE(SUM(credits), 0) AS n FROM credit_ledger WHERE user_id = ? AND type IN ('claim_expired','claim_rejected','grant_revoked','consumption_returned')",
    userId,
  ).n;
  return { ...b, ...g, consumed, returned, expiredOrReversed: returned + b.written_off };
}

// Takes credits from the affiliate's active batches, oldest first.
function takeFromBatches(userId, credits) {
  const batches = db.all("SELECT * FROM credit_batches WHERE user_id = ? AND status = 'active' AND credits_available > 0 ORDER BY id", userId);
  const total = batches.reduce((n, b) => n + b.credits_available, 0);
  if (total < credits) throw new CreditError('insufficient_inventory', `Not enough credits: ${total.toLocaleString('en-US')} available.`);
  const parts = [];
  let left = credits;
  for (const b of batches) {
    if (!left) break;
    const take = Math.min(left, b.credits_available);
    db.run('UPDATE credit_batches SET credits_available = credits_available - ? WHERE id = ?', take, b.id);
    parts.push({ batchId: b.id, credits: take });
    left -= take;
  }
  return parts;
}

function insertGrant({ userId, creatorId = null, credits, status, source, offerId = null, linkId = null, clickId = null, emailHash: eh = null, ipHash = null, expiresAt = null, overrideBy = null, claimCode = null, actorId = null }) {
  const parts = takeFromBatches(userId, credits);
  const ref = newRef('grant', 'credit_grants');
  let grantId;
  try {
    grantId = db.run(
      `INSERT INTO credit_grants (ref, user_id, creator_id, offer_id, link_id, click_id, claim_code, email_hash, ip_hash, credits, credits_remaining,
                                  status, source, override_by, expires_at, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ref,
      userId,
      creatorId,
      offerId,
      linkId,
      clickId,
      claimCode,
      eh,
      ipHash,
      credits,
      credits,
      status,
      source,
      overrideBy,
      expiresAt,
      status === 'active' ? now() : null,
    ).lastInsertRowid;
  } catch (err) {
    if (String(err.message).includes('creator_assigned_elsewhere')) throw new CreditError('assigned_elsewhere', 'This creator is assigned to another affiliate.');
    throw err;
  }
  for (const p of parts) {
    db.run('INSERT INTO credit_grant_parts (grant_id, batch_id, credits, remaining) VALUES (?, ?, ?, ?)', grantId, p.batchId, p.credits, p.credits);
    ledger({ type: status === 'pending' ? 'claim_reserved' : 'grant_issued', userId, creatorId, batchId: p.batchId, grantId, credits: p.credits, source, actorId });
  }
  return db.get('SELECT * FROM credit_grants WHERE id = ?', grantId);
}

// Gives the grant's unused credits back to its batches (or writes them off if a
// batch was reversed) and closes it.
function closeGrant(grant, status, reason, ledgerType, actorId = null) {
  for (const p of db.all('SELECT * FROM credit_grant_parts WHERE grant_id = ? AND remaining > 0', grant.id)) {
    const batch = db.get('SELECT status FROM credit_batches WHERE id = ?', p.batch_id);
    if (batch.status === 'active') db.run('UPDATE credit_batches SET credits_available = credits_available + ? WHERE id = ?', p.remaining, p.batch_id);
    else db.run('UPDATE credit_batches SET credits_written_off = credits_written_off + ? WHERE id = ?', p.remaining, p.batch_id);
    db.run('UPDATE credit_grant_parts SET remaining = 0 WHERE id = ?', p.id);
    ledger({ type: ledgerType, userId: grant.user_id, creatorId: grant.creator_id, batchId: p.batch_id, grantId: grant.id, credits: p.remaining, actorId, note: reason });
  }
  db.run("UPDATE credit_grants SET credits_remaining = 0, status = ?, closed_at = datetime('now'), close_reason = ? WHERE id = ?", status, reason, grant.id);
}

// ---- Creators & attribution ---------------------------------------------------------------
function upsertCreator({ appUserId, email = null }) {
  appUserId = String(appUserId || '').trim().slice(0, 120);
  if (!appUserId) throw new CreditError('invalid_request', 'app_user_id is required.', 400);
  const eh = emailHash(email);
  let c = db.get('SELECT * FROM creators WHERE app_user_id = ?', appUserId);
  if (!c) {
    db.run('INSERT INTO creators (ref, app_user_id, email_hash, last_active_at) VALUES (?, ?, ?, ?)', newRef('creator', 'creators'), appUserId, eh, now());
    c = db.get('SELECT * FROM creators WHERE app_user_id = ?', appUserId);
  } else if (eh && !c.email_hash) {
    db.run('UPDATE creators SET email_hash = ? WHERE id = ?', eh, c.id);
    c.email_hash = eh;
  }
  return c;
}

const attribution = (creatorId) => db.get('SELECT * FROM creator_attribution WHERE creator_id = ?', creatorId);

// First eligible attribution wins and is permanent (INSERT OR IGNORE on the primary key).
function assign(creatorId, affiliateUserId, { source, grantId = null, linkId = null, clickId = null, campaignId = null, by = null } = {}) {
  db.run(
    `INSERT OR IGNORE INTO creator_attribution (creator_id, affiliate_user_id, source, grant_id, link_id, click_id, campaign_id, assigned_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    creatorId,
    affiliateUserId,
    source,
    grantId,
    linkId,
    clickId,
    campaignId,
    by,
  );
  return attribution(creatorId);
}

// Admin dispute resolution: move a creator to another wholesale affiliate.
function transferCreator(creatorId, toUserId, { reason, by }) {
  if (!reason) throw new CreditError('invalid_request', 'A reason is required.', 400);
  return db.txImmediate(() => {
    if (!isWholesaler(toUserId)) throw new CreditError('not_wholesaler', 'The new affiliate is not an active wholesale affiliate.', 400);
    const current = attribution(creatorId);
    if (current && current.affiliate_user_id === toUserId) throw new CreditError('same_affiliate', 'The creator is already assigned to that affiliate.', 400);
    db.run('INSERT INTO attribution_transfers (creator_id, from_user_id, to_user_id, reason, by_user_id) VALUES (?, ?, ?, ?, ?)', creatorId, current ? current.affiliate_user_id : null, toUserId, reason, by);
    if (current) db.run("UPDATE creator_attribution SET affiliate_user_id = ?, source = 'admin_transfer', assigned_at = datetime('now'), assigned_by = ? WHERE creator_id = ?", toUserId, by, creatorId);
    else assign(creatorId, toUserId, { source: 'admin_transfer', by });
    return attribution(creatorId);
  });
}

function creatorBalance(creatorId) {
  return db.get("SELECT COALESCE(SUM(credits_remaining), 0) AS n FROM credit_grants WHERE creator_id = ? AND status = 'active'", creatorId).n;
}

// A creator can get new credits only once the previous grant is used up
// (less than one video left) and nothing is waiting to be redeemed.
function hasUnusedGrant(creatorId) {
  return !!db.get(
    "SELECT 1 FROM credit_grants WHERE creator_id = ? AND (status = 'pending' OR (status = 'active' AND credits_remaining >= ?)) LIMIT 1",
    creatorId,
    videoCost(),
  );
}

// ---- Granting -------------------------------------------------------------------------------
function validateAmount(credits) {
  const { min, max } = grantLimits();
  if (!Number.isInteger(credits) || credits < min || credits > max) {
    throw new CreditError('invalid_amount', `Grants must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')} credits.`, 400);
  }
}

// Direct grant to a creator already assigned to this affiliate.
function grantToCreator({ userId, creatorRef, credits, actorId = null, override = false }) {
  credits = Number(credits);
  if (!override) validateAmount(credits);
  return db.txImmediate(() => {
    if (!isWholesaler(userId)) throw new CreditError('not_wholesaler', 'Only wholesale affiliates can give credits.', 403);
    const creator = db.get('SELECT * FROM creators WHERE ref = ?', String(creatorRef || '').toUpperCase());
    const attr = creator && attribution(creator.id);
    if (!creator || !attr || attr.affiliate_user_id !== userId) throw new CreditError('not_your_creator', 'Choose one of your assigned creators.', 404);
    if (!override && hasUnusedGrant(creator.id)) {
      throw new CreditError('unused_credits', 'This creator still has unused credits. New credits can be given once the previous grant is used.');
    }
    const grant = insertGrant({ userId, creatorId: creator.id, credits, status: 'active', source: override ? 'admin_override' : 'direct', overrideBy: override ? actorId : null, actorId });
    return grant;
  });
}

// ---- Claim links -------------------------------------------------------------------------------
function claimOffer(linkCode) {
  return db.get(
    `SELECT o.*, l.code, l.active AS link_active, l.label, l.campaign_id FROM claim_offers o JOIN tracked_links l ON l.id = o.link_id
     WHERE l.code = ?`,
    String(linkCode || '').toUpperCase(),
  );
}

function offerStats(offerId) {
  return db.get(
    `SELECT COUNT(*) AS claims, COALESCE(SUM(CASE WHEN status IN ('active','exhausted') THEN 1 ELSE 0 END), 0) AS redeemed,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
     FROM credit_grants WHERE offer_id = ? AND status NOT IN ('rejected','expired')`,
    offerId,
  );
}

// A visitor claims free credits on the website. Credits are reserved until they
// sign in to the app (or the claim expires).
function claim({ offer, email, ipHash = null, clickId = null }) {
  const eh = emailHash(email);
  if (!eh) throw new CreditError('invalid_request', 'Enter your email.', 400);
  return db.txImmediate(() => {
    const fresh = db.get('SELECT * FROM claim_offers WHERE id = ?', offer.id);
    const link = db.get('SELECT * FROM tracked_links WHERE id = ?', fresh.link_id);
    if (!fresh.active || !link.active || !isWholesaler(fresh.user_id)) throw new CreditError('offer_closed', 'This offer is no longer available.', 410);
    if (offerStats(fresh.id).claims >= fresh.max_claims) throw new CreditError('offer_full', 'This offer has been fully claimed.', 410);
    // One sponsored claim per person: an existing creator with credits history, or an open claim.
    const known = db.get('SELECT id FROM creators WHERE email_hash = ?', eh);
    if (db.get("SELECT 1 FROM credit_grants WHERE email_hash = ? AND status = 'pending'", eh) || (known && db.get('SELECT 1 FROM creator_attribution WHERE creator_id = ?', known.id))) {
      throw new CreditError('already_claimed', 'Free credits have already been claimed with this email.');
    }
    if (ipHash) {
      const today = db.get("SELECT COUNT(*) AS n FROM credit_grants WHERE ip_hash = ? AND created_at >= datetime('now', '-1 day')", ipHash).n;
      if (today >= settings.int('sic_claims_per_ip_day', 3)) throw new CreditError('too_many_claims', 'Too many claims from this network today. Please try again tomorrow.', 429);
    }
    const days = Math.max(1, settings.int('sic_claim_expiry_days', 14));
    let grant;
    try {
      grant = insertGrant({
        userId: fresh.user_id,
        credits: fresh.credits,
        status: 'pending',
        source: 'claim',
        offerId: fresh.id,
        linkId: fresh.link_id,
        clickId,
        emailHash: eh,
        ipHash,
        expiresAt: addDays(days),
        claimCode: newClaimCode(),
      });
    } catch (err) {
      if (err.code === 'insufficient_inventory') throw new CreditError('offer_closed', 'This offer is no longer available.', 410);
      throw err;
    }
    return grant;
  });
}

// The creator signed in to the app: activate the claim if attribution allows it.
function redeem(grant, creator) {
  const attr = attribution(creator.id);
  if (attr && attr.affiliate_user_id !== grant.user_id) {
    closeGrant(grant, 'rejected', 'assigned_elsewhere', 'claim_rejected');
    return { ok: false, reason: 'assigned_elsewhere' };
  }
  if (hasUnusedGrant(creator.id)) {
    closeGrant(grant, 'rejected', 'unused_credits', 'claim_rejected');
    return { ok: false, reason: 'unused_credits' };
  }
  const link = grant.link_id ? db.get('SELECT campaign_id FROM tracked_links WHERE id = ?', grant.link_id) : null;
  assign(creator.id, grant.user_id, { source: 'claim', grantId: grant.id, linkId: grant.link_id, clickId: grant.click_id, campaignId: link && link.campaign_id });
  db.run("UPDATE credit_grants SET creator_id = ?, status = 'active', activated_at = datetime('now') WHERE id = ?", creator.id, grant.id);
  ledger({ type: 'claim_redeemed', userId: grant.user_id, creatorId: creator.id, grantId: grant.id, credits: grant.credits, source: 'claim' });
  return { ok: true, grant: db.get('SELECT * FROM credit_grants WHERE id = ?', grant.id) };
}

// Called by the app when a creator signs up / signs in.
//   claimCode: the code from the claim page; email: only when the app verified it;
//   referrerAffiliateId: from the app-store install referrer, if any.
function linkCreator({ appUserId, email = null, claimCode = null, referrerAffiliateId = null }) {
  return db.txImmediate(() => {
    const creator = upsertCreator({ appUserId, email });
    const results = [];
    let pending = [];
    if (claimCode) {
      const g = db.get("SELECT * FROM credit_grants WHERE claim_code = ? AND status = 'pending'", String(claimCode).toUpperCase().replace(/[^A-Z0-9]/g, ''));
      if (g) pending.push(g);
    }
    if (creator.email_hash) {
      pending = pending.concat(db.all("SELECT * FROM credit_grants WHERE email_hash = ? AND status = 'pending' ORDER BY id", creator.email_hash).filter((g) => !pending.some((p) => p.id === g.id)));
    }
    let redeemed = false;
    for (const g of pending) {
      if (redeemed) {
        // One sponsored claim per creator; extra claims return to their affiliates.
        closeGrant(g, 'rejected', 'duplicate_claim', 'claim_rejected');
        results.push({ grant: g.ref, ok: false, reason: 'duplicate_claim' });
        continue;
      }
      const r = redeem(g, creator);
      results.push({ grant: g.ref, ok: r.ok, reason: r.reason || null });
      if (r.ok) redeemed = true;
    }
    if (!attribution(creator.id) && referrerAffiliateId) {
      const aff = db.get("SELECT id FROM users WHERE affiliate_id = ? AND status = 'active'", String(referrerAffiliateId).toUpperCase());
      if (aff && isWholesaler(aff.id)) assign(creator.id, aff.id, { source: 'app_referral' });
    }
    db.run("UPDATE creators SET last_active_at = datetime('now') WHERE id = ?", creator.id);
    return { creator: db.get('SELECT * FROM creators WHERE id = ?', creator.id), claims: results };
  });
}

function expireClaims() {
  return db.txImmediate(() => {
    const due = db.all("SELECT * FROM credit_grants WHERE status = 'pending' AND expires_at <= datetime('now')");
    for (const g of due) closeGrant(g, 'expired', 'not_redeemed', 'claim_expired');
    return due.length;
  });
}

function revokeGrant(grantId, { reason, actorId }) {
  return db.txImmediate(() => {
    const g = db.get('SELECT * FROM credit_grants WHERE id = ?', grantId);
    if (!g || !['pending', 'active'].includes(g.status)) throw new CreditError('not_open', 'Only pending or active grants can be revoked.', 400);
    closeGrant(g, g.status === 'pending' ? 'rejected' : 'revoked', reason || 'revoked_by_admin', g.status === 'pending' ? 'claim_rejected' : 'grant_revoked', actorId);
    return db.get('SELECT * FROM credit_grants WHERE id = ?', grantId);
  });
}

// Refunded package: the unissued credits are written off. Credits creators already
// hold stay usable.
function reverseBatch(batchId, { reason, actorId = null }) {
  return db.txImmediate(() => {
    const b = db.get('SELECT * FROM credit_batches WHERE id = ?', batchId);
    if (!b || b.status !== 'active') return b;
    db.run("UPDATE credit_batches SET credits_written_off = credits_written_off + credits_available, credits_available = 0, status = 'reversed' WHERE id = ?", b.id);
    ledger({ type: 'batch_reversed', userId: b.user_id, batchId: b.id, credits: b.credits_available, actorId, note: reason });
    return db.get('SELECT * FROM credit_batches WHERE id = ?', batchId);
  });
}

// ---- Consumption (reported by the app) ----------------------------------------------------------
function consume({ ref, appUserId, credits = null, jobId = null }) {
  ref = String(ref || '').trim().slice(0, 120);
  if (!ref) throw new CreditError('invalid_request', 'transaction_id is required.', 400);
  credits = credits == null ? videoCost() : Number(credits);
  if (!Number.isInteger(credits) || credits <= 0) throw new CreditError('invalid_request', 'credits must be a positive whole number.', 400);
  return db.txImmediate(() => {
    const existing = db.get('SELECT * FROM credit_consumptions WHERE ref = ?', ref);
    if (existing) return { consumption: existing, duplicate: true, balance: creatorBalance(existing.creator_id) };
    const creator = db.get('SELECT * FROM creators WHERE app_user_id = ?', String(appUserId || ''));
    if (!creator) throw new CreditError('unknown_creator', 'Unknown app_user_id — link the creator first.', 404);
    const parts = db.all(
      `SELECT p.*, g.user_id FROM credit_grant_parts p JOIN credit_grants g ON g.id = p.grant_id
       WHERE g.creator_id = ? AND g.status = 'active' AND p.remaining > 0 ORDER BY g.id, p.id`,
      creator.id,
    );
    const balance = parts.reduce((n, p) => n + p.remaining, 0);
    if (balance < credits) throw new CreditError('insufficient_credits', `Not enough credits: ${balance} available, ${credits} needed.`);
    const { lastInsertRowid: cid } = db.run('INSERT INTO credit_consumptions (ref, creator_id, credits, job_id) VALUES (?, ?, ?, ?)', ref, creator.id, credits, jobId ? String(jobId).slice(0, 120) : null);
    let left = credits;
    for (const p of parts) {
      if (!left) break;
      const take = Math.min(left, p.remaining);
      db.run('UPDATE credit_grant_parts SET remaining = remaining - ? WHERE id = ?', take, p.id);
      db.run("UPDATE credit_grants SET credits_remaining = credits_remaining - ?, status = CASE WHEN credits_remaining - ? = 0 THEN 'exhausted' ELSE status END WHERE id = ?", take, take, p.grant_id);
      db.run('INSERT INTO credit_consumption_parts (consumption_id, part_id, credits) VALUES (?, ?, ?)', cid, p.id, take);
      ledger({ type: 'consumed', userId: p.user_id, creatorId: creator.id, batchId: p.batch_id, grantId: p.grant_id, consumptionId: cid, credits: take, source: 'app' });
      left -= take;
    }
    db.run("UPDATE creators SET last_active_at = datetime('now') WHERE id = ?", creator.id);
    return { consumption: db.get('SELECT * FROM credit_consumptions WHERE id = ?', cid), duplicate: false, balance: creatorBalance(creator.id) };
  });
}

// A video failed after credits were taken: put them back where they came from.
function reverseConsumption(ref, { reason = 'generation_failed' } = {}) {
  return db.txImmediate(() => {
    const c = db.get('SELECT * FROM credit_consumptions WHERE ref = ?', String(ref || ''));
    if (!c) throw new CreditError('not_found', 'Unknown transaction_id.', 404);
    if (c.status === 'reversed') return { consumption: c, duplicate: true, balance: creatorBalance(c.creator_id) };
    for (const cp of db.all('SELECT * FROM credit_consumption_parts WHERE consumption_id = ?', c.id)) {
      const p = db.get('SELECT p.*, g.status AS grant_status, g.user_id FROM credit_grant_parts p JOIN credit_grants g ON g.id = p.grant_id WHERE p.id = ?', cp.part_id);
      const original = db.get("SELECT id FROM credit_ledger WHERE consumption_id = ? AND type = 'consumed' AND batch_id = ? AND grant_id = ?", c.id, p.batch_id, p.grant_id);
      const toGrant = ['active', 'exhausted'].includes(p.grant_status);
      if (toGrant) {
        db.run('UPDATE credit_grant_parts SET remaining = remaining + ? WHERE id = ?', cp.credits, p.id);
        db.run("UPDATE credit_grants SET credits_remaining = credits_remaining + ?, status = 'active' WHERE id = ?", cp.credits, p.grant_id);
      } else {
        // The grant was revoked meanwhile: the credits go back to inventory instead.
        const batch = db.get('SELECT status FROM credit_batches WHERE id = ?', p.batch_id);
        if (batch.status === 'active') db.run('UPDATE credit_batches SET credits_available = credits_available + ? WHERE id = ?', cp.credits, p.batch_id);
        else db.run('UPDATE credit_batches SET credits_written_off = credits_written_off + ? WHERE id = ?', cp.credits, p.batch_id);
      }
      ledger({
        type: toGrant ? 'consumption_reversed' : 'consumption_returned',
        userId: p.user_id,
        creatorId: c.creator_id,
        batchId: p.batch_id,
        grantId: p.grant_id,
        consumptionId: c.id,
        credits: cp.credits,
        reversalOf: original && original.id,
        note: reason,
      });
    }
    db.run("UPDATE credit_consumptions SET status = 'reversed', reversed_at = datetime('now'), reverse_reason = ? WHERE id = ?", String(reason).slice(0, 200), c.id);
    return { consumption: db.get('SELECT * FROM credit_consumptions WHERE id = ?', c.id), duplicate: false, balance: creatorBalance(c.creator_id) };
  });
}

// ---- Reconciliation -----------------------------------------------------------------------------
// Every batch: total = available + written off + held by grants + consumed (net).
// Every grant: credits = remaining + consumed (net) + returned to inventory.
// The ledger must agree with both.
function reconcile() {
  const problems = [];
  for (const b of db.all('SELECT * FROM credit_batches')) {
    const held = db.get('SELECT COALESCE(SUM(remaining), 0) AS n FROM credit_grant_parts WHERE batch_id = ?', b.id).n;
    const consumed = db.get(
      `SELECT COALESCE(SUM(cp.credits), 0) AS n FROM credit_consumption_parts cp JOIN credit_consumptions c ON c.id = cp.consumption_id AND c.status = 'consumed'
       JOIN credit_grant_parts p ON p.id = cp.part_id WHERE p.batch_id = ?`,
      b.id,
    ).n;
    const sum = b.credits_available + b.credits_written_off + held + consumed;
    if (sum !== b.credits_total) problems.push({ kind: 'batch', ref: b.ref, expected: b.credits_total, actual: sum });
    const created = db.get("SELECT COALESCE(SUM(credits), 0) AS n FROM credit_ledger WHERE batch_id = ? AND type = 'batch_created'", b.id).n;
    if (created !== b.credits_total) problems.push({ kind: 'batch_ledger', ref: b.ref, expected: b.credits_total, actual: created });
  }
  for (const g of db.all('SELECT * FROM credit_grants')) {
    const consumed = db.get(
      `SELECT COALESCE(SUM(cp.credits), 0) AS n FROM credit_consumption_parts cp JOIN credit_consumptions c ON c.id = cp.consumption_id AND c.status = 'consumed'
       JOIN credit_grant_parts p ON p.id = cp.part_id WHERE p.grant_id = ?`,
      g.id,
    ).n;
    // Credits that went back to inventory: unredeemed/rejected claims, revoked grants,
    // and failed-video refunds that arrived after the grant was closed.
    const returned = db.get(
      "SELECT COALESCE(SUM(credits), 0) AS n FROM credit_ledger WHERE grant_id = ? AND type IN ('claim_expired','claim_rejected','grant_revoked','consumption_returned')",
      g.id,
    ).n;
    const parts = db.get('SELECT COALESCE(SUM(credits), 0) AS c, COALESCE(SUM(remaining), 0) AS r FROM credit_grant_parts WHERE grant_id = ?', g.id);
    if (parts.c !== g.credits || parts.r !== g.credits_remaining) problems.push({ kind: 'grant_parts', ref: g.ref, expected: g.credits, actual: parts.c });
    const sum = g.credits_remaining + consumed + returned;
    if (sum !== g.credits) problems.push({ kind: 'grant', ref: g.ref, expected: g.credits, actual: sum });
  }
  return {
    ok: !problems.length,
    problems,
    batches: db.get('SELECT COUNT(*) AS n FROM credit_batches').n,
    grants: db.get('SELECT COUNT(*) AS n FROM credit_grants').n,
    ledgerRows: db.get('SELECT COUNT(*) AS n FROM credit_ledger').n,
  };
}

module.exports = {
  CreditError,
  videoCost,
  grantLimits,
  emailHash,
  account,
  ensureAccount,
  isWholesaler,
  addBatch,
  available,
  inventory,
  upsertCreator,
  attribution,
  assign,
  transferCreator,
  creatorBalance,
  hasUnusedGrant,
  grantToCreator,
  claimOffer,
  offerStats,
  claim,
  linkCreator,
  expireClaims,
  revokeGrant,
  reverseBatch,
  consume,
  reverseConsumption,
  reconcile,
  newRef,
};
