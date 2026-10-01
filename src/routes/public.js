'use strict';
const router = require('express').Router();
const db = require('../db');
const settings = require('../lib/settings');
const rateLimit = require('../lib/rateLimit');
const { sendEmail } = require('../lib/notify');
const { PATHWAY_STATUSES, LEGAL_PAGES, TICKET_TOPICS } = require('../lib/constants');
const { clampStr } = require('../lib/util');

function pathwayCategories() {
  return db.all(`
    SELECT c.*, COUNT(p.id) AS total,
           SUM(CASE WHEN p.status = 'available' THEN 1 ELSE 0 END) AS available
    FROM pathway_categories c LEFT JOIN pathways p ON p.category_id = c.id
    GROUP BY c.id ORDER BY c.sort, c.id`);
}

router.get('/', (req, res) => {
  res.page('public/home', {
    categories: pathwayCategories(),
    pathwayTotal: db.get('SELECT COUNT(*) AS n FROM pathways').n,
    bodyClass: 'page-home',
  });
});

router.get('/how-it-works', (req, res) => {
  res.page('public/how-it-works', {
    title: 'How It Works',
    description: 'Join free, get your Affiliate ID, access your tools, learn, share and track — in six simple steps.',
  });
});

// Shared by the public page and the back office.
function waysData(query) {
  const categories = pathwayCategories();
  const category = categories.find((c) => c.slug === query.category) || null;
  const status = PATHWAY_STATUSES[query.status] ? query.status : null;
  const where = [];
  const params = [];
  if (category) {
    where.push('p.category_id = ?');
    params.push(category.id);
  }
  if (status) {
    where.push('p.status = ?');
    params.push(status);
  }
  const pathways = db.all(
    `SELECT p.*, c.slug AS category_slug, c.name AS category_name FROM pathways p
     JOIN pathway_categories c ON c.id = p.category_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY c.sort, CASE p.status WHEN 'available' THEN 0 ELSE 1 END, p.sort`,
    ...params,
  );
  const statusCounts = Object.fromEntries(Object.keys(PATHWAY_STATUSES).map((k) => [k, 0]));
  for (const row of db.all('SELECT status, COUNT(*) AS n FROM pathways GROUP BY status')) statusCounts[row.status] = row.n;
  const available = db.all(
    `SELECT p.*, c.name AS category_name FROM pathways p JOIN pathway_categories c ON c.id = p.category_id
     WHERE p.status = 'available' ORDER BY c.sort, p.sort`,
  );
  const grouped = categories.map((c) => ({ ...c, items: pathways.filter((p) => p.category_id === c.id) })).filter((c) => c.items.length);
  return { categories, category, status, grouped, available, statusCounts, total: db.get('SELECT COUNT(*) AS n FROM pathways').n };
}

router.get('/ways-to-earn', (req, res) => {
  res.page('public/ways', {
    title: `${settings.get('ways_count_label')} Ways to Participate`,
    description: 'Every way to participate across the Chew ecosystem — clearly labeled Available Now, Coming Soon, In Development or Partner Program.',
    ...waysData(req.query),
  });
});

router.get('/see-it-cook-it', (req, res) => {
  const store = ['ios', 'android'].includes(req.query.store) ? req.query.store : null;
  res.page('public/see-it-cook-it', {
    title: 'See It. Cook It.',
    description: 'Capture food. Get the recipe. Watch it come to life. Download See It. Cook It. for iPhone and Android.',
    storeUnavailable: store,
  });
});

router.get('/resources', (req, res) => {
  const resources = db.all("SELECT * FROM resources WHERE published = 1 AND audience = 'public' ORDER BY category, sort, id");
  res.page('public/resources', {
    title: 'Resources',
    description: 'Program documents, guidelines and getting-started guides for Chew Network affiliates.',
    resources,
  });
});

function faqGroups() {
  const groups = [];
  for (const f of db.all('SELECT * FROM faqs WHERE published = 1 ORDER BY sort, id')) {
    let g = groups.find((x) => x.name === (f.category || 'General'));
    if (!g) groups.push((g = { name: f.category || 'General', items: [] }));
    g.items.push(f);
  }
  return groups;
}

router.get('/help', (req, res) => {
  res.page('public/help', {
    title: 'Help & Support',
    description: 'Answers to common questions and a direct line to Chew affiliate support.',
    groups: faqGroups(),
    topics: TICKET_TOPICS,
    form: {},
    errors: {},
  });
});

router.post('/help/contact', rateLimit({ windowMs: 3_600_000, max: 8 }), async (req, res) => {
  const form = {
    name: clampStr(req.body.name, 120),
    email: clampStr(req.body.email, 200).toLowerCase(),
    topic: TICKET_TOPICS.includes(req.body.topic) ? req.body.topic : TICKET_TOPICS[TICKET_TOPICS.length - 1],
    subject: clampStr(req.body.subject, 160),
    message: clampStr(req.body.message, 5000),
  };
  if (req.user) {
    form.name ||= `${req.user.first_name} ${req.user.last_name}`;
    form.email ||= req.user.email;
  }
  const errors = {};
  if (!form.name) errors.name = 'Please enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = 'Please enter a valid email.';
  if (!form.subject) errors.subject = 'Please add a subject.';
  if (form.message.length < 10) errors.message = 'Please describe what you need help with.';
  if (Object.keys(errors).length) {
    return res.status(422).page('public/help', { title: 'Help & Support', groups: faqGroups(), topics: TICKET_TOPICS, form, errors });
  }
  const { lastInsertRowid: id } = db.run(
    'INSERT INTO support_tickets (user_id, name, email, topic, subject, message) VALUES (?, ?, ?, ?, ?, ?)',
    req.user ? req.user.id : null,
    form.name,
    form.email,
    form.topic,
    form.subject,
    form.message,
  );
  await sendEmail({
    to: form.email,
    userId: req.user ? req.user.id : null,
    subject: `We received your support request (#${id})`,
    // Generic on purpose: anyone can enter any address here, so echo nothing they typed.
    text: `Hello,\n\nThanks for contacting Chew Network support. Your request #${id} is with our team and we’ll reply to this address.\n\nIf you didn’t contact us, you can ignore this email.\n\nChew Network Support`,
  });
  res.flash('success', `Thanks — your request #${id} is with our support team. We’ll reply by email.`);
  res.redirect('/help#contact');
});

router.get('/support', (req, res) => res.redirect('/help#contact'));

router.get('/search', (req, res) => {
  const q = clampStr(req.query.q, 80);
  let results = { pathways: [], faqs: [], resources: [], pages: [] };
  if (q.length >= 2) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    results = {
      pathways: db.all(
        `SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM pathways p JOIN pathway_categories c ON c.id = p.category_id
         WHERE p.title LIKE ? OR p.summary LIKE ? OR c.name LIKE ? ORDER BY CASE p.status WHEN 'available' THEN 0 ELSE 1 END, c.sort, p.sort LIMIT 30`,
        like,
        like,
        like,
      ),
      faqs: db.all('SELECT * FROM faqs WHERE published = 1 AND (question LIKE ? OR answer LIKE ?) ORDER BY sort LIMIT 10', like, like),
      resources: db.all("SELECT * FROM resources WHERE published = 1 AND audience = 'public' AND (title LIKE ? OR description LIKE ?) LIMIT 10", like, like),
      pages: db.all('SELECT slug, title, body FROM pages WHERE title LIKE ? OR body LIKE ? LIMIT 10', like, like),
    };
  }
  const total = Object.values(results).reduce((n, list) => n + list.length, 0);
  res.page('public/search', { title: q ? `Search: ${q}` : 'Search', q, results, total });
});

router.get(`/:slug(${LEGAL_PAGES.join('|')})`, (req, res, next) => {
  const page = db.get('SELECT * FROM pages WHERE slug = ?', req.params.slug);
  if (!page) return next();
  res.page('public/legal', { title: page.title, page });
});

module.exports = router;
module.exports.pathwayCategories = pathwayCategories;
module.exports.waysData = waysData;
