'use strict';
const crypto = require('crypto');
const config = require('../config');

// SQLite-compatible UTC timestamps: "YYYY-MM-DD HH:MM:SS"
const toSql = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const now = () => toSql(new Date());
const addMinutes = (m) => toSql(new Date(Date.now() + m * 60_000));
const addDays = (d) => toSql(new Date(Date.now() + d * 86_400_000));
const daysAgo = (d) => toSql(new Date(Date.now() - d * 86_400_000));
const parseSql = (s) => (s ? new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z')) : null);

function fmtDate(s) {
  const d = parseSql(s);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';
}
function fmtDateTime(s) {
  const d = parseSql(s);
  return d
    ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
    : '—';
}
function timeAgo(s) {
  const d = parseSql(s);
  if (!d) return '—';
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [name, size] of units) {
    const n = Math.floor(sec / size);
    if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const unesc = (s) => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (s) => crypto.createHmac('sha256', config.secret).update(String(s)).digest('base64url');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Unambiguous alphabet: no 0/O, 1/I/L.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function randomCode(len, alphabet = CODE_ALPHABET) {
  let out = '';
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      // rejection sampling keeps the distribution uniform for any alphabet size
      if (b < 256 - (256 % alphabet.length)) out += alphabet[b % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
}
const randomDigits = (len) => Array.from({ length: len }, () => crypto.randomInt(0, 10)).join('');

function money(cents, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((cents || 0) / 100);
  } catch {
    return `${((cents || 0) / 100).toFixed(2)} ${currency}`;
  }
}
const num = (n) => new Intl.NumberFormat('en-US').format(n || 0);

// ---- Safe, minimal Markdown (admin-authored content) ----------------------
// Everything is HTML-escaped first; only a small set of constructs is rendered.
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, rawUrl) => {
      const url = unesc(rawUrl);
      if (!/^(https?:\/\/|\/(?!\/)|#|mailto:)/i.test(url)) return text;
      const ext = /^https?:/i.test(url);
      return `<a href="${esc(url)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
    });
}

function markdown(src) {
  const lines = esc(src || '').split(/\r?\n/);
  let html = '';
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) html += `<p>${inline(para.join(' '))}</p>`;
    para = [];
  };
  const flushList = () => {
    if (list) html += `<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`;
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if (!line) {
      flushPara();
      flushList();
    } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara();
      flushList();
      const lvl = Math.min(m[1].length + 1, 5);
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`;
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(m[1]);
    } else if ((m = line.match(/^\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(m[1]);
    } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
      flushPara();
      flushList();
      html += `<blockquote>${inline(m[1])}</blockquote>`;
    } else if (/^-{3,}$/.test(line)) {
      flushPara();
      flushList();
      html += '<hr>';
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return html;
}

function plainText(src, max = 180) {
  const t = String(src || '')
    .replace(/[#>*`_\[\]()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// Only allow same-site relative redirects (prevents open redirects via ?next=).
function safeNext(next, fallback = '/') {
  const n = String(next || '');
  return /^\/(?![/\\])[\w\-./?=&%#]*$/.test(n) ? n : fallback;
}

function paginate(total, page, perPage = 25) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  return { total, pages, page: current, perPage, offset: (current - 1) * perPage };
}

const clampStr = (s, max) => String(s ?? '').trim().slice(0, max);

module.exports = {
  now,
  addMinutes,
  addDays,
  daysAgo,
  parseSql,
  fmtDate,
  fmtDateTime,
  timeAgo,
  esc,
  slugify,
  sha256,
  hmac,
  randomToken,
  safeEqual,
  randomCode,
  randomDigits,
  money,
  num,
  markdown,
  plainText,
  safeNext,
  paginate,
  clampStr,
};
