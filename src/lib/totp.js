'use strict';
// Two-step sign-in (RFC 6238 TOTP — Google Authenticator, Microsoft Authenticator,
// 1Password, Authy…). Secrets are AES-256-GCM encrypted at rest; each code can be
// used once; recovery codes are stored only as hashes.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { sha256, randomCode } = require('./util');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

// Returns the matching time step (±1 step of clock drift), or null.
function matchStep(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return null;
  const current = Math.floor(now / 1000 / STEP);
  for (const step of [current, current - 1, current + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(c))) return step;
  }
  return null;
}

// ---- secret encryption --------------------------------------------------------
const key = crypto.createHash('sha256').update(`totp:${config.secret}`).digest();
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

const otpauthUrl = (email, secret) =>
  `otpauth://totp/${encodeURIComponent(`Chew Network:${email}`)}?secret=${secret}&issuer=${encodeURIComponent('Chew Network')}&digits=6&period=${STEP}`;

// ---- enrollment -----------------------------------------------------------------
function startEnrollment(userId) {
  const secret = newSecret();
  db.run('UPDATE users SET totp_pending_secret = ? WHERE id = ?', encrypt(secret), userId);
  return secret;
}

function pendingSecret(user) {
  return user.totp_pending_secret ? decrypt(user.totp_pending_secret) : null;
}

const hashRecovery = (userId, code) => sha256(`${config.secret}:recovery:${userId}:${String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')}`);

// Confirms the pending secret with a code; returns fresh recovery codes, or null.
function confirmEnrollment(user, code) {
  const secret = pendingSecret(user);
  const step = secret && matchStep(secret, code);
  if (step == null) return null;
  const codes = Array.from({ length: 8 }, () => `${randomCode(4)}-${randomCode(4)}`);
  db.tx(() => {
    db.run(
      "UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled_at = datetime('now'), totp_last_step = ? WHERE id = ?",
      step,
      user.id,
    );
    db.run('DELETE FROM recovery_codes WHERE user_id = ?', user.id);
    for (const c of codes) db.run('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', user.id, hashRecovery(user.id, c));
  });
  return codes;
}

function disable(userId) {
  db.tx(() => {
    db.run('UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?', userId);
    db.run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
  });
}

// Verifies a sign-in code (authenticator code or one-time recovery code).
function verifyLogin(user, input) {
  if (!user.totp_secret) return false;
  const raw = String(input || '').trim();
  if (/^\d{6}$/.test(raw.replace(/\s/g, ''))) {
    const step = matchStep(decrypt(user.totp_secret), raw);
    // Reject codes from a time step that was already used (replay protection).
    if (step == null || (user.totp_last_step != null && step <= user.totp_last_step)) return false;
    db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
    return true;
  }
  const row = db.get('SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', user.id, hashRecovery(user.id, raw));
  if (!row) return false;
  db.run("UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ?", row.id);
  return 'recovery';
}

const recoveryLeft = (userId) => db.get('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', userId).n;

module.exports = { newSecret, codeAt, matchStep, otpauthUrl, startEnrollment, pendingSecret, confirmEnrollment, disable, verifyLogin, recoveryLeft, STEP };
