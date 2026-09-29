'use strict';
// Role-based access for the admin area. "admin" has every permission.
// Support (Vanessa) can help affiliates without developer-level access.

const PERMISSIONS = {
  'admin.dashboard': 'View admin overview',
  'affiliates.view': 'View affiliates',
  'affiliates.support': 'Support actions (resend codes, reset links, notes, manual verification)',
  'affiliates.status': 'Change affiliate status (active / suspended)',
  'affiliates.manage': 'Close accounts and change roles',
  'content.manage': 'Content Kitchen assets, categories and Today’s 3',
  'announcements.manage': 'Announcements',
  'training.manage': 'Training and resources',
  'campaigns.manage': 'Campaigns and tracked links',
  'pathways.manage': '125+ Ways pathways and availability status',
  'pages.manage': 'Legal pages, FAQs and site copy',
  'settings.manage': 'Settings, app-store URLs and reward configuration',
  'tracking.view': 'Tracking reports and exports',
  'commissions.view': 'View commission ledger',
  'commissions.manage': 'Commission rules, approvals, payouts and adjustments',
  'tickets.view': 'View support tickets',
  'tickets.manage': 'Reply to and resolve support tickets',
  'staff.manage': 'Staff accounts and roles',
  'api.manage': 'API keys for app / partner integrations',
  'audit.view': 'Audit log',
};

const ROLES = {
  affiliate: { label: 'Affiliate', perms: [] },
  admin: { label: 'Administrator', perms: ['*'] },
  support: {
    label: 'Support',
    perms: ['admin.dashboard', 'affiliates.view', 'affiliates.support', 'affiliates.status', 'tickets.view', 'tickets.manage', 'tracking.view', 'commissions.view'],
  },
  content: {
    label: 'Content',
    perms: ['admin.dashboard', 'content.manage', 'announcements.manage', 'training.manage', 'campaigns.manage'],
  },
  finance: {
    label: 'Finance',
    perms: ['admin.dashboard', 'affiliates.view', 'tracking.view', 'commissions.view', 'commissions.manage'],
  },
  sales: {
    label: 'Sales',
    perms: ['admin.dashboard', 'affiliates.view', 'tracking.view', 'tickets.view'],
  },
};

const STAFF_ROLES = Object.keys(ROLES).filter((r) => r !== 'affiliate');

function can(user, perm) {
  if (!user) return false;
  const role = ROLES[user.role];
  if (!role) return false;
  return role.perms.includes('*') || role.perms.includes(perm);
}

const isStaff = (user) => !!user && STAFF_ROLES.includes(user.role);

module.exports = { PERMISSIONS, ROLES, STAFF_ROLES, can, isStaff };
