'use strict';
// Base data is inserted automatically on first start (idempotent).
// Demo data (sample Content Kitchen assets + demo staff/affiliate logins) only
// with:  npm run seed:demo
// Demo data never includes clicks, events or commissions — the back office
// must only ever show real tracked activity.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./index');
const config = require('../config');
const { slugify } = require('../lib/util');
const { hashPassword } = require('../lib/auth');
const { generateAffiliateId } = require('../lib/tracking');
const PATHWAYS = require('./seed-data/pathways');
const C = require('./seed-data/content');

const count = (table) => db.get(`SELECT COUNT(*) AS n FROM ${table}`).n;

function ensureBaseData() {
  db.tx(() => {
    if (!count('pathway_categories')) {
      PATHWAYS.forEach((cat, ci) => {
        const { lastInsertRowid: catId } = db.run(
          'INSERT INTO pathway_categories (slug, name, tagline, image, icon, sort) VALUES (?, ?, ?, ?, ?, ?)',
          cat.slug,
          cat.name,
          cat.tagline,
          cat.image,
          cat.icon,
          ci + 1,
        );
        cat.items.forEach(([title, summary, status], i) => {
          db.run('INSERT INTO pathways (category_id, title, summary, status, sort) VALUES (?, ?, ?, ?, ?)', catId, title, summary, status, i + 1);
        });
      });
    }
    if (!count('pages')) {
      for (const p of C.pages) db.run('INSERT INTO pages (slug, title, body, version) VALUES (?, ?, ?, ?)', p.slug, p.title, p.body, 'draft-1');
    }
    if (!count('faqs')) {
      C.faqs.forEach(([q, a, cat], i) => db.run('INSERT INTO faqs (question, answer, category, sort) VALUES (?, ?, ?, ?)', q, a, cat, i + 1));
    }
    if (!count('training_modules')) {
      C.training.forEach((m, mi) => {
        const { lastInsertRowid: moduleId } = db.run('INSERT INTO training_modules (title, summary, sort) VALUES (?, ?, ?)', m.title, m.summary, mi + 1);
        m.lessons.forEach(([title, summary, minutes, body], li) =>
          db.run('INSERT INTO training_lessons (module_id, title, summary, minutes, body, sort) VALUES (?, ?, ?, ?, ?, ?)', moduleId, title, summary, minutes, body, li + 1),
        );
      });
    }
    if (!count('resources')) {
      C.resources.forEach(([title, description, category, url, audience], i) =>
        db.run('INSERT INTO resources (title, description, category, url, audience, sort) VALUES (?, ?, ?, ?, ?, ?)', title, description, category, url, audience, i + 1),
      );
    }
    if (!count('destinations')) {
      C.destinations.forEach(([key, label, kind, url], i) => db.run('INSERT INTO destinations (key, label, kind, url, sort) VALUES (?, ?, ?, ?, ?)', key, label, kind, url, i + 1));
    }
    if (!count('content_categories')) {
      C.contentCategories.forEach((name, i) => db.run('INSERT INTO content_categories (slug, name, sort) VALUES (?, ?, ?)', slugify(name), name, i + 1));
    }
    if (!count('announcements')) {
      for (const a of C.announcements) {
        db.run('INSERT INTO announcements (title, body, link_url, link_label, pinned, published) VALUES (?, ?, ?, ?, ?, ?)', a.title, a.body, a.link_url, a.link_label, a.pinned, a.published);
      }
    }
  });
  ensureAdmin();
}

function ensureAdmin() {
  if (db.get("SELECT 1 FROM users WHERE role = 'admin'")) return;
  let password = config.admin.password;
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  db.run(
    `INSERT INTO users (first_name, last_name, email, password_hash, role, status, email_verified_at, terms_accepted_at)
     VALUES ('Site', 'Admin', ?, ?, 'admin', 'active', datetime('now'), datetime('now'))`,
    config.admin.email,
    hashPassword(password),
  );
  if (generated && !config.isTest) {
    const file = path.join(config.dataDir, 'initial-admin.txt');
    fs.writeFileSync(file, `email: ${config.admin.email}\npassword: ${password}\n`, { mode: 0o600 });
    console.log(`\nCreated admin account ${config.admin.email} — password saved to ${file}\n`);
  }
}

function seedDemo() {
  ensureBaseData();
  const cats = Object.fromEntries(db.all('SELECT id, slug FROM content_categories').map((c) => [c.slug, c.id]));
  const demoPassword = process.env.DEMO_PASSWORD || 'ChewDemo-2026';

  db.tx(() => {
    if (!db.get("SELECT 1 FROM campaigns WHERE slug = 'fall-launch'")) {
      db.run("INSERT INTO campaigns (slug, name, description, destination_key) VALUES ('fall-launch', 'Fall Launch (demo)', 'Sample campaign for testing tracked links.', 'see-it-cook-it')");
    }
    const campaignId = db.get("SELECT id FROM campaigns WHERE slug = 'fall-launch'").id;

    if (!count('content_assets')) {
      const assets = [
        ['Pesto farfalle in 20 minutes', 'recipes', 'pasta-salad', 'Instagram,Pinterest,Facebook', 'see-it-cook-it',
          'Bow-tie pasta, basil pesto and blistered tomatoes — dinner in 20 minutes. Snap a photo of any dish and See It. Cook It. gives you the recipe 👉 {link} #ad #chewnetwork'],
        ['Snap it. Get the recipe.', 'see-it-cook-it', 'salad-dark', 'TikTok,Instagram,YouTube Shorts', 'app',
          'Saw a dish you love? Point your camera at it and See It. Cook It. shows you the recipe — then watches it come to life. Free download 👉 {link} #ad'],
        ['Pancake stack, the easy way', 'short-videos', 'pancakes', 'TikTok,Instagram,YouTube Shorts', 'see-it-cook-it',
          'Fluffy pancakes, zero guesswork. Get the step-by-step with See It. Cook It. 👉 {link} #ad'],
        ['Join Chew — it’s free', 'join-the-program', 'table-spread', 'Facebook,WhatsApp,LinkedIn', 'join',
          'I joined the Chew Network affiliate program — it’s free and there’s nothing to buy. Food, AI and a back office full of tools. Take a look 👉 {link} #affiliate'],
        ['Rainbow grain bowl', 'recipes', 'grain-bowl', 'Instagram,Pinterest', 'see-it-cook-it',
          'Eat the rainbow: quinoa, roasted veg, greens and a lemon-tahini drizzle. Recipe 👉 {link} #ad'],
        ['Chef Pepe says: taste as you go', 'chef-pepe', 'kitchen-friends', 'Facebook,Instagram', 'home',
          'Chef Pepe’s #1 tip: taste as you go. Season a little, taste, repeat. More kitchen tips 👉 {link} #ad'],
        ['Weekend grill platter', 'seasonal', 'skewers', 'Facebook,Instagram,Pinterest', 'see-it-cook-it',
          'Skewers, grilled veg and dips — a weekend platter everyone can build. Get the recipe 👉 {link} #ad'],
        ['Eggs & greens breakfast', 'recipes', 'eggs-spinach', 'Instagram,Pinterest', 'see-it-cook-it',
          'Soft-boiled eggs, avocado and spinach: a 10-minute breakfast. Recipe 👉 {link} #ad'],
        ['Pizza night, upgraded', 'short-videos', 'pizza', 'TikTok,Instagram,YouTube Shorts', 'app',
          'Homemade pizza that looks like this? Snap it, get the recipe, watch it cook. 👉 {link} #ad'],
      ];
      const ids = assets.map(([title, cat, img, platforms, dest, caption]) =>
        db.run(
          `INSERT INTO content_assets (category_id, title, description, caption, platforms, media_type, file_path, thumb_path, destination_key, campaign_id, status)
           VALUES (?, ?, ?, ?, ?, 'image', ?, ?, ?, ?, 'published')`,
          cats[cat] || null,
          title,
          'Sample asset — replace with approved media from the Content Kitchen team.',
          caption,
          platforms,
          `/img/food/${img}.webp`,
          `/img/food/${img}.webp`,
          dest,
          dest === 'see-it-cook-it' ? campaignId : null,
        ).lastInsertRowid,
      );
      [ids[1], ids[0], ids[3]].forEach((assetId, i) => db.run('INSERT OR REPLACE INTO todays3 (rank, asset_id) VALUES (?, ?)', i + 1, assetId));
    }

    const demoUsers = [
      ['Vanessa', 'Support', 'support@chew.local', 'support'],
      ['Ram', 'Content', 'content@chew.local', 'content'],
      ['Finance', 'Team', 'finance@chew.local', 'finance'],
      ['Mike', 'Sales', 'sales@chew.local', 'sales'],
    ];
    for (const [first, last, email, role] of demoUsers) {
      if (db.get('SELECT 1 FROM users WHERE email = ?', email)) continue;
      db.run(
        `INSERT INTO users (first_name, last_name, email, password_hash, role, status, email_verified_at, terms_accepted_at)
         VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
        first,
        last,
        email,
        hashPassword(demoPassword),
        role,
      );
    }
    if (!db.get("SELECT 1 FROM users WHERE email = 'affiliate@chew.local'")) {
      db.run(
        `INSERT INTO users (affiliate_id, first_name, last_name, email, mobile, country, password_hash, role, status,
                            email_verified_at, terms_accepted_at, agreement_version, agreement_accepted_at)
         VALUES (?, 'Demo', 'Affiliate', 'affiliate@chew.local', '+15555550100', 'US', ?, 'affiliate', 'active',
                 datetime('now'), datetime('now'), 'draft-1', datetime('now'))`,
        generateAffiliateId(),
        hashPassword(demoPassword),
      );
    }
  });
  console.log(`Demo data ready. Demo logins (password: ${demoPassword}):
  affiliate@chew.local  (affiliate back office)
  support@chew.local    (support-level admin)
  content@chew.local    (content manager)
  finance@chew.local    (finance)
  sales@chew.local      (sales, read-only)`);
}

module.exports = { ensureBaseData, seedDemo };

if (require.main === module) {
  db.migrate();
  if (process.argv.includes('--demo')) seedDemo();
  else {
    ensureBaseData();
    console.log('Base data ready.');
  }
}
