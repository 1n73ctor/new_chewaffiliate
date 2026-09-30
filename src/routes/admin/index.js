'use strict';
const router = require('express').Router();
const db = require('../../db');
const stats = require('../../lib/stats');
const { can, isStaff, ROLES } = require('../../lib/permissions');
const { requireLogin } = require('../../lib/auth');

// Sidebar, filtered by the signed-in role's permissions.
const NAV = [
  { section: null, items: [{ key: 'dashboard', href: '/admin', label: 'Overview', icon: 'dashboard', perm: 'admin.dashboard' }] },
  {
    section: 'People',
    items: [
      { key: 'affiliates', href: '/admin/affiliates', label: 'Affiliates', icon: 'users', perm: 'affiliates.view' },
      { key: 'tickets', href: '/admin/tickets', label: 'Support tickets', icon: 'ticket', perm: 'tickets.view' },
    ],
  },
  {
    section: 'Content',
    items: [
      { key: 'content', href: '/admin/content', label: 'Content Kitchen', icon: 'kitchen', perm: 'content.manage' },
      { key: 'todays3', href: '/admin/content/todays-3', label: 'Today’s 3', icon: 'flame', perm: 'content.manage' },
      { key: 'm-content_categories', href: '/admin/m/content_categories', label: 'Content categories', icon: 'list', perm: 'content.manage' },
      { key: 'm-announcements', href: '/admin/m/announcements', label: 'Announcements', icon: 'bell', perm: 'announcements.manage' },
      { key: 'm-training_modules', href: '/admin/m/training_modules', label: 'Training modules', icon: 'training', perm: 'training.manage' },
      { key: 'm-training_lessons', href: '/admin/m/training_lessons', label: 'Training lessons', icon: 'book', perm: 'training.manage' },
      { key: 'm-resources', href: '/admin/m/resources', label: 'Resources', icon: 'resources', perm: 'training.manage' },
    ],
  },
  {
    section: '125+ Ways',
    items: [
      { key: 'm-pathways', href: '/admin/m/pathways', label: 'Pathways & status', icon: 'grid', perm: 'pathways.manage' },
      { key: 'm-pathway_categories', href: '/admin/m/pathway_categories', label: 'Pathway categories', icon: 'list', perm: 'pathways.manage' },
    ],
  },
  {
    section: 'Tracking',
    items: [
      { key: 'tracking', href: '/admin/tracking', label: 'Tracking report', icon: 'chart', perm: 'tracking.view' },
      { key: 'm-campaigns', href: '/admin/m/campaigns', label: 'Campaigns', icon: 'megaphone', perm: 'campaigns.manage' },
      { key: 'links', href: '/admin/links', label: 'Tracked links', icon: 'link', perm: 'campaigns.manage' },
      { key: 'm-destinations', href: '/admin/m/destinations', label: 'Destinations & products', icon: 'external', perm: 'campaigns.manage' },
    ],
  },
  {
    section: 'Commissions',
    items: [
      { key: 'commissions', href: '/admin/commissions', label: 'Ledger', icon: 'dollar', perm: 'commissions.view' },
      { key: 'm-commission_rules', href: '/admin/m/commission_rules', label: 'Commission rules', icon: 'settings', perm: 'commissions.manage' },
    ],
  },
  {
    section: 'Site',
    items: [
      { key: 'settings', href: '/admin/settings', label: 'Settings & app links', icon: 'settings', perm: 'settings.manage' },
      { key: 'pages', href: '/admin/pages', label: 'Legal pages', icon: 'book', perm: 'pages.manage' },
      { key: 'm-faqs', href: '/admin/m/faqs', label: 'Help FAQs', icon: 'help', perm: 'pages.manage' },
      { key: 'staff', href: '/admin/staff', label: 'Staff & roles', icon: 'shield', perm: 'staff.manage' },
      { key: 'api', href: '/admin/api-keys', label: 'API keys', icon: 'key', perm: 'api.manage' },
      { key: 'audit', href: '/admin/audit', label: 'Audit log', icon: 'clock', perm: 'audit.view' },
    ],
  },
];

router.use(requireLogin, (req, res, next) => {
  if (!isStaff(req.user)) return res.redirect(req.user.affiliate_id ? '/office' : '/');
  res.locals.layout = 'admin';
  res.locals.roleLabel = ROLES[req.user.role].label;
  res.locals.adminNav = NAV.map((s) => ({ ...s, items: s.items.filter((i) => can(req.user, i.perm)) })).filter((s) => s.items.length);
  res.locals.openTickets = can(req.user, 'tickets.view') ? db.get("SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'open'").n : 0;
  next();
});

router.get('/', (req, res) => {
  if (!can(req.user, 'admin.dashboard')) return res.redirect(res.locals.adminNav[0].items[0].href);
  const counts = {
    active: db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'affiliate' AND status = 'active'").n,
    pending: db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'affiliate' AND status IN ('pending_verification','pending_agreement')").n,
    joined7: db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'affiliate' AND status = 'active' AND agreement_accepted_at >= datetime('now', '-7 days')").n,
    activated: db.get('SELECT COUNT(*) AS n FROM users WHERE app_activated_at IS NOT NULL').n,
    tickets: db.get("SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'open'").n,
    assets: db.get("SELECT COUNT(*) AS n FROM content_assets WHERE status = 'published'").n,
    available: db.get("SELECT COUNT(*) AS n FROM pathways WHERE status = 'available'").n,
    pathways: db.get('SELECT COUNT(*) AS n FROM pathways').n,
  };
  res.page('admin/dashboard', {
    title: 'Admin overview',
    nav: 'dashboard',
    counts,
    summary: stats.summary({}, 7),
    series: stats.clicksByDay({}, 30),
    recentSignups: db.all(
      "SELECT id, affiliate_id, first_name, last_name, email, status, created_at FROM users WHERE role = 'affiliate' ORDER BY id DESC LIMIT 8",
    ),
    recentTickets: can(req.user, 'tickets.view') ? db.all('SELECT * FROM support_tickets ORDER BY id DESC LIMIT 5') : [],
  });
});

router.use(require('./account'));
router.use('/m', require('./crud'));
router.use(require('./affiliates'));
router.use(require('./content'));
router.use(require('./tracking'));
router.use(require('./commissions'));
router.use(require('./tickets'));
router.use(require('./system'));

module.exports = router;
