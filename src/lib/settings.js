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
    id: 'tracking',
    title: 'Tracking & attribution',
    fields: [
      { key: 'attribution_days', label: 'Attribution window (days)', type: 'number', default: '30' },
    ],
  },
  {
    id: 'signup',
    title: 'Signup',
    fields: [
      { key: 'agreement_version', label: 'Current Affiliate Agreement version', default: '2026-09-draft-1', help: 'Recorded with each acceptance. Change it when the agreement text changes.' },
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

function lines(key) {
  return String(get(key) || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { GROUPS, DEFAULTS, KNOWN, all, get, set, lines, reload: load };
