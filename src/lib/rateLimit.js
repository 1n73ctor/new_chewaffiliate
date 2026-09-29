'use strict';
// Small in-memory fixed-window rate limiter. Good for a single instance;
// swap for a shared store (Redis) if the app is scaled horizontally.
const config = require('../config');

function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many attempts. Please wait a moment and try again.' }) {
  const hits = new Map();
  const limit = Math.max(1, Math.round(max * config.rateLimitFactor));
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const k = key(req);
    const t = Date.now();
    let h = hits.get(k);
    if (!h || h.reset < t) {
      h = { count: 0, reset: t + windowMs };
      hits.set(k, h);
    }
    h.count += 1;
    if (h.count > limit) {
      res.set('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
      if (req.path.startsWith('/api/') || req.xhr || (req.get('accept') || '').includes('application/json')) {
        return res.status(429).json({ error: 'rate_limited', message });
      }
      return res.status(429).page('public/message', { title: 'Slow down', heading: 'Please slow down', message });
    }
    next();
  };
}

module.exports = rateLimit;
