'use strict';
const path = require('path');
const db = require('../db');
const config = require('../config');

const ASSET_SELECT = `SELECT a.*, c.name AS category_name, c.slug AS category_slug FROM content_assets a
                      LEFT JOIN content_categories c ON c.id = a.category_id`;

// Admin-selected Today's 3; falls back to the newest published assets.
function todays3() {
  const picked = db.all(
    `SELECT a.*, c.name AS category_name, t.rank FROM todays3 t JOIN content_assets a ON a.id = t.asset_id
     LEFT JOIN content_categories c ON c.id = a.category_id
     WHERE a.status = 'published' ORDER BY t.rank`,
  );
  if (picked.length >= 3) return picked;
  const ids = picked.map((a) => a.id);
  const more = db.all(`${ASSET_SELECT} WHERE a.status = 'published' ORDER BY a.created_at DESC, a.id DESC LIMIT 6`).filter((a) => !ids.includes(a.id));
  return picked.concat(more).slice(0, 3);
}

const USAGE_FIELDS = { preview: 'previewed_at', caption: 'caption_copied_at', link: 'link_created_at', download: 'downloaded_at' };

function recordUsage(userId, assetId, action) {
  const col = USAGE_FIELDS[action];
  if (!col) return;
  db.run(
    `INSERT INTO content_usage (user_id, asset_id, ${col}) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id, asset_id) DO UPDATE SET ${col} = COALESCE(${col}, datetime('now'))`,
    userId,
    assetId,
  );
}

function usageMap(userId) {
  return Object.fromEntries(db.all('SELECT * FROM content_usage WHERE user_id = ?', userId).map((u) => [u.asset_id, u]));
}

function usageStatus(u) {
  if (!u) return { label: 'New', tone: 'new' };
  const used = [u.downloaded_at && 'downloaded', u.caption_copied_at && 'caption copied', u.link_created_at && 'link created'].filter(Boolean);
  if (used.length) return { label: 'Used', tone: 'used', detail: used.join(' · ') };
  return { label: 'Viewed', tone: 'viewed' };
}

const PLATFORM_SOURCE = {
  Instagram: 'instagram',
  TikTok: 'tiktok',
  Facebook: 'facebook',
  'YouTube Shorts': 'youtube',
  WhatsApp: 'whatsapp',
  X: 'x',
  Pinterest: 'pinterest',
  LinkedIn: 'linkedin',
  Email: 'email',
  'Text message': 'sms',
};

const platforms = (asset) =>
  String(asset.platforms || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Absolute path on disk for a downloadable asset file, or null.
function assetFile(asset) {
  const p = asset.file_path || '';
  let base;
  let rel;
  if (p.startsWith('/uploads/')) {
    base = config.uploadDir;
    rel = p.slice('/uploads/'.length);
  } else if (p.startsWith('/img/')) {
    base = path.join(config.root, 'public');
    rel = p.slice(1);
  } else return null;
  const full = path.resolve(base, rel);
  return full.startsWith(path.resolve(base) + path.sep) ? full : null;
}

const fillCaption = (caption, url) => {
  const text = String(caption || '');
  return text.includes('{link}') ? text.split('{link}').join(url) : `${text}${text ? '\n\n' : ''}${url}`;
};

// YouTube / Vimeo / direct video URL → how to play it on our pages.
const YOUTUBE_ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/;
function embedVideo(url) {
  if (!url) return null;
  let m = url.match(YOUTUBE_ID);
  if (m) return { type: 'iframe', src: `https://www.youtube-nocookie.com/embed/${m[1]}` };
  m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) return { type: 'iframe', src: `https://player.vimeo.com/video/${m[1]}` };
  if (/^(https?:\/\/|\/uploads\/)[^\s]+\.(mp4|webm|mov)(\?.*)?$/i.test(url)) return { type: 'video', src: url };
  return /^https?:\/\//i.test(url) ? { type: 'link', src: url } : null;
}

function youtubeThumb(url) {
  const m = String(url || '').match(YOUTUBE_ID);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
}

module.exports = { embedVideo, youtubeThumb, ASSET_SELECT, todays3, recordUsage, usageMap, usageStatus, PLATFORM_SOURCE, platforms, assetFile, fillCaption };
