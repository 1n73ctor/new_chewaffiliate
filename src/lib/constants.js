'use strict';

// "Only programs actually available should be presented as currently active."
const PATHWAY_STATUSES = {
  available: { label: 'Available Now', tone: 'live', note: 'Active today — you can participate now.' },
  coming_soon: { label: 'Coming Soon', tone: 'soon', note: 'Announced, not yet open.' },
  in_development: { label: 'In Development', tone: 'dev', note: 'Being built — details may change.' },
  partner: { label: 'Partner Program', tone: 'partner', note: 'Run with or through a Chew partner; separate terms apply.' },
};

const USER_STATUSES = {
  pending_verification: 'Pending verification',
  pending_agreement: 'Pending agreement',
  active: 'Active',
  suspended: 'Suspended',
  closed: 'Closed',
};

const COMMISSION_STATUSES = {
  pending: 'Pending review',
  approved: 'Approved',
  paid: 'Paid',
  reversed: 'Reversed',
};

const TICKET_STATUSES = { open: 'Open', pending: 'Waiting on affiliate', closed: 'Closed' };
const TICKET_TOPICS = ['Joining & verification', 'Signing in', 'My links & tracking', 'See It. Cook It. app', 'Content Kitchen', 'Commissions', 'Something else'];

const PLATFORMS = ['Instagram', 'TikTok', 'Facebook', 'YouTube Shorts', 'WhatsApp', 'X', 'Pinterest', 'LinkedIn', 'Email', 'Text message'];

const HEAR_ABOUT = ['A friend or family member', 'Social media', 'Chloe / AI assistant', 'Search', 'Event', 'Other'];

const LEGAL_PAGES = ['terms', 'privacy', 'affiliate-agreement', 'promotional-guidelines', 'earnings-disclosure'];

module.exports = { PATHWAY_STATUSES, USER_STATUSES, COMMISSION_STATUSES, TICKET_STATUSES, TICKET_TOPICS, PLATFORMS, HEAR_ABOUT, LEGAL_PAGES };
