'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader so the app has no runtime dependency on dotenv.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';
const port = Number(env.PORT || 3000);
const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

function resolveSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (isProd) throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
  // Development: generate once and keep it next to the database.
  const file = path.join(dataDir, '.dev-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

const uploadDir = path.resolve(ROOT, env.UPLOAD_DIR || path.join(dataDir, 'uploads'));
fs.mkdirSync(uploadDir, { recursive: true });

module.exports = {
  root: ROOT,
  isProd,
  isTest,
  port,
  baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  dataDir,
  dbPath: path.resolve(ROOT, env.DATABASE_PATH || path.join(dataDir, 'chew.db')),
  uploadDir,
  secret: resolveSecret(),
  trustProxy: env.TRUST_PROXY || (isProd ? '1' : ''),
  rateLimitFactor: Number(env.RATE_LIMIT_FACTOR || 1),
  mail: {
    driver: env.SMTP_HOST ? 'smtp' : 'console',
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM || 'Chew Network <no-reply@chew.network>',
  },
  sms: {
    driver: env.TWILIO_ACCOUNT_SID ? 'twilio' : 'console',
    sid: env.TWILIO_ACCOUNT_SID,
    token: env.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_FROM,
  },
  admin: {
    email: env.ADMIN_EMAIL || 'admin@chew.local',
    password: env.ADMIN_PASSWORD || '',
  },
};
