'use strict';
// End-to-end checks against the blueprint's Definition of Done (§16).
// Runs the real app on a random port with a throwaway database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
process.env.NODE_ENV = 'test';
process.env.PORT = String(PORT);
process.env.BASE_URL = BASE;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chew-test-'));
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'Admin-Pass-123';
process.env.RATE_LIMIT_FACTOR = '100';

const createApp = require('../src/app');
const db = require('../src/db');

const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

class Client {
  constructor(ua = BROWSER_UA) {
    this.jar = {};
    this.ua = ua;
  }
  csrf() {
    return decodeURIComponent(this.jar.chew_csrf || '');
  }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (!v || /expires=Thu, 01 Jan 1970/i.test(c)) delete this.jar[k];
      else this.jar[k] = v;
    }
  }
  async req(method, p, { form, json, headers = {}, body } = {}) {
    const h = { 'user-agent': this.ua, cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '), ...headers };
    let payload = body;
    if (form) {
      const params = new URLSearchParams(form);
      if (!params.has('_csrf')) params.set('_csrf', this.csrf());
      h['content-type'] = 'application/x-www-form-urlencoded';
      payload = params.toString();
    }
    if (json) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const res = await fetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  }
  get(p, o) {
    return this.req('GET', p, o);
  }
  post(p, form, o = {}) {
    return this.req('POST', p, { form, ...o });
  }
  async signin(email, password) {
    await this.get('/signin');
    return this.post('/signin', { email, password });
  }
}

const latestCode = (email) => {
  const m = db.get('SELECT body FROM outbox WHERE recipient = ? ORDER BY id DESC LIMIT 1', email).body.match(/\b(\d{6})\b/);
  return m && m[1];
};

// Full signup: JOIN → REGISTRATION → VERIFICATION → AGREEMENT → ACCOUNT → AFFILIATE ID → WELCOME → BACK OFFICE
async function signup(client, { first = 'Test', last = 'User', email, extra = {} }) {
  const page = await client.get('/join');
  assert.equal(page.status, 200);
  let r = await client.post('/join', { first_name: first, last_name: last, email, mobile: '(555) 555-0101', country: 'US', password: 'Secret-Pass-1', terms: '1', ...extra });
  assert.equal(r.status, 302, r.text.slice(0, 500));
  assert.equal(r.location, '/join/verify');
  r = await client.post('/join/verify', { code: latestCode(email) });
  assert.equal(r.location, '/join/agreement');
  r = await client.post('/join/agreement', { agree: '1' });
  assert.equal(r.location, '/join/welcome');
  const welcome = await client.get('/join/welcome');
  assert.equal(welcome.status, 200);
  return db.get('SELECT * FROM users WHERE email = ?', email);
}

let server;
const admin = new Client();
const state = {};

before(async () => {
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  const r = await admin.signin('admin@test.local', 'Admin-Pass-123');
  assert.equal(r.location, '/admin');
});

after(() => {
  server.close();
  db.raw.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('homepage follows the blueprint build order and is mobile-ready', async () => {
  const { status, text } = await new Client().get('/');
  assert.equal(status, 200);
  assert.match(text, /name="viewport"/);
  const order = [
    'class="eyebrow">Affiliate Program',
    'Turn the Trillion Dollar World of Food Into Opportunity.',
    '100% Free',
    'JOIN CHEW FREE',
    'Already an affiliate?',
    'Affiliate Back Office</strong>',
    'Content Kitchen™</strong>',
    'class="display">See It. Cook It.',
    'Take a Photo',
    'Ways to Participate',
    'EXPLORE ALL 125+ WAYS',
    'Your Affiliate Back Office',
    'class="eyebrow">How It Works',
    'class="final-cta"',
    'Earnings Disclosure</a>',
  ];
  let last = -1;
  for (const marker of order) {
    const i = text.indexOf(marker, last + 1);
    assert.ok(i > last, `"${marker}" should appear after the previous section`);
    last = i;
  }
  // Header: nav, search, Sign In and JOIN FREE
  for (const s of ['How It Works', 'Ways to Earn', 'See It. Cook It.', 'Resources', 'Help', 'role="search"', 'Sign In', 'JOIN FREE']) assert.ok(text.includes(s), s);
  // 8 category cards, no 125-item dump
  assert.equal((text.match(/class="cat-card"/g) || []).length, 8);
  assert.ok(!text.includes('path-item'));
  // Footer legal links
  for (const href of ['/terms', '/privacy', '/affiliate-agreement', '/promotional-guidelines', '/earnings-disclosure', '/help#contact']) assert.ok(text.includes(`href="${href}"`), href);
});

test('all public pages render', async () => {
  const c = new Client();
  for (const p of ['/how-it-works', '/ways-to-earn', '/see-it-cook-it', '/resources', '/help', '/search?q=chef', '/terms', '/privacy', '/affiliate-agreement', '/promotional-guidelines', '/earnings-disclosure', '/signin', '/join']) {
    const r = await c.get(p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await c.get('/does-not-exist')).status, 404);
  // No pre-launch draft notices on the public legal pages
  for (const p of ['/terms', '/privacy', '/affiliate-agreement', '/promotional-guidelines', '/earnings-disclosure']) {
    const { text } = await c.get(p);
    assert.ok(!/draft/i.test(text), `${p} should not mention a draft`);
  }
});

test('125+ ways page separates live pathways from future ones', async () => {
  const total = db.get('SELECT COUNT(*) AS n FROM pathways').n;
  assert.ok(total >= 125, `${total} pathways`);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM pathway_categories').n, 8);
  const { text } = await new Client().get('/ways-to-earn');
  assert.ok(text.includes('Available now'));
  for (const label of ['Available Now', 'Coming Soon', 'In Development', 'Partner Program']) assert.ok(text.includes(label), label);
  const live = await new Client().get('/ways-to-earn?status=available');
  const count = db.get("SELECT COUNT(*) AS n FROM pathways WHERE status = 'available'").n;
  assert.equal((live.text.match(/class="path-item is-live"/g) || []).length, count * 2); // box + category list
});

test('free signup creates a unique Affiliate ID and back office, with separate consents', async () => {
  const c = new Client();
  const u = await signup(c, { first: 'Ava', last: 'Sponsor', email: 'ava@test.local', extra: { marketing_consent: '1' } });
  assert.match(u.affiliate_id, /^CHW[2-9A-HJ-NP-Z]{6}$/);
  assert.equal(u.status, 'active');
  assert.equal(u.mobile, '+15555550101');
  assert.equal(u.marketing_consent, 1);
  assert.equal(u.sms_consent, 0);
  assert.ok(u.terms_accepted_at && u.agreement_accepted_at && u.agreement_version && u.email_verified_at);
  const office = await c.get('/office');
  assert.equal(office.status, 200);
  assert.ok(office.text.includes(u.affiliate_id));
  assert.ok(office.text.includes(`/a/${u.affiliate_id}`));
  assert.ok(office.text.includes('<svg'), 'QR code rendered');
  assert.ok(office.text.includes('TODAY’S 3'));
  // No fabricated activity on a brand-new account
  assert.ok(/<span class="label">Clicks<\/span><span class="value">0<\/span>/.test(office.text));
  assert.ok(!/payment|credit card/i.test((await c.get('/join/welcome')).text));
  state.ava = u;
  state.avaClient = c;
});

test('verification rejects wrong codes and the flow cannot be skipped', async () => {
  const c = new Client();
  await c.get('/join');
  await c.post('/join', { first_name: 'Skip', last_name: 'Per', email: 'skip@test.local', mobile: '5555550102', country: 'US', password: 'Secret-Pass-1', terms: '1' });
  assert.equal((await c.get('/office')).location, '/join/verify');
  assert.equal((await c.get('/join/agreement')).location, '/join/verify');
  const bad = await c.post('/join/verify', { code: '000000' === latestCode('skip@test.local') ? '111111' : '000000' });
  assert.equal(bad.status, 422);
  // Terms are required; consents are not
  const c2 = new Client();
  await c2.get('/join');
  const noTerms = await c2.post('/join', { first_name: 'No', last_name: 'Terms', email: 'noterms@test.local', mobile: '5555550103', country: 'US', password: 'Secret-Pass-1' });
  assert.equal(noTerms.status, 422);
});

test('admin creates an API key, a commission rule and app-store URLs without code changes', async () => {
  await admin.get('/admin/api-keys');
  const keyPage = await admin.post('/admin/api-keys', { name: 'See It. Cook It. test' });
  state.apiKey = keyPage.text.match(/(chk_[A-Za-z0-9_-]+)/)[1];
  const rule = await admin.post('/admin/m/commission_rules', { name: 'Referred affiliate joined', event_type: 'affiliate_signup', amount_cents: '5.00', percent_bps: '', currency: 'USD', active: '1' });
  assert.equal(rule.status, 302);
  await admin.post('/admin/m/commission_rules', { name: 'Partner purchase', event_type: 'purchase', amount_cents: '', percent_bps: '10', currency: 'USD', active: '1' });
  const s = await admin.post('/admin/settings', { _group: 'app', app_store_url_ios: 'https://apps.apple.com/app/id123456', app_store_url_android: 'https://play.google.com/store/apps/details?id=com.chew.seeitcookit', app_attribution_params: '1', app_deep_link_scheme: 'seeitcookit://' });
  assert.equal(s.status, 302);
});

test('referral link click → signup is attributed with the full tracking chain', async () => {
  const visitor = new Client();
  const click = await visitor.get(`/a/${state.ava.affiliate_id}?s=instagram`);
  assert.equal(click.status, 302);
  assert.ok(visitor.jar.chew_attr, 'attribution cookie set');
  const row = db.get('SELECT * FROM clicks WHERE affiliate_user_id = ? ORDER BY id DESC LIMIT 1', state.ava.id);
  assert.equal(row.source, 'instagram');
  assert.equal(row.is_bot, 0);
  const join = await visitor.get('/join');
  assert.ok(join.text.includes('You were invited by'));
  const ben = await signup(visitor, { first: 'Ben', last: 'Referred', email: 'ben@test.local' });
  assert.equal(ben.referred_by, state.ava.id);
  assert.equal(ben.referral_click_id, row.click_id);
  const ev = db.get("SELECT * FROM events WHERE type = 'affiliate_signup' AND subject_user_id = ?", ben.id);
  assert.equal(ev.affiliate_user_id, state.ava.id);
  assert.equal(ev.source, 'instagram');
  const com = db.get('SELECT * FROM commissions WHERE event_id = ?', ev.id);
  assert.equal(com.amount_cents, 500);
  assert.equal(com.status, 'pending');
  state.ben = ben;
  // Link previews (bots) are recorded but excluded and never overwrite attribution
  const bot = new Client('facebookexternalhit/1.1');
  await bot.get(`/a/${state.ava.affiliate_id}`);
  assert.equal(bot.jar.chew_attr, undefined);
  const dash = await state.avaClient.get('/office');
  assert.ok(/<span class="label">Clicks<\/span><span class="value">1<\/span>/.test(dash.text), 'real clicks only');
  assert.ok(dash.text.includes('$5.00 pending review'));
});

test('Content Kitchen: upload, Today’s 3, Copy Caption, Get My Link, Download, usage status', async () => {
  // Admin uploads an image asset (multipart)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.set('_csrf', admin.csrf());
  fd.set('title', 'Test pancake reel');
  fd.set('caption', 'Pancakes! Recipe 👉 {link} #ad');
  fd.set('platforms', 'Instagram');
  fd.set('destination_key', 'see-it-cook-it');
  fd.set('status', 'published');
  fd.set('file', new Blob([png], { type: 'image/png' }), 'pancake.png');
  const up = await fetch(BASE + '/admin/content', { method: 'POST', body: fd, redirect: 'manual', headers: { cookie: Object.entries(admin.jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(up.status, 302);
  const asset = db.get("SELECT * FROM content_assets WHERE title = 'Test pancake reel'");
  assert.ok(asset.file_path.startsWith('/uploads/'));
  const t3 = await admin.post('/admin/content/todays-3', { rank1: String(asset.id), rank2: '', rank3: '' });
  assert.equal(t3.status, 302);

  const c = state.avaClient;
  let kitchen = await c.get('/office/content-kitchen');
  assert.ok(kitchen.text.includes('Test pancake reel'));
  for (const s of ['Preview', 'Copy Caption', 'Get My Link', 'Download', 'Best on:', 'TODAY’S 3']) assert.ok(kitchen.text.includes(s), s);
  assert.ok(kitchen.text.includes('data-usage>New<'));

  const cap = await c.post(`/office/content-kitchen/${asset.id}/caption`, {}, { headers: { accept: 'application/json' } });
  const { caption, url } = JSON.parse(cap.text);
  assert.ok(caption.startsWith('Pancakes! Recipe 👉 ' + BASE + '/r/'));
  const link = await c.post(`/office/content-kitchen/${asset.id}/link`, {}, { headers: { accept: 'application/json' } });
  assert.equal(JSON.parse(link.text).url, url, 'same link reused');
  const dl = await c.get(`/office/content-kitchen/${asset.id}/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  kitchen = await c.get('/office/content-kitchen');
  assert.ok(kitchen.text.includes('data-usage>Used<'));

  // A visitor clicks the content link → WHO/WHAT CONTENT/SOURCE/LINK/PRODUCT recorded
  const visitor = new Client();
  const r = await visitor.get(new URL(url).pathname);
  assert.equal(r.location, '/see-it-cook-it');
  const k = db.get('SELECT * FROM clicks ORDER BY id DESC LIMIT 1');
  assert.equal(k.affiliate_user_id, state.ava.id);
  assert.equal(k.content_id, asset.id);
  assert.ok(k.link_id);
  assert.equal(k.destination_key, 'see-it-cook-it');
  // …and the admin report shows it
  const rep = await admin.get(`/admin/tracking?affiliate=${state.ava.affiliate_id}`);
  assert.ok(rep.text.includes('Test pancake reel'));
});

test('tracked links and QR codes work', async () => {
  const c = state.avaClient;
  const r = await c.post('/office/links', { destination_key: 'join', source: 'whatsapp', label: 'Family group' });
  const code = r.location.match(/created=([A-Z0-9]+)/)[1];
  const qrSvg = await c.get(`/office/qr/${code}.svg`);
  assert.equal(qrSvg.status, 200);
  assert.match(qrSvg.headers.get('content-type'), /svg/);
  const qrPng = await c.get('/office/qr/primary.png');
  assert.match(qrPng.headers.get('content-type'), /png/);
  const hit = await new Client().get(`/r/${code}`);
  assert.equal(hit.location, '/join');
  // QR endpoints require the owner's session
  assert.equal((await new Client().get(`/office/qr/${code}.svg`)).status, 302);
});

test('See It. Cook It.: download click, link code, activation via API → profile updated', async () => {
  const c = state.avaClient;
  // Visitor from Ava's link taps the App Store button → attribution appended
  const visitor = new Client();
  await visitor.get(`/a/${state.ava.affiliate_id}`);
  const go = await visitor.get('/go/app/ios');
  assert.ok(go.location.startsWith('https://apps.apple.com/app/id123456?ct=' + state.ava.affiliate_id));
  const android = await visitor.get('/go/app/android');
  assert.ok(decodeURIComponent(android.location).includes(`utm_campaign=${state.ava.affiliate_id}`));
  assert.ok(db.get("SELECT 1 FROM events WHERE type = 'app_download_clicked' AND affiliate_user_id = ?", state.ava.id));

  // Ben (referred by Ava) downloads and links with a code, then activates
  const ben = new Client();
  await ben.signin('ben@test.local', 'Secret-Pass-1');
  await ben.get('/go/app/ios');
  await ben.get('/office/see-it-cook-it');
  await ben.post('/office/see-it-cook-it/link-code', {});
  const codeRow = db.get('SELECT app_link_code FROM users WHERE id = ?', state.ben.id);
  const auth = { authorization: `Bearer ${state.apiKey}` };
  assert.equal((await ben.req('POST', '/api/v1/app/link', { json: { link_code: codeRow.app_link_code } })).status, 401);
  const link = await ben.req('POST', '/api/v1/app/link', { json: { link_code: codeRow.app_link_code, app_user_id: 'sic-1' }, headers: auth });
  assert.equal(link.status, 200, link.text);
  assert.equal(JSON.parse(link.text).user.app_linked, true);
  const act = await ben.req('POST', '/api/v1/events', { json: { type: 'activation_completed', external_id: 'act-1', user: { app_user_id: 'sic-1' } }, headers: auth });
  assert.equal(JSON.parse(act.text).user.activated, true);
  const again = await ben.req('POST', '/api/v1/events', { json: { type: 'activation_completed', external_id: 'act-1', user: { app_user_id: 'sic-1' } }, headers: auth });
  assert.equal(JSON.parse(again.text).duplicate, true, 'idempotent');
  const page = await ben.get('/office/see-it-cook-it');
  assert.ok(page.text.includes('Activated'));
  for (const t of ['app_download_clicked', 'app_account_linked', 'activation_completed']) {
    assert.ok(db.get('SELECT 1 FROM events WHERE type = ? AND subject_user_id = ?', t, state.ben.id), t);
  }
  // Reward stays off (configurable, not hard-coded) until management enables it
  assert.equal(db.get('SELECT COUNT(*) AS n FROM rewards').n, 0);

  // Partner purchase attributed through a click_id → percentage rule
  const clickId = db.get('SELECT click_id FROM clicks WHERE affiliate_user_id = ? ORDER BY id DESC LIMIT 1', state.ava.id).click_id;
  const buy = await ben.req('POST', '/api/v1/events', { json: { type: 'purchase', external_id: 'order-1', attribution: { click_id: clickId }, destination: 'meal-kit', value_cents: 4000 }, headers: auth });
  assert.equal(JSON.parse(buy.text).commissions_created, 1);
  assert.ok(db.get('SELECT 1 FROM commissions WHERE user_id = ? AND amount_cents = 400', state.ava.id));
});

test('admin manages pathway status; only Available Now shows as active', async () => {
  const p = db.get("SELECT * FROM pathways WHERE status = 'coming_soon' LIMIT 1");
  const r = await admin.post(`/admin/m/pathways/${p.id}/inline`, { value: 'available' });
  assert.equal(r.status, 302);
  const live = await new Client().get('/ways-to-earn?status=available');
  assert.ok(live.text.includes(p.title));
  const bulk = new URLSearchParams([['ids', String(p.id)], ['value', 'in_development']]);
  await admin.post('/admin/m/pathways/bulk', bulk);
  assert.equal(db.get('SELECT status FROM pathways WHERE id = ?', p.id).status, 'in_development');
});

test('support role (Vanessa) can help affiliates without full admin permissions', async () => {
  await admin.get('/admin/staff');
  const add = await admin.post('/admin/staff', { first_name: 'Vanessa', last_name: 'Support', email: 'vanessa@test.local', role: 'support' });
  assert.equal(add.status, 302);
  const token = db.get("SELECT body FROM outbox WHERE recipient = 'vanessa@test.local' ORDER BY id DESC LIMIT 1").body.match(/reset-password\/([\w-]+)/)[1];
  const v = new Client();
  await v.get(`/reset-password/${token}`);
  assert.equal((await v.post(`/reset-password/${token}`, { password: 'Vanessa-Pass-1' })).location, '/signin');
  assert.equal((await v.signin('vanessa@test.local', 'Vanessa-Pass-1')).location, '/admin');

  assert.equal((await v.get('/admin/affiliates?q=ben')).status, 200);
  assert.equal((await v.get(`/admin/affiliates/${state.ben.id}`)).status, 200);
  assert.equal((await v.get('/admin/tickets')).status, 200);
  assert.equal((await v.get('/admin/commissions')).status, 200);
  for (const p of ['/admin/settings', '/admin/staff', '/admin/api-keys', '/admin/m/pathways', '/admin/content', '/admin/m/commission_rules']) {
    assert.equal((await v.get(p)).status, 403, p);
  }
  assert.equal((await v.post('/admin/commissions/status', { ids: '1', to: 'approved' })).status, 403);
  assert.equal((await v.get('/admin/affiliates?format=csv')).status, 403);
  // Support actions
  assert.equal((await v.post(`/admin/affiliates/${state.ben.id}/reset`, {})).status, 302);
  assert.equal((await v.post(`/admin/affiliates/${state.ben.id}/status`, { status: 'suspended', reason: 'test' })).status, 302);
  assert.equal(db.get('SELECT status FROM users WHERE id = ?', state.ben.id).status, 'suspended');
  const closeAttempt = await v.post(`/admin/affiliates/${state.ben.id}/status`, { status: 'closed' });
  assert.equal(closeAttempt.status, 302);
  assert.equal(db.get('SELECT status FROM users WHERE id = ?', state.ben.id).status, 'suspended', 'support cannot close accounts');
  await v.post(`/admin/affiliates/${state.ben.id}/status`, { status: 'active' });
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'affiliate.status'"));
});

test('finance approves and pays commissions through the allowed transitions', async () => {
  const id = db.get("SELECT id FROM commissions WHERE status = 'pending' LIMIT 1").id;
  await admin.post('/admin/commissions/status', new URLSearchParams([['ids', String(id)], ['to', 'paid']]));
  assert.equal(db.get('SELECT status FROM commissions WHERE id = ?', id).status, 'pending', 'cannot skip approval');
  await admin.post('/admin/commissions/status', new URLSearchParams([['ids', String(id)], ['to', 'approved']]));
  await admin.post('/admin/commissions/status', new URLSearchParams([['ids', String(id)], ['to', 'paid']]));
  assert.equal(db.get('SELECT status FROM commissions WHERE id = ?', id).status, 'paid');
  const page = await state.avaClient.get('/office/commissions');
  assert.ok(page.text.includes('Paid'));
});

test('help contact form creates a support ticket', async () => {
  const c = new Client();
  await c.get('/help');
  const r = await c.post('/help/contact', { name: 'Pat', email: 'pat@test.local', topic: 'Signing in', subject: 'Cannot sign in', message: 'I forgot which email I used.' });
  assert.equal(r.location, '/help#contact');
  const t = db.get("SELECT * FROM support_tickets WHERE email = 'pat@test.local'");
  assert.equal(t.status, 'open');
});

test('security: CSRF, open redirects, suspended users, API auth', async () => {
  const c = new Client();
  await c.get('/signin');
  const noCsrf = await c.req('POST', '/signin', { body: 'email=a&password=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(noCsrf.status, 403);
  const r = await c.post('/signin', { email: 'ava@test.local', password: 'Secret-Pass-1', next: '//evil.example' });
  assert.equal(r.location, '/office');
  assert.equal((await new Client().get('/api/v1/affiliates/X')).status, 401);
  assert.equal((await new Client().get('/admin')).status, 302);
  assert.equal((await state.avaClient.get('/admin')).location, '/office', 'affiliates cannot reach admin');
});

test('staff can change their own password from My account', async () => {
  const page = await admin.get('/admin/account');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('Change password'));
  const wrong = await admin.post('/admin/account/password', { current_password: 'nope', new_password: 'New-Admin-Pass-1', confirm_password: 'New-Admin-Pass-1' });
  assert.equal(wrong.status, 422);
  const mismatch = await admin.post('/admin/account/password', { current_password: 'Admin-Pass-123', new_password: 'New-Admin-Pass-1', confirm_password: 'Different-1' });
  assert.equal(mismatch.status, 422);
  const ok = await admin.post('/admin/account/password', { current_password: 'Admin-Pass-123', new_password: 'New-Admin-Pass-1', confirm_password: 'New-Admin-Pass-1' });
  assert.equal(ok.location, '/admin/account');
  assert.equal((await admin.get('/admin')).status, 200, 'current session kept');
  assert.equal((await new Client().signin('admin@test.local', 'Admin-Pass-123')).status, 401, 'old password rejected');
  assert.equal((await new Client().signin('admin@test.local', 'New-Admin-Pass-1')).location, '/admin');
});

// ---- Security regression tests ------------------------------------------------
test('security: no open redirect through ?ref on protocol-relative paths', async () => {
  for (const p of ['//evil.example/?ref=CHWAAAAAA', '//evil.example/%2e%2e?ref=X']) {
    const r = await new Client().get(p);
    assert.equal(r.status, 302, p);
    assert.ok(r.location.startsWith('/') && !r.location.startsWith('//') && !r.location.startsWith('/\\'), `${p} -> ${r.location}`);
  }
});

test('security: strict headers, no inline styles, no caching of dynamic pages', async () => {
  const r = await new Client().get('/signin');
  const csp = r.headers.get('content-security-policy');
  assert.ok(!csp.includes('unsafe-inline'), csp);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  for (const p of ['/', '/join', '/ways-to-earn', '/help', '/see-it-cook-it']) {
    const { text } = await new Client().get(p);
    assert.ok(!/\sstyle="/.test(text), `${p} has an inline style attribute`);
  }
});

test('security: names with links are refused and pre-verification emails echo nothing typed', async () => {
  const c = new Client();
  await c.get('/join');
  const bad = await c.post('/join', { first_name: 'Win $500 at http://evil.example', last_name: 'X', email: 'victim@test.local', mobile: '5555550199', country: 'US', password: 'Secret-Pass-1', terms: '1' });
  assert.equal(bad.status, 422);
  await c.post('/join', { first_name: 'Zoë', last_name: "O'Neil", email: 'zoe@test.local', mobile: '5555550198', country: 'US', password: 'Secret-Pass-1', terms: '1' });
  const mail = db.get("SELECT body FROM outbox WHERE recipient = 'zoe@test.local' ORDER BY id DESC LIMIT 1").body;
  assert.ok(!mail.includes('Zoë'), 'verification email must not include the typed name');
  const h = new Client();
  await h.get('/help');
  await h.post('/help/contact', { name: 'Visit http://evil.example', email: 'victim2@test.local', topic: 'Signing in', subject: 'Claim your prize http://evil.example', message: 'phishing attempt text here' });
  const conf = db.get("SELECT body, subject FROM outbox WHERE recipient = 'victim2@test.local' ORDER BY id DESC LIMIT 1");
  assert.ok(!conf.body.includes('evil.example') && !conf.subject.includes('evil.example'));
});

test('security: weak passwords and repeated form fields are rejected cleanly', async () => {
  const c = new Client();
  await c.get('/join');
  const weak = await c.post('/join', { first_name: 'Weak', last_name: 'Pass', email: 'weak@test.local', mobile: '5555550197', country: 'US', password: 'password123', terms: '1' });
  assert.equal(weak.status, 422);
  assert.ok(weak.text.includes('too common'));
  const arr = await c.post('/signin', new URLSearchParams([['email', 'ava@test.local'], ['password', 'a'], ['password', 'b']]));
  assert.equal(arr.status, 401, 'array password must not crash the server');
});

test('security: accounts lock after repeated failed sign-ins (survives restarts)', async () => {
  const c = new Client();
  await c.get('/signin');
  for (let i = 0; i < 10; i++) await c.post('/signin', { email: 'ava@test.local', password: `wrong-${i}` });
  assert.ok(db.get("SELECT locked_until FROM users WHERE email = 'ava@test.local'").locked_until, 'locked in the database');
  const locked = await c.post('/signin', { email: 'ava@test.local', password: 'Secret-Pass-1' });
  assert.equal(locked.status, 401);
  assert.ok(locked.text.includes('Too many failed attempts'));
  db.run("UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE email = 'ava@test.local'");
  assert.equal((await c.post('/signin', { email: 'ava@test.local', password: 'Secret-Pass-1' })).location, '/office');
});

test('security: support staff cannot open or reset staff accounts', async () => {
  const v = new Client();
  assert.equal((await v.signin('vanessa@test.local', 'Vanessa-Pass-1')).location, '/admin');
  const adminId = db.get("SELECT id FROM users WHERE email = 'admin@test.local'").id;
  assert.equal((await v.get(`/admin/affiliates/${adminId}`)).status, 404);
  const before = db.get('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?', adminId).n;
  await v.post(`/admin/affiliates/${adminId}/reset`, {});
  assert.equal(db.get('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?', adminId).n, before);
});

test('security: uploads must really be the file type they claim, and are served sandboxed', async () => {
  const fd = new FormData();
  fd.set('_csrf', admin.csrf());
  fd.set('title', 'Disguised file');
  fd.set('status', 'draft');
  fd.set('file', new Blob(['<html><script>alert(1)</script></html>'], { type: 'image/png' }), 'innocent.png');
  const r = await fetch(BASE + '/admin/content', { method: 'POST', body: fd, redirect: 'manual', headers: { cookie: Object.entries(admin.jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(r.status, 422);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM content_assets WHERE title = 'Disguised file'").n, 0);
  const asset = db.get("SELECT file_path FROM content_assets WHERE file_path LIKE '/uploads/%' LIMIT 1");
  const served = await fetch(BASE + asset.file_path);
  assert.match(served.headers.get('content-security-policy'), /sandbox/);
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
});

test('security: two-step sign-in for staff (setup, code, replay protection, recovery codes)', async () => {
  const totp = require('../src/lib/totp');
  const adminRow = () => db.get("SELECT * FROM users WHERE email = 'admin@test.local'");
  await admin.post('/admin/account/2fa/start', {});
  const secret = totp.pendingSecret(adminRow());
  assert.ok(secret);
  const step = Math.floor(Date.now() / 1000 / totp.STEP);
  const bad = await admin.post('/admin/account/2fa/confirm', { code: totp.codeAt(secret, step) === '000000' ? '111111' : '000000' });
  assert.equal(bad.status, 422);
  const ok = await admin.post('/admin/account/2fa/confirm', { code: totp.codeAt(secret, step) });
  assert.equal(ok.status, 200);
  const recovery = ok.text.match(/[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/g);
  assert.equal(new Set(recovery).size, 8);
  assert.ok(adminRow().totp_enabled_at);
  assert.ok(!adminRow().totp_secret.includes(secret), 'secret encrypted at rest');

  // Password alone no longer signs in
  const c = new Client();
  const first = await c.signin('admin@test.local', 'New-Admin-Pass-1');
  assert.equal(first.location, '/signin/code');
  assert.equal((await c.get('/admin')).status, 302, 'no session yet');
  assert.equal((await c.post('/signin/code', { code: totp.codeAt(secret, step) })).status, 401, 'replayed code refused');
  const good = await c.post('/signin/code', { code: totp.codeAt(secret, step + 1) });
  assert.equal(good.location, '/admin');
  assert.equal((await c.get('/admin')).status, 200);

  // Recovery code works once
  const d = new Client();
  await d.signin('admin@test.local', 'New-Admin-Pass-1');
  assert.equal((await d.post('/signin/code', { code: recovery[0] })).location, '/admin');
  const e = new Client();
  await e.signin('admin@test.local', 'New-Admin-Pass-1');
  assert.equal((await e.post('/signin/code', { code: recovery[0] })).status, 401, 'recovery code is single-use');
});
