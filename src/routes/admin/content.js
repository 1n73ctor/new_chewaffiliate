'use strict';
// Content Kitchen management: assets (upload or link), Today's 3.
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = require('express').Router();
const db = require('../../db');
const config = require('../../config');
const audit = require('../../lib/audit');
const { requirePerm, verifyCsrf } = require('../../lib/auth');
const { PLATFORMS } = require('../../lib/constants');
const { randomToken, clampStr } = require('../../lib/util');
const { ASSET_SELECT } = require('../../lib/content');

const TYPES = {
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.pdf': 'document',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now().toString(36)}-${randomToken(6)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 250 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = file.fieldname === 'thumb' ? TYPES[ext] === 'image' : !!TYPES[ext];
    cb(null, ok);
  },
}).fields([
  { name: 'file', maxCount: 1 },
  { name: 'thumb', maxCount: 1 },
]);

// The file's first bytes must match its extension (so an HTML or script file
// can't be uploaded disguised as an image).
function contentMatchesExtension(file) {
  const ext = path.extname(file.filename).toLowerCase();
  let head;
  try {
    const fd = fs.openSync(file.path, 'r');
    head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
  } catch {
    return false;
  }
  const at = (offset, str) => head.subarray(offset, offset + str.length).toString('latin1') === str;
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case '.png':
      return at(0, '\x89PNG\r\n\x1a\n');
    case '.gif':
      return at(0, 'GIF87a') || at(0, 'GIF89a');
    case '.webp':
      return at(0, 'RIFF') && at(8, 'WEBP');
    case '.mp4':
    case '.mov':
      return at(4, 'ftyp') || at(4, 'moov') || at(4, 'mdat') || at(4, 'wide');
    case '.webm':
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    case '.pdf':
      return at(0, '%PDF-');
    default:
      return false;
  }
}

const perm = requirePerm('content.manage');
const STATUSES = { draft: 'Draft', published: 'Published', archived: 'Archived' };

function formData() {
  return {
    categories: db.all('SELECT * FROM content_categories ORDER BY sort, name'),
    destinations: db.all('SELECT * FROM destinations WHERE active = 1 ORDER BY sort'),
    campaigns: db.all('SELECT * FROM campaigns ORDER BY active DESC, name'),
    platforms: PLATFORMS,
    statuses: STATUSES,
  };
}

router.get('/content', perm, (req, res) => {
  const status = STATUSES[req.query.status] ? req.query.status : '';
  const category = Number(req.query.category) || 0;
  const where = [];
  const params = [];
  if (status) {
    where.push('a.status = ?');
    params.push(status);
  }
  if (category) {
    where.push('a.category_id = ?');
    params.push(category);
  }
  const rows = db.all(
    `SELECT x.*,
       (SELECT COUNT(*) FROM content_usage u WHERE u.asset_id = x.id AND u.previewed_at IS NOT NULL) AS previews,
       (SELECT COUNT(*) FROM content_usage u WHERE u.asset_id = x.id AND (u.caption_copied_at IS NOT NULL OR u.link_created_at IS NOT NULL OR u.downloaded_at IS NOT NULL)) AS users_used,
       (SELECT COUNT(*) FROM clicks k WHERE k.content_id = x.id AND k.is_bot = 0 AND k.is_self = 0) AS clicks,
       (SELECT rank FROM todays3 t WHERE t.asset_id = x.id) AS t3
     FROM (${ASSET_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}) x ORDER BY x.id DESC`,
    ...params,
  );
  res.page('admin/content-list', { title: 'Content Kitchen', nav: 'content', rows, status, category, ...formData() });
});

function renderForm(req, res, asset, errors = {}, status = 200) {
  res.status(status).page('admin/content-form', { title: asset.id ? 'Edit asset' : 'New asset', nav: 'content', asset, errors, ...formData() });
}

router.get('/content/new', perm, (req, res) => renderForm(req, res, { status: 'draft', platforms: '' }));

router.get('/content/:id(\\d+)', perm, (req, res, next) => {
  const asset = db.get('SELECT * FROM content_assets WHERE id = ?', req.params.id);
  if (!asset) return next();
  renderForm(req, res, asset);
});

function removeUpload(p) {
  if (!p || !p.startsWith('/uploads/')) return;
  const full = path.resolve(config.uploadDir, p.slice('/uploads/'.length));
  if (full.startsWith(path.resolve(config.uploadDir) + path.sep)) fs.rm(full, { force: true }, () => {});
}

function save(req, res, existing) {
  const b = req.body;
  const file = req.files && req.files.file && req.files.file[0];
  const thumb = req.files && req.files.thumb && req.files.thumb[0];
  const { categories, destinations, campaigns } = formData();
  const v = {
    title: clampStr(b.title, 160),
    category_id: categories.some((c) => String(c.id) === b.category_id) ? Number(b.category_id) : null,
    description: clampStr(b.description, 2000) || null,
    caption: clampStr(b.caption, 4000) || null,
    platforms: [].concat(b.platforms || []).filter((p) => PLATFORMS.includes(p)).join(','),
    external_url: clampStr(b.external_url, 500) || null,
    destination_key: destinations.some((d) => d.key === b.destination_key) ? b.destination_key : 'home',
    campaign_id: campaigns.some((c) => String(c.id) === b.campaign_id) ? Number(b.campaign_id) : null,
    status: STATUSES[b.status] ? b.status : 'draft',
    file_path: existing ? existing.file_path : null,
    thumb_path: existing ? existing.thumb_path : null,
    media_type: existing ? existing.media_type : 'image',
  };
  const errors = {};
  for (const f of [file, thumb].filter(Boolean)) {
    if (!contentMatchesExtension(f)) {
      fs.rm(f.path, { force: true }, () => {});
      errors[f.fieldname === 'thumb' ? 'thumb' : 'file'] = 'That file’s contents don’t match its type. Upload a real image, video or PDF.';
    }
  }
  if (errors.file || errors.thumb) return renderForm(req, res, { ...existing, ...v }, errors, 422);
  if (!v.title) errors.title = 'Required.';
  if (v.external_url && !/^https:\/\//i.test(v.external_url)) errors.external_url = 'Use a full https:// URL.';
  if (file) {
    if (existing && existing.file_path !== existing.thumb_path) removeUpload(existing.file_path);
    v.file_path = `/uploads/${file.filename}`;
    v.media_type = TYPES[path.extname(file.filename)] || 'document';
    if (v.media_type === 'image' && !thumb) {
      if (existing && existing.thumb_path !== existing.file_path) removeUpload(existing.thumb_path);
      v.thumb_path = v.file_path;
    }
  } else if (!v.file_path && v.external_url) {
    v.media_type = /\.(mp4|mov|webm)(\?|$)/i.test(v.external_url) || /youtu|vimeo/i.test(v.external_url) ? 'video' : 'image';
  }
  if (thumb) {
    if (existing && existing.thumb_path !== existing.file_path) removeUpload(existing.thumb_path);
    v.thumb_path = `/uploads/${thumb.filename}`;
  }
  if (v.status === 'published' && !v.thumb_path) errors.thumb = 'Add a thumbnail image (or upload an image file) before publishing.';
  if (Object.keys(errors).length) return renderForm(req, res, { ...existing, ...v }, errors, 422);

  if (existing) {
    db.run(
      `UPDATE content_assets SET title=@title, category_id=@category_id, description=@description, caption=@caption, platforms=@platforms,
         external_url=@external_url, destination_key=@destination_key, campaign_id=@campaign_id, status=@status, file_path=@file_path,
         thumb_path=@thumb_path, media_type=@media_type, updated_at=datetime('now') WHERE id=@id`,
      { ...v, id: existing.id },
    );
    audit(req, 'content.update', 'content_asset', existing.id, { title: v.title, status: v.status });
  } else {
    const { lastInsertRowid } = db.run(
      `INSERT INTO content_assets (title, category_id, description, caption, platforms, external_url, destination_key, campaign_id, status,
         file_path, thumb_path, media_type, created_by)
       VALUES (@title, @category_id, @description, @caption, @platforms, @external_url, @destination_key, @campaign_id, @status,
         @file_path, @thumb_path, @media_type, @created_by)`,
      { ...v, created_by: req.user.id },
    );
    audit(req, 'content.create', 'content_asset', lastInsertRowid, { title: v.title });
  }
  res.flash('success', 'Asset saved.');
  res.redirect('/admin/content');
}

router.post('/content', perm, upload, verifyCsrf, (req, res) => save(req, res, null));

router.post('/content/:id(\\d+)', perm, upload, verifyCsrf, (req, res, next) => {
  const existing = db.get('SELECT * FROM content_assets WHERE id = ?', req.params.id);
  if (!existing) return next();
  save(req, res, existing);
});

router.post('/content/:id(\\d+)/delete', perm, (req, res) => {
  const a = db.get('SELECT * FROM content_assets WHERE id = ?', req.params.id);
  if (a) {
    // Keep history: archive instead of deleting if affiliates have links to it.
    const used = db.get('SELECT 1 FROM tracked_links WHERE content_id = ? LIMIT 1', a.id);
    if (used) {
      db.run("UPDATE content_assets SET status = 'archived', updated_at = datetime('now') WHERE id = ?", a.id);
      res.flash('info', 'Affiliates have tracked links for this asset, so it was archived instead of deleted.');
    } else {
      db.run('DELETE FROM content_assets WHERE id = ?', a.id);
      removeUpload(a.file_path);
      if (a.thumb_path !== a.file_path) removeUpload(a.thumb_path);
      res.flash('success', 'Asset deleted.');
    }
    audit(req, 'content.delete', 'content_asset', a.id, { title: a.title });
  }
  res.redirect('/admin/content');
});

// ---- Today's 3 --------------------------------------------------------------
router.get('/content/todays-3', perm, (req, res) => {
  const current = Object.fromEntries(db.all('SELECT * FROM todays3').map((t) => [t.rank, t]));
  res.page('admin/todays3', {
    title: 'Today’s 3',
    nav: 'todays3',
    current,
    assets: db.all(`${ASSET_SELECT} WHERE a.status = 'published' ORDER BY a.id DESC`),
    lastSet: db.get('SELECT t.set_at, u.first_name FROM todays3 t LEFT JOIN users u ON u.id = t.set_by ORDER BY t.set_at DESC LIMIT 1'),
  });
});

router.post('/content/todays-3', perm, (req, res) => {
  const picks = [req.body.rank1, req.body.rank2, req.body.rank3].map((v) => Number(v) || null);
  const chosen = picks.filter(Boolean);
  if (new Set(chosen).size !== chosen.length) {
    res.flash('error', 'Pick three different assets.');
    return res.redirect('/admin/content/todays-3');
  }
  db.tx(() => {
    picks.forEach((assetId, i) => {
      const valid = assetId && db.get("SELECT 1 FROM content_assets WHERE id = ? AND status = 'published'", assetId);
      db.run(
        `INSERT INTO todays3 (rank, asset_id, set_by, set_at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(rank) DO UPDATE SET asset_id = excluded.asset_id, set_by = excluded.set_by, set_at = excluded.set_at`,
        i + 1,
        valid ? assetId : null,
        req.user.id,
      );
    });
  });
  audit(req, 'content.todays3', 'todays3', null, picks);
  res.flash('success', 'Today’s 3 updated — affiliates see it right away.');
  res.redirect('/admin/content/todays-3');
});

module.exports = router;
