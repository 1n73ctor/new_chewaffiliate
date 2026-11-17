'use strict';
// Two cheap signals that separate a person from a form-filling script, with no
// third party and nothing for a real visitor to do.
//
//  1. a decoy field, hidden from view, that a person never sees and a script fills
//  2. how long the form was open: a person takes seconds, a script posts at once
//
// The timestamp is signed, so it cannot be back-dated by editing the form.
const crypto = require('crypto');
const config = require('../config');

const FIELD = 'website_url';   // plausible enough that a scraper wants to fill it
const STAMP = 'form_ts';
// Read per call, not at load: tests set BOT_MIN_SECONDS=0 so they need not sleep,
// and the order in which they require this module should not matter.
const minSeconds = () => Number(process.env.BOT_MIN_SECONDS ?? 3);
const MAX_SECONDS = 60 * 60 * 24; // a tab left open all day still submits fine

const sign = (ts) => crypto.createHmac('sha256', config.secret).update(`botguard:${ts}`).digest('base64url').slice(0, 24);

// Put in every protected form; read back by check().
function token() {
  const ts = Date.now();
  return `${ts}.${sign(ts)}`;
}

// Returns null for a person, or a short reason worth logging.
function check(req) {
  if (String((req.body || {})[FIELD] || '').trim()) return 'honeypot';
  const [tsRaw, mac] = String((req.body || {})[STAMP] || '').split('.');
  const ts = Number(tsRaw);
  if (!ts || !mac) return 'no_stamp';
  // Fixed-length compare: both sides are the same 24 chars.
  const expected = sign(ts);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return 'bad_stamp';
  const age = (Date.now() - ts) / 1000;
  if (age < minSeconds()) return 'too_fast';
  if (age > MAX_SECONDS) return 'stale';
  return null;
}

module.exports = { FIELD, STAMP, token, check, minSeconds };
