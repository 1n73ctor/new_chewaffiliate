'use strict';
// Admin-editable settings. Everything management needs to change without a
// code deployment lives here (copy, app-store URLs, reward config, ...).
const db = require('../db');

const GROUPS = [
  {
    id: 'site',
    title: 'Brand & support',
    fields: [
      { key: 'site_name', label: 'Site name', default: 'Chew Network' },
      { key: 'support_email', label: 'Support email', default: 'support@chew.network', type: 'email' },
      { key: 'logo_url', label: 'Logo image URL (optional — replaces the built-in logo)', default: '', type: 'url' },
      { key: 'ways_count_label', label: 'Pathway count label', default: '125+', help: 'Shown as “125+ Ways”. Keep it true to the number of pathways listed.' },
    ],
  },
  {
    id: 'home',
    title: 'Homepage copy',
    fields: [
      { key: 'hero_eyebrow', label: 'Hero eyebrow', default: 'Affiliate Program' },
      { key: 'hero_headline', label: 'Hero headline', default: 'Turn the Trillion Dollar World of Food Into Opportunity.' },
      {
        key: 'hero_subtext',
        label: 'Hero supporting text',
        type: 'textarea',
        default: 'Join the Chew Network Affiliate Program and get the tools, content and technology to be part of a growing food ecosystem.',
      },
      {
        key: 'hero_bullets',
        label: 'Hero bullets (one per line)',
        type: 'textarea',
        default: '100% FREE to join\nNo purchase required\nGet your Affiliate ID and full back office access',
      },
      { key: 'hero_cta_label', label: 'Primary CTA label', default: 'Join Chew Free' },
      {
        key: 'benefit_strip',
        label: 'Quick benefit strip (one per line: Title | Subtitle)',
        type: 'textarea',
        default:
          'Affiliate Back Office | Your tools & tracking\nContent Kitchen™ | Videos, images & more\nTraining & Tutorials | Step-by-step learning\nTrack Your Progress | Clicks, referrals & commissions\n125+ Ways | Across the Chew ecosystem',
      },
      { key: 'final_cta_headline', label: 'Final CTA headline', default: 'Your seat at the table is free.' },
      {
        key: 'final_cta_text',
        label: 'Final CTA text',
        type: 'textarea',
        default: 'Create your account, get your Affiliate ID and open your back office — in about a minute. No purchase required.',
      },
    ],
  },
  {
    id: 'app',
    title: 'See It. Cook It. app',
    fields: [
      { key: 'app_store_url_ios', label: 'Apple App Store URL', default: '', type: 'url', help: 'Leave blank until the listing is live — buttons will say “Coming soon”.' },
      { key: 'app_store_url_android', label: 'Google Play URL', default: '', type: 'url' },
      {
        key: 'app_attribution_params',
        label: 'Append affiliate attribution to store URLs',
        type: 'checkbox',
        default: '1',
        help: 'Adds ct= (Apple campaign token) and referrer= (Google Play install referrer) so installs can be tied back to the affiliate.',
      },
      { key: 'app_ios_provider_token', label: 'Apple provider token (pt=, optional)', default: '' },
      { key: 'app_deep_link_scheme', label: 'App deep-link scheme', default: 'seeitcookit://', help: 'Used for the “Open in app” account-link button.' },
    ],
  },
  {
    id: 'reward',
    title: 'App activation reward (configurable — not final)',
    fields: [
      {
        key: 'reward_enabled',
        label: 'Show and record an activation reward',
        type: 'checkbox',
        default: '0',
        help: 'Keep off until management and counsel finalize the legal/economic structure and terminology.',
      },
      { key: 'reward_label', label: 'Reward name', default: 'Activation Reward' },
      { key: 'reward_amount', label: 'Reward amount (display text)', default: '' },
      { key: 'reward_unit', label: 'Reward unit (e.g. credits)', default: '' },
      { key: 'reward_description', label: 'Reward description', type: 'textarea', default: '' },
    ],
  },
  {
    id: 'sic',
    title: 'See It. Cook It. wholesale credits',
    fields: [
      { key: 'sic_wholesale_enabled', label: 'Offer the Wholesale Affiliate program', type: 'checkbox', default: '1', help: 'Turn off to hide package purchases. Existing balances, grants and claims keep working.' },
      { key: 'sic_video_cost', label: 'Credits used per completed video', type: 'number', default: '399', help: 'The app reports each completed video; this many credits are taken from the creator’s grants.' },
      { key: 'sic_grant_min', label: 'Minimum credits per grant', type: 'number', default: '399' },
      { key: 'sic_grant_max', label: 'Maximum credits per grant', type: 'number', default: '1995', help: 'Affiliates choose a number of videos; the credits must land between the minimum and maximum.' },
      { key: 'sic_claim_expiry_days', label: 'Days a website claim waits for the creator to sign in to the app', type: 'number', default: '14', help: 'Unredeemed claims expire and their credits go back to the affiliate’s inventory.' },
      { key: 'sic_claims_per_ip_day', label: 'Free-credit claims allowed per network per day', type: 'number', default: '3' },
      { key: 'sic_low_balance', label: 'Low-inventory alert below (credits)', type: 'number', default: '1197' },
      { key: 'sic_repurchase_below', label: 'Allow buying more credits only below (credits, 0 = any time)', type: 'number', default: '0', help: 'Replenishment rule for package purchases.' },
      { key: 'sic_price_monthly', label: 'Creator subscription — monthly (display)', default: '$24.95/month' },
      { key: 'sic_price_annual', label: 'Creator subscription — annual (display)', default: '$199/year' },
      { key: 'sic_price_download', label: 'Watermark-free download without subscription (display)', default: '$1.99' },
      {
        key: 'sic_fair_use',
        label: 'Fair-use / technical limits (shown wherever subscriptions are described)',
        type: 'textarea',
        default: 'Subscribers download watermark-free, subject to available credits and fair-use and technical limits. Every video uses credits, so generation is not unlimited.',
      },
      { key: 'sic_payout_threshold', label: 'Minimum approved balance before payout (display)', default: '$50.00' },
      { key: 'sic_site_url', label: 'Consumer site URL (Try See It. Cook It.)', default: 'https://seeitcookit.com', type: 'url' },
      { key: 'sales_email', label: 'Business-affiliate inquiries go to', default: '', type: 'email', help: 'Leave blank to use the support email.' },
      { key: 'wholesale_terms_version', label: 'Wholesale attribution policy version', default: '1.0', help: 'Wholesale affiliates acknowledge this version; change it when the Wholesale Terms change.' },
    ],
  },
  {
    id: 'tracking',
    title: 'Tracking & attribution',
    fields: [
      { key: 'attribution_days', label: 'Attribution window (days)', type: 'number', default: '30' },
    ],
  },
  {
    id: 'ppc',
    title: 'Pay-per-click protection',
    fields: [
      {
        key: 'ppc_unique_hours',
        label: 'Repeat-click window (hours)',
        type: 'number',
        default: '24',
        help: 'One paid click per IP address — and per device — per affiliate in this many hours. Repeat clicks still show in analytics, unpaid.',
      },
      {
        key: 'ppc_daily_cap',
        label: 'Daily paid-click cap per affiliate',
        type: 'number',
        default: '500',
        help: 'Limits how much any one affiliate can earn from clicks in a day (UTC). Extra clicks are tracked but not paid.',
      },
      {
        key: 'ppc_ip_hourly_limit',
        label: 'Click-farm limit (clicks per IP per hour)',
        type: 'number',
        default: '60',
        help: 'An IP that clicks more than this many affiliate links in an hour earns nothing for anyone.',
      },
    ],
  },
  {
    id: 'signup',
    title: 'Signup',
    fields: [
      { key: 'agreement_version', label: 'Current Affiliate Agreement version', default: '1.0', help: 'Recorded with each acceptance. Change it when the agreement text changes.' },
      { key: 'sms_verification', label: 'Offer verification by text message', type: 'checkbox', default: '1' },
    ],
  },
];

const DEFAULTS = Object.fromEntries(GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f.default])));
const KNOWN = new Set(Object.keys(DEFAULTS));

let cache = null;
function load() {
  cache = { ...DEFAULTS };
  for (const row of db.all('SELECT key, value FROM settings')) cache[row.key] = row.value;
  return cache;
}

const all = () => cache || load();
const get = (key) => all()[key];
// Positive whole number from a setting, or the fallback.
function int(key, fallback) {
  const n = Math.floor(Number(get(key)));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function set(key, value, userId = null) {
  db.run(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    key,
    value == null ? '' : String(value),
    userId,
  );
  cache = null;
}

// "{{sic_video_cost}} credits" → "399 credits": keeps prices and credit settings in
// lessons, legal pages and promo copy in step with Settings.
function fill(text) {
  return String(text ?? '').replace(/\{\{([a-z0-9_]+)\}\}/g, (m, key) => {
    if (!KNOWN.has(key)) return m;
    const v = get(key);
    return /^\d+$/.test(String(v)) ? Number(v).toLocaleString('en-US') : String(v ?? '');
  });
}

function lines(key) {
  return String(get(key) || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { GROUPS, DEFAULTS, KNOWN, all, get, int, set, fill, lines, reload: load };
