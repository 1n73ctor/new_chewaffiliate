'use strict';
// See It. Cook It. activation:
//   Download (app_download_clicked) → Link / recognize Chew account (app_account_linked)
//   → Complete required activation event (activation_completed) → Update affiliate profile
// The app backend (Surendra) reports link + activation through /api/v1 (see docs/API.md).
const db = require('../db');
const settings = require('./settings');
const { randomCode, addMinutes, now } = require('./util');
const { recordEvent } = require('./tracking');

function issueLinkCode(userId) {
  let code;
  do code = randomCode(8);
  while (db.get('SELECT 1 FROM users WHERE app_link_code = ?', code));
  db.run("UPDATE users SET app_link_code = ?, app_link_code_expires = ?, updated_at = datetime('now') WHERE id = ?", code, addMinutes(15), userId);
  return db.get('SELECT app_link_code, app_link_code_expires FROM users WHERE id = ?', userId);
}

function findByLinkCode(code) {
  return db.get(
    "SELECT * FROM users WHERE app_link_code = ? AND app_link_code_expires > datetime('now') AND status = 'active'",
    String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
  );
}

function linkAccount(user, { appUserRef = null, origin = 'api', externalId = null, metadata = null } = {}) {
  const alreadyLinked = !!user.app_linked_at;
  db.run(
    `UPDATE users SET app_linked_at = COALESCE(app_linked_at, ?), app_user_ref = COALESCE(?, app_user_ref),
            app_link_code = NULL, app_link_code_expires = NULL, updated_at = datetime('now') WHERE id = ?`,
    now(),
    appUserRef,
    user.id,
  );
  let event = null;
  if (!alreadyLinked) {
    event = recordEvent({
      type: 'app_account_linked',
      affiliateUserId: user.referred_by,
      subjectUserId: user.id,
      externalId,
      origin,
      metadata,
    }).event;
  }
  return { user: db.get('SELECT * FROM users WHERE id = ?', user.id), event, alreadyLinked };
}

function completeActivation(user, { origin = 'api', externalId = null, metadata = null } = {}) {
  const alreadyActivated = !!user.app_activated_at;
  let event = null;
  let reward = null;
  if (!alreadyActivated) {
    // Activation implies the account is linked.
    if (!user.app_linked_at) user = linkAccount(user, { origin, metadata }).user;
    db.run("UPDATE users SET app_activated_at = ?, updated_at = datetime('now') WHERE id = ?", now(), user.id);
    event = recordEvent({
      type: 'activation_completed',
      affiliateUserId: user.referred_by,
      subjectUserId: user.id,
      externalId,
      origin,
      metadata,
    }).event;
    reward = grantActivationReward(user.id, event.id);
  }
  return { user: db.get('SELECT * FROM users WHERE id = ?', user.id), event, reward, alreadyActivated };
}

// Only recorded when management has switched the (configurable) reward on.
function grantActivationReward(userId, eventId) {
  const s = settings.all();
  if (s.reward_enabled !== '1') return null;
  db.run(
    'INSERT OR IGNORE INTO rewards (user_id, kind, label, amount, unit, status, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    userId,
    'app_activation',
    s.reward_label || 'Activation Reward',
    s.reward_amount || null,
    s.reward_unit || null,
    'pending',
    eventId,
  );
  return db.get("SELECT * FROM rewards WHERE user_id = ? AND kind = 'app_activation'", userId);
}

function status(user) {
  const downloaded = db.get("SELECT created_at FROM events WHERE subject_user_id = ? AND type = 'app_download_clicked' ORDER BY id LIMIT 1", user.id);
  const reward = db.get("SELECT * FROM rewards WHERE user_id = ? AND kind = 'app_activation'", user.id);
  const steps = [
    { key: 'download', label: 'Download See It. Cook It.', detail: 'Apple App Store or Google Play', done: !!downloaded, at: downloaded && downloaded.created_at },
    { key: 'link', label: 'Link your Chew account', detail: 'Sign in or enter your link code in the app', done: !!user.app_linked_at, at: user.app_linked_at },
    { key: 'activate', label: 'Complete activation', detail: 'Finish the in-app activation step', done: !!user.app_activated_at, at: user.app_activated_at },
    { key: 'profile', label: 'Affiliate profile updated', detail: 'Your back office shows you as activated', done: !!user.app_activated_at, at: user.app_activated_at },
  ];
  const completed = steps.filter((s) => s.done).length;
  return { steps, completed, total: steps.length, activated: !!user.app_activated_at, reward };
}

module.exports = { issueLinkCode, findByLinkCode, linkAccount, completeActivation, status };
