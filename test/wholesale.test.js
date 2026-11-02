'use strict';
// See It. Cook It. wholesale credits — the blueprint's test plan (§7):
// purchase → claim → app sign-in → credits used → download / subscription →
// commission in the right dashboard; attribution across two affiliates and
// devices; duplicate webhooks; refunds; concurrent spends; privacy and pages.
// Runs the real app with a throwaway database and a fake Stripe API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = 5000 + Math.floor(Math.random() * 800);
const STRIPE_PORT = PORT + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: String(PORT),
  BASE_URL: BASE,
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'chew-ws-test-')),
  ADMIN_EMAIL: 'admin@test.local',
  ADMIN_PASSWORD: 'Admin-Pass-123',
  RATE_LIMIT_FACTOR: '100',
  TRUST_PROXY: '1',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
  STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
});

const createApp = require('../src/app');
const db = require('../src/db');
const credits = require('../src/lib/credits');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

class Client {
  constructor() {
    this.jar = {};
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
  async req(method, p, { form, json, headers = {} } = {}) {
    const h = { 'user-agent': UA, 'accept-language': 'en-US', cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '), ...headers };
    let body;
    if (form) {
      const params = new URLSearchParams(form);
      if (!params.has('_csrf')) params.set('_csrf', this.csrf());
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = params.toString();
    }
    if (json) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(BASE + p, { method, headers: h, body, redirect: 'manual' });
    this.store(res);
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
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

const latestCode = (email) => db.get('SELECT body FROM outbox WHERE recipient = ? ORDER BY id DESC LIMIT 1', email).body.match(/\b(\d{6})\b/)[1];

async function signup(email, first) {
  const c = new Client();
  await c.get('/join');
  await c.post('/join', { first_name: first, last_name: 'Tester', email, mobile: '(555) 555-0123', country: 'US', password: 'Secret-Pass-1', terms: '1' });
  await c.post('/join/verify', { code: latestCode(email) });
  await c.post('/join/agreement', { agree: '1' });
  return { client: c, user: db.get('SELECT * FROM users WHERE email = ?', email) };
}

// ---- Fake Stripe ------------------------------------------------------------------------
const sessions = new Map();
let stripeCalls = 0;
const stripeServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    stripeCalls++;
    assert.equal(req.headers.authorization, 'Bearer sk_test_fake');
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      const p = new URLSearchParams(raw);
      const id = `cs_test_${sessions.size + 1}`;
      sessions.set(id, { id, customer_email: p.get('customer_email'), client_reference_id: p.get('client_reference_id'), amount: Number(p.get('line_items[0][price_data][unit_amount]')), success_url: p.get('success_url'), payment_status: 'unpaid', payment_intent: `pi_${sessions.size + 1}` });
      return res.end(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }));
    }
    const m = req.url.match(/^\/v1\/checkout\/sessions\/(.+)$/);
    if (req.method === 'GET' && m && sessions.has(m[1])) return res.end(JSON.stringify(sessions.get(m[1])));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
});

function signedWebhook(evt, secret = 'whsec_test_fake') {
  const payload = JSON.stringify(evt);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return fetch(`${BASE}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: payload });
}

let server;
const admin = new Client();
const S = {};
const api = (p, json) =>
  fetch(BASE + '/api/v1' + p, {
    method: json ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${S.apiKey}`, 'content-type': 'application/json' },
    body: json ? JSON.stringify(json) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  await new Promise((r) => stripeServer.listen(STRIPE_PORT, r));
  server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));
  assert.equal((await admin.signin('admin@test.local', 'Admin-Pass-123')).location, '/admin');
  const keyPage = await admin.post('/admin/api-keys', { name: 'App backend' });
  S.apiKey = keyPage.text.match(/(chk_[A-Za-z0-9_-]+)/)[1];
});

after(() => {
  server.close();
  stripeServer.close();
  db.raw.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------------------
test('public: homepage feature block, how it works, business form; wholesale page; inquiries reach admin', async () => {
  const home = await new Client().get('/');
  const order = ['100% Free', 'Turn a Food Photo Into Your Next Cooking Video.', 'TRY SEE IT. COOK IT.', 'Grow Your Own Audience by Giving Away AI Cooking Credits.', 'LEARN ABOUT WHOLESALE CREDITS', 'Affiliates give free credits', 'Handled centrally', 'class="display">See It. Cook It.', 'Become a Business Affiliate', 'class="final-cta"'];
  let last = -1;
  for (const marker of order) {
    const i = home.text.indexOf(marker, last + 1);
    assert.ok(i > last, `"${marker}" in order`);
    last = i;
  }
  assert.ok(home.text.includes('href="https://seeitcookit.com"'));
  // Nothing internal on public pages
  for (const banned of ['margin', 'cost per video', 'wholesale price']) assert.ok(!home.text.toLowerCase().includes(banned), banned);

  const ws = await new Client().get('/wholesale');
  assert.equal(ws.status, 200);
  for (const s of ['EXPLORE WHOLESALE AFFILIATE PROGRAM', '$500.00', '3,500 promotional credits', '399 credits per completed video', '$24.95/month', '$1.99']) assert.ok(ws.text.includes(s), s);

  const v = new Client();
  await v.get('/wholesale');
  const bad = await v.post('/wholesale/inquiry', { name: 'Kim', email: 'kim@example.com', phone: '', audience: '', volume: '', page: 'wholesale' });
  assert.equal(bad.status, 422);
  assert.ok(bad.text.includes('Please agree so we can contact you.'));
  const ok = await v.post('/wholesale/inquiry', { name: 'Kim Lee', email: 'kim@example.com', phone: '+1 555 555 0199', company: 'Kim Eats', audience: 'TikTok food channel', volume: '25–100 creators a month', consent: '1', page: 'home' });
  assert.equal(ok.location, '/#business-affiliate');
  const lead = db.get("SELECT * FROM business_leads WHERE email = 'kim@example.com'");
  assert.equal(lead.status, 'new');
  assert.ok(lead.consent_at);
  assert.equal(lead.page, 'home');
  assert.ok((await admin.get('/admin/m/business_leads')).text.includes('Kim Lee'));
  assert.ok(db.get("SELECT 1 FROM outbox WHERE subject LIKE 'New business affiliate inquiry%'"));
});

test('admin controls: package, video cost and grant limits are settings, not code', async () => {
  const pkg = db.get('SELECT * FROM credit_packages');
  assert.equal(pkg.price_cents, 50000);
  assert.equal(pkg.credits, 3500);
  assert.equal(credits.videoCost(), 399);
  const page = await admin.get('/admin/settings');
  for (const k of ['sic_video_cost', 'sic_grant_min', 'sic_grant_max', 'sic_price_monthly', 'sic_price_download', 'sic_repurchase_below']) assert.ok(page.text.includes(`name="${k}"`), k);
  assert.equal((await admin.get('/admin/m/credit_packages')).status, 200);
  assert.ok(credits.grantLimits().options.map((o) => o.credits).join(',') === '399,798,1197,1596,1995');
});

test('purchase: acknowledge policy → Stripe Checkout → signed webhook adds credits once', async () => {
  const a = await signup('wanda@example.com', 'Wanda');
  S.a = a;
  const c = a.client;
  // Wholesale is an optional extra: the dashboard invites, nothing is required
  assert.ok((await c.get('/office')).text.includes('EXPLORE WHOLESALE AFFILIATE PROGRAM'));
  // Must acknowledge first
  let pkgs = await c.get('/office/see-it-cook-it/packages');
  assert.ok(pkgs.text.includes('Before you buy'));
  const blocked = await c.post('/office/see-it-cook-it/checkout', { package_id: '1' });
  assert.equal(blocked.location, '/office/see-it-cook-it/packages');
  await c.post('/office/see-it-cook-it/acknowledge', { ack: '1', next: 'packages' });
  assert.equal(credits.account(a.user.id).status, 'prospect');
  assert.equal(credits.isWholesaler(a.user.id), false);

  const r = await c.post('/office/see-it-cook-it/checkout', { package_id: '1' });
  assert.equal(r.status, 303);
  assert.match(r.location, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
  const order = db.get('SELECT * FROM package_orders WHERE user_id = ?', a.user.id);
  assert.equal(order.status, 'pending');
  assert.equal(order.price_cents, 50000);

  // Forged webhook is refused
  const forged = await signedWebhook({ type: 'checkout.session.completed', data: { object: { id: order.stripe_session_id, payment_status: 'paid', client_reference_id: order.ref } } }, 'whsec_wrong');
  assert.equal(forged.status, 400);
  assert.equal(credits.available(a.user.id), 0);

  // Stripe confirms (and retries the same event)
  const evt = { type: 'checkout.session.completed', data: { object: { id: order.stripe_session_id, payment_status: 'paid', client_reference_id: order.ref, payment_intent: 'pi_wanda' } } };
  assert.equal((await signedWebhook(evt)).status, 200);
  assert.equal((await signedWebhook(evt)).status, 200);
  assert.equal(credits.available(a.user.id), 3500);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM credit_batches WHERE user_id = ?', a.user.id).n, 1);
  assert.equal(credits.account(a.user.id).status, 'active');
  assert.equal(db.get('SELECT status FROM package_orders WHERE id = ?', order.id).status, 'paid');

  // The return page also confirms (no double credit)
  const ret = await c.get(`/office/see-it-cook-it/checkout/return?session_id=${order.stripe_session_id}`);
  assert.equal(ret.location, '/office/see-it-cook-it');
  assert.equal(credits.available(a.user.id), 3500);
});

test('purchase without webhook: the return page confirms with Stripe directly', async () => {
  const b = await signup('bruno@example.com', 'Bruno');
  S.b = b;
  await b.client.post('/office/see-it-cook-it/acknowledge', { ack: '1' });
  await b.client.post('/office/see-it-cook-it/checkout', { package_id: '1' });
  const order = db.get('SELECT * FROM package_orders WHERE user_id = ?', b.user.id);
  sessions.get(order.stripe_session_id).payment_status = 'paid';
  await b.client.get(`/office/see-it-cook-it/checkout/return?session_id=${order.stripe_session_id}`);
  assert.equal(credits.available(b.user.id), 3500);
  // Someone else's session id does nothing
  await S.a.client.get(`/office/see-it-cook-it/checkout/return?session_id=${order.stripe_session_id}`);
  assert.equal(credits.available(S.a.user.id), 3500);
});

test('creator journey: tracked claim link → claim → app sign-in → video → $1.99 download → subscription → commission in the right dashboard', async () => {
  const c = S.a.client;
  // Commission schedule (as signed) — admin-configured
  await admin.post('/admin/m/commission_rules', { name: 'Subscription share', event_type: 'sic_subscription', amount_cents: '', percent_bps: '20', currency: 'USD', active: '1' });
  await admin.post('/admin/m/commission_rules', { name: 'Download share', event_type: 'sic_download', amount_cents: '0.25', percent_bps: '', currency: 'USD', active: '1' });

  // Create a claim link: 2 videos per creator, up to 3 creators
  const created = await c.post('/office/see-it-cook-it/claim-links', { videos: '2', max_claims: '3', label: 'IG giveaway', source: 'instagram' });
  assert.equal(created.location, '/office/see-it-cook-it#claims');
  const offer = db.get('SELECT o.*, l.code FROM claim_offers o JOIN tracked_links l ON l.id = o.link_id WHERE o.user_id = ?', S.a.user.id);
  assert.equal(offer.credits, 798);
  S.offerA = offer;
  // Nothing reserved until someone claims
  assert.equal(credits.available(S.a.user.id), 3500);

  // Test link preview: owner sees attribution; no click recorded
  const preview = await c.get(`/r/${offer.code}?preview=1`);
  assert.ok(preview.text.includes('No click was recorded'));
  assert.ok(preview.text.includes(S.a.user.affiliate_id));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM clicks WHERE link_id = ?', offer.link_id).n, 0);

  // A visitor follows the tracked link
  const visitor = new Client();
  const go = await visitor.get(`/r/${offer.code}`, { headers: { 'x-forwarded-for': '203.0.113.10' } });
  assert.equal(go.location, `/claim/${offer.code}`);
  const page = await visitor.get(go.location, { headers: { 'x-forwarded-for': '203.0.113.10' } });
  assert.ok(page.text.includes('798 free credits'));
  assert.ok(page.text.includes('enough for 2 cooking videos'));
  // Consumers never see the sponsoring affiliate
  assert.ok(!page.text.includes(S.a.user.affiliate_id));
  assert.ok(!page.text.includes('Wanda'));
  const claimed = await visitor.post(`/claim/${offer.code}`, { email: 'cora@example.com', consent: '1' }, { headers: { 'x-forwarded-for': '203.0.113.10' } });
  assert.ok(claimed.text.includes('Your free credits are reserved'));
  const grant = db.get("SELECT * FROM credit_grants WHERE user_id = ? AND status = 'pending'", S.a.user.id);
  assert.ok(grant.click_id, 'claim keeps the click that led to it');
  assert.equal(credits.available(S.a.user.id), 3500 - 798);
  // Same person can't claim twice
  const again = await visitor.post(`/claim/${offer.code}`, { email: 'Cora@Example.com', consent: '1' }, { headers: { 'x-forwarded-for': '203.0.113.10' } });
  assert.ok(again.text.includes('already been claimed'));

  // The app: creator signs up with the verified email → claim redeemed, assigned to Wanda
  let r = await api('/sic/creators', { app_user_id: 'app-cora', email: 'cora@example.com', email_verified: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.creator.assigned, true);
  assert.equal(r.body.creator.affiliate_id, S.a.user.affiliate_id);
  assert.equal(r.body.creator.balance, 798);
  S.cora = r.body.creator;

  // Creates a video: 399 credits
  r = await api('/sic/consumptions', { transaction_id: 'gen-cora-1', app_user_id: 'app-cora', job_id: 'job-1' });
  assert.equal(r.status, 201);
  assert.equal(r.body.balance, 399);

  // Pays $1.99 for a watermark-free download (net after store fees: $1.39)
  r = await api('/sic/revenue', { transaction_id: 'dl-cora-1', app_user_id: 'app-cora', category: 'download', amount_cents: 199, net_cents: 139 });
  assert.equal(r.status, 201);
  assert.equal(r.body.commissions_created, 1);
  // Subscribes ($24.95)
  r = await api('/sic/revenue', { transaction_id: 'sub-cora-1', app_user_id: 'app-cora', category: 'subscription', amount_cents: 2495, plan: 'monthly' });
  assert.equal(r.body.commissions_created, 1);

  const rows = db.all('SELECT c.* FROM commissions c JOIN events e ON e.id = c.event_id WHERE e.creator_id IS NOT NULL ORDER BY c.id');
  assert.deepEqual(rows.map((x) => [x.user_id, x.amount_cents, x.basis]), [
    [S.a.user.id, 25, '$0.25 fixed'],
    [S.a.user.id, 499, '20% of $24.95'],
  ]);

  // Shows in Wanda's dashboard / earnings tab — not Bruno's
  const earn = await c.get('/office/commissions?tab=sic');
  assert.ok(earn.text.includes(S.cora.creator_ref));
  assert.ok(earn.text.includes('20% of $24.95'));
  assert.ok(earn.text.includes('$4.99'));
  assert.ok(!(await S.b.client.get('/office/commissions?tab=sic')).text.includes(S.cora.creator_ref));
  const dash = await c.get('/office');
  for (const s of ['GIVE AWAY CREDITS', 'GET PROMO LINKS', 'VIEW MY USERS', 'SEE MY EARNINGS', 'WATCH TRAINING', 'Attributed creators', 'Active subscribers']) assert.ok(dash.text.includes(s), s);

  // Link reporting: claims and creators per link
  const links = await c.get('/office/links');
  assert.ok(links.text.includes('IG giveaway'));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM creator_attribution WHERE link_id = ?', offer.link_id).n, 1);
});

test('attribution: two affiliate links, multiple devices, more credits — the creator stays with the first', async () => {
  // Bruno makes a claim link; the same creator (Cora) claims it with another email
  await S.b.client.post('/office/see-it-cook-it/claim-links', { videos: '1', max_claims: '5' });
  const offerB = db.get('SELECT o.*, l.code FROM claim_offers o JOIN tracked_links l ON l.id = o.link_id WHERE o.user_id = ?', S.b.user.id);
  const v = new Client();
  await v.get(`/claim/${offerB.code}`);
  const res = await v.post(`/claim/${offerB.code}`, { email: 'cora.second@example.com', consent: '1' }, { headers: { 'x-forwarded-for': '203.0.113.20' } });
  const code = res.text.match(/aria-label="Claim code">([A-Z0-9]+)</)[1];
  assert.equal(credits.available(S.b.user.id), 3500 - 399);

  // Cora enters that code in the app (another device): rejected, Bruno gets the credits back
  const r = await api('/sic/creators', { app_user_id: 'app-cora', claim_code: code });
  assert.equal(r.body.claims[0].ok, false);
  assert.equal(r.body.claims[0].reason, 'assigned_elsewhere');
  assert.equal(r.body.creator.affiliate_id, S.a.user.affiliate_id);
  assert.equal(credits.available(S.b.user.id), 3500);
  // Signing in again on more devices changes nothing
  for (let i = 0; i < 3; i++) assert.equal((await api('/sic/creators', { app_user_id: 'app-cora', email: 'cora@example.com', email_verified: true })).body.creator.affiliate_id, S.a.user.affiliate_id);
  // Bruno can't give Cora credits — enforced in the database too
  assert.throws(() => credits.grantToCreator({ userId: S.b.user.id, creatorRef: S.cora.creator_ref, credits: 399 }), /assigned/);
  assert.throws(() => db.run("INSERT INTO credit_grants (ref, user_id, creator_id, credits, credits_remaining, status, source) VALUES ('G-HACK', ?, ?, 1, 1, 'active', 'x')", S.b.user.id, db.get('SELECT id FROM creators WHERE ref = ?', S.cora.creator_ref).id), /creator_assigned_elsewhere/);
  // Bruno's analytics shows the exception, never Cora
  const an = await S.b.client.get('/office/analytics');
  assert.ok(!an.text.includes(S.cora.creator_ref));
  assert.ok(!(await S.b.client.get('/office/analytics/sic-users.csv')).text.includes(S.cora.creator_ref));

  // Wanda asks to give Cora more while 399 are unused → blocked
  const confirm = await S.a.client.post('/office/see-it-cook-it/grant', { creator: S.cora.creator_ref, videos: '1' });
  assert.ok(confirm.text.includes('still has unused credits'));
  await S.a.client.post('/office/see-it-cook-it/grant/confirm', { creator: S.cora.creator_ref, videos: '1' });
  assert.equal(credits.creatorBalance(db.get('SELECT id FROM creators WHERE ref = ?', S.cora.creator_ref).id), 399);
  // After the next video it works
  await api('/sic/consumptions', { transaction_id: 'gen-cora-2', app_user_id: 'app-cora' });
  const ok = await S.a.client.post('/office/see-it-cook-it/grant/confirm', { creator: S.cora.creator_ref, videos: '1' });
  assert.equal(ok.location, '/office/see-it-cook-it#issue');
  assert.equal((await api('/sic/creators/app-cora')).body.creator.balance, 399);
  // Out-of-range amounts are refused
  assert.throws(() => credits.grantToCreator({ userId: S.a.user.id, creatorRef: S.cora.creator_ref, credits: 50 }), /between/);
  // Admin can resolve a dispute by transferring — recorded
  const coraId = db.get('SELECT id FROM creators WHERE ref = ?', S.cora.creator_ref).id;
  const t = await admin.post(`/admin/wholesale/creators/${coraId}/transfer`, { affiliate_id: S.b.user.affiliate_id, reason: 'Test dispute' });
  assert.equal(t.location, `/admin/wholesale/creators/${coraId}`);
  assert.equal(credits.attribution(coraId).affiliate_user_id, S.b.user.id);
  await admin.post(`/admin/wholesale/creators/${coraId}/transfer`, { affiliate_id: S.a.user.affiliate_id, reason: 'Back after review' });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM attribution_transfers WHERE creator_id = ?', coraId).n, 2);
});

test('duplicate webhooks, cancellations, refunds and chargebacks', async () => {
  // Same revenue reported twice → one commission
  const dup = await api('/sic/revenue', { transaction_id: 'sub-cora-1', app_user_id: 'app-cora', category: 'subscription', amount_cents: 2495 });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM commissions c JOIN events e ON e.id = c.event_id WHERE e.external_id = 'sub-cora-1'").n, 1);
  // Same consumption twice → one charge
  const again = await api('/sic/consumptions', { transaction_id: 'gen-cora-1', app_user_id: 'app-cora' });
  assert.equal(again.body.duplicate, true);

  // Cancel subscription
  let r = await api('/sic/subscriptions', { app_user_id: 'app-cora', status: 'canceled' });
  assert.equal(r.body.creator.subscription_status, 'canceled');

  // Full refund of the pending download commission → reversed
  r = await api('/sic/refunds', { transaction_id: 'rf-1', original_transaction_id: 'dl-cora-1', kind: 'refund' });
  assert.equal(r.status, 201);
  const dl = db.get("SELECT c.* FROM commissions c JOIN events e ON e.id = c.event_id WHERE e.external_id = 'dl-cora-1'");
  assert.equal(dl.status, 'reversed');
  assert.equal((await api('/sic/refunds', { transaction_id: 'rf-1', original_transaction_id: 'dl-cora-1' })).body.duplicate, true);

  // Subscription commission already paid → chargeback adds a negative adjustment linked to it
  const sub = db.get("SELECT c.* FROM commissions c JOIN events e ON e.id = c.event_id WHERE e.external_id = 'sub-cora-1'");
  await admin.post('/admin/commissions/status', { ids: String(sub.id), to: 'approved' });
  await admin.post('/admin/commissions/status', { ids: String(sub.id), to: 'paid', payout_ref: 'PAY-001' });
  assert.equal(db.get('SELECT payout_ref FROM commissions WHERE id = ?', sub.id).payout_ref, 'PAY-001');
  r = await api('/sic/refunds', { transaction_id: 'cb-1', original_transaction_id: 'sub-cora-1', kind: 'chargeback' });
  const adj = db.get('SELECT * FROM commissions WHERE reversal_of = ?', sub.id);
  assert.equal(adj.amount_cents, -499);
  assert.equal(adj.description, 'Chargeback adjustment');
  const tab = await S.a.client.get('/office/commissions?tab=sic');
  assert.ok(tab.text.includes('PAY-001'));
  assert.ok(tab.text.includes(`reverses #${sub.id}`));
  // Failed video → credits back
  const before = (await api('/sic/creators/app-cora')).body.creator.balance;
  await api('/sic/consumptions', { transaction_id: 'gen-cora-3', app_user_id: 'app-cora' });
  r = await api('/sic/consumptions/gen-cora-3/reverse', { reason: 'render failed' });
  assert.equal(r.body.balance, before);
  assert.equal((await api('/sic/consumptions/gen-cora-3/reverse', {})).body.duplicate, true);
  // Unknown app user / bad requests
  assert.equal((await api('/sic/consumptions', { transaction_id: 'x', app_user_id: 'nobody' })).status, 404);
  assert.equal((await api('/sic/revenue', { transaction_id: 'y', app_user_id: 'app-cora', category: 'tips', amount_cents: 1 })).status, 400);
});

test('concurrency: two creators spend the last credits at the same time — never negative, never double counted', async () => {
  // A fresh wholesaler with exactly 798 credits, two creators of 399 each, one extra video attempt each
  const w = await signup('tess@example.com', 'Tess');
  await w.client.post('/office/see-it-cook-it/acknowledge', { ack: '1' });
  credits.addBatch({ userId: w.user.id, credits: 798, source: 'admin', note: 'test' });
  await w.client.post('/office/see-it-cook-it/claim-links', { videos: '1', max_claims: '5' });
  const offer = db.get('SELECT o.*, l.code FROM claim_offers o JOIN tracked_links l ON l.id = o.link_id WHERE o.user_id = ?', w.user.id);
  // Three people race for two claims' worth of inventory
  const tries = await Promise.all(
    ['p1', 'p2', 'p3'].map(async (p, i) => {
      const v = new Client();
      await v.get(`/claim/${offer.code}`, { headers: { 'x-forwarded-for': `198.51.100.${30 + i}` } });
      return v.post(`/claim/${offer.code}`, { email: `${p}@example.com`, consent: '1' }, { headers: { 'x-forwarded-for': `198.51.100.${30 + i}` } });
    }),
  );
  assert.equal(tries.filter((t) => t.text.includes('Your free credits are reserved')).length, 2);
  assert.equal(credits.available(w.user.id), 0);
  for (const p of ['p1', 'p2', 'p3']) await api('/sic/creators', { app_user_id: `app-${p}`, email: `${p}@example.com`, email_verified: true });
  const funded = ['p1', 'p2', 'p3'].filter((p) => db.get('SELECT 1 FROM creators c JOIN credit_grants g ON g.creator_id = c.id WHERE c.app_user_id = ?', `app-${p}`));
  assert.equal(funded.length, 2);
  // Each funded creator fires two video requests at once; only one each can succeed
  const results = await Promise.all(funded.flatMap((p) => [1, 2].map((n) => api('/sic/consumptions', { transaction_id: `race-${p}-${n}`, app_user_id: `app-${p}` }))));
  assert.equal(results.filter((r) => r.status === 201).length, 2);
  assert.equal(results.filter((r) => r.status === 409 && r.body.error === 'insufficient_credits').length, 2);
  for (const p of funded) assert.equal((await api(`/sic/creators/app-${p}`)).body.creator.balance, 0);
  assert.equal(db.get('SELECT MIN(credits_available) AS m FROM credit_batches').m >= 0, true);
  assert.deepEqual(credits.reconcile().problems, []);
});

test('claims expire and return credits; refunded packages write off unissued inventory; ledger is append-only', async () => {
  const v = new Client();
  await v.get(`/claim/${S.offerA.code}`);
  await v.post(`/claim/${S.offerA.code}`, { email: 'late@example.com', consent: '1' }, { headers: { 'x-forwarded-for': '203.0.113.40' } });
  const pending = db.get("SELECT * FROM credit_grants WHERE status = 'pending' AND user_id = ?", S.a.user.id);
  const before = credits.available(S.a.user.id);
  db.run("UPDATE credit_grants SET expires_at = datetime('now', '-1 minute') WHERE id = ?", pending.id);
  assert.equal(credits.expireClaims(), 1);
  assert.equal(credits.available(S.a.user.id), before + pending.credits);
  assert.equal(db.get('SELECT status FROM credit_grants WHERE id = ?', pending.id).status, 'expired');

  // Stripe refund of Bruno's package → unissued credits written off, account shows it
  const order = db.get('SELECT * FROM package_orders WHERE user_id = ?', S.b.user.id);
  db.run('UPDATE package_orders SET stripe_payment_intent = ? WHERE id = ?', 'pi_bruno', order.id);
  await signedWebhook({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_bruno', refunded: true } } });
  assert.equal(db.get('SELECT status FROM package_orders WHERE id = ?', order.id).status, 'refunded');
  assert.equal(credits.available(S.b.user.id), 0);

  assert.throws(() => db.run('UPDATE credit_ledger SET credits = 0'), /append-only/);
  assert.throws(() => db.run('DELETE FROM credit_ledger'), /append-only/);
  assert.deepEqual(credits.reconcile().problems, []);
});

test('back office: all 11 routes show their See It. Cook It. additions', async () => {
  const c = S.a.client;
  const pages = {
    '/office': ['See It. Cook It. · Wholesale', 'Credit balance', 'GIVE AWAY CREDITS'],
    '/office/content-kitchen': ['See It. Cook It. video gallery', 'Ready-to-use ads', 'Restaurants'],
    '/office/links': ['See It. Cook It. promo links', 'App landing page', 'Wholesale information page', 'Free-credit claim page', 'Approved creator demos', 'Test link', 'Campaign label / UTM'],
    '/office/ways-to-earn': ['See It. Cook It. Wholesale Affiliate', 'Subscriptions', 'Individual downloads', 'COMING SOON', 'VIEW WHOLESALE DETAILS', 'OPEN COMMISSION CENTER'],
    '/office/analytics': ['MY SEE IT. COOK IT. USERS', 'Attribution exceptions', S.cora.creator_ref, 'Export CSV'],
    '/office/commissions?tab=sic': ['HOW EARNINGS WORK', 'Calculation basis', 'Payout ref.'],
    '/office/training': ['FOR CREATORS', 'FOR WHOLESALE AFFILIATES', 'COMING SOON', 'Download checklist'],
    '/office/resources': ['See It. Cook It. promo copy', 'Giveaway template', 'Creator FAQ', 'Credit Giveaway Guidelines'],
    '/office/see-it-cook-it': ['Wholesale Command Center', 'ISSUE FREE CREDITS', 'Credit inventory', 'Claim links', 'Assigned creators', 'Earnings summary', 'REQUEST MORE CREDITS'],
    '/office/account': ['Wholesale affiliate ID', 'Promotional domains', 'Low credit balance', 'Branded site URL', 'Account history', 'Attribution policy'],
  };
  for (const [p, needles] of Object.entries(pages)) {
    const r = await c.get(p);
    assert.equal(r.status, 200, p);
    for (const n of needles) assert.ok(r.text.includes(n), `${p}: ${n}`);
    // Never expose internal economics in affiliate-facing UI
    assert.ok(!/margin|our cost|internal cost/i.test(r.text), `${p}: no internal economics`);
  }
  // Coming-soon lessons can't be opened; lessons fill prices from settings
  const soon = db.get('SELECT id FROM training_lessons WHERE coming_soon = 1');
  assert.equal((await c.get(`/office/training/${soon.id}`)).status, 404);
  const watermark = db.get("SELECT id FROM training_lessons WHERE title = 'Watermark, downloads and subscriptions'");
  assert.ok((await c.get(`/office/training/${watermark.id}`)).text.includes('$1.99'));
  assert.match((await c.get('/office/training/checklist/wholesale')).text, /\[ \] Allocate credits/);
  // Resources copy download includes the affiliate's own link
  const ad = db.get("SELECT id FROM promo_copy WHERE kind = 'giveaway'");
  assert.match((await c.get(`/office/resources/copy/${ad.id}.txt`)).text, /\/r\/[A-Z0-9]+/);
  // CSV export: masked IDs only
  const csv = (await c.get('/office/analytics/sic-users.csv')).text;
  assert.ok(csv.startsWith('creator_id,joined'));
  assert.ok(!csv.includes('@'));
  // Legal pages fill settings
  assert.ok((await new Client().get('/wholesale-terms')).text.includes('399 credits per completed video'));
  // Non-wholesale affiliates are invited, not shown inventory
  const plain = await signup('pat@example.com', 'Pat');
  const sic = await plain.client.get('/office/see-it-cook-it');
  assert.ok(sic.text.includes('EXPLORE WHOLESALE AFFILIATE PROGRAM'));
  assert.ok(!sic.text.includes('ISSUE FREE CREDITS'));
});

test('admin: wholesale overview reconciles; permissions are respected', async () => {
  const page = await admin.get('/admin/wholesale');
  assert.ok(page.text.includes('Reconciliation OK'));
  assert.ok(page.text.includes(credits.account(S.a.user.id).wholesale_id));
  assert.equal((await admin.get(`/admin/wholesale/accounts/${S.a.user.id}`)).status, 200);
  assert.ok((await admin.get('/admin/wholesale/ledger')).text.includes('claim redeemed'));
  // Manual credits are audited
  await admin.post(`/admin/wholesale/accounts/${S.a.user.id}/credits`, { credits: '100', note: 'Goodwill' });
  assert.ok(db.get("SELECT 1 FROM audit_log WHERE action = 'wholesale.credits_added'"));
  // Support can view but not add credits
  db.run(
    "INSERT INTO users (first_name, last_name, email, password_hash, role, status) VALUES ('Sue', 'Port', 'sue@test.local', ?, 'support', 'active')",
    require('../src/lib/auth').hashPassword('Support-Pass-1'),
  );
  const sup = new Client();
  await sup.signin('sue@test.local', 'Support-Pass-1');
  assert.equal((await sup.get('/admin/wholesale')).status, 200);
  const before = credits.available(S.a.user.id);
  const denied = await sup.post(`/admin/wholesale/accounts/${S.a.user.id}/credits`, { credits: '1000', note: 'nope' });
  assert.equal(denied.status, 403);
  assert.equal(credits.available(S.a.user.id), before);
  // API is closed without a key
  const r = await fetch(`${BASE}/api/v1/sic/consumptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
});

test('homepage Buy credits: pay by email → admin adds the credits once → refund writes them off', async () => {
  const home = await new Client().get('/');
  const join = home.text.indexOf('JOIN CHEW FREE');
  const buy = home.text.indexOf('href="/buy-credits"');
  assert.ok(join > 0 && buy > join, 'Buy credits sits next to Join Chew Free');

  // A signed-in affiliate goes to their own packages page (automatic crediting)
  assert.equal((await S.a.client.get('/buy-credits')).location, '/office/see-it-cook-it/packages');

  // A visitor must give name, email and accept the terms
  const v = new Client();
  const page = await v.get('/buy-credits');
  assert.ok(page.text.includes('$500.00'));
  const bad = await v.post('/buy-credits', { package_id: '1', name: '', email: 'nope' });
  assert.equal(bad.status, 422);
  assert.ok(bad.text.includes('Please accept the Wholesale Terms'));
  const r = await v.post('/buy-credits', { package_id: '1', name: 'Gina Grill', email: 'Gina@Example.com', phone: '+1 555 0100', terms: '1' });
  assert.equal(r.status, 303);
  assert.match(r.location, /^https:\/\/checkout\.stripe\.com\//);
  const p = db.get("SELECT * FROM credit_purchases WHERE email = 'gina@example.com'");
  assert.equal(p.status, 'pending');
  assert.equal(sessions.get(p.stripe_session_id).customer_email, 'gina@example.com', 'Stripe gets the email to track the payment');

  // Stripe confirms (twice) → paid, emails to buyer and team, nothing credited automatically
  const evt = { type: 'checkout.session.completed', data: { object: { id: p.stripe_session_id, payment_status: 'paid', client_reference_id: p.ref, payment_intent: 'pi_gina' } } };
  await signedWebhook(evt);
  await signedWebhook(evt);
  assert.equal(db.get('SELECT status FROM credit_purchases WHERE id = ?', p.id).status, 'paid');
  assert.ok(db.get("SELECT 1 FROM outbox WHERE recipient = 'gina@example.com' AND subject LIKE 'Payment received%'"));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM outbox WHERE subject LIKE 'Credits to add:%'").n, 1);
  // Thank-you page tells her to join with the same email
  const thanks = await v.get(`/buy-credits/thanks?session_id=${p.stripe_session_id}`);
  assert.ok(thanks.text.includes(p.ref));
  assert.ok(thanks.text.includes('Join free with'));

  // She joins with that email; admin sees the match and adds the credits
  const g = await signup('gina@example.com', 'Gina');
  const list = await admin.get('/admin/wholesale/purchases?status=paid');
  assert.ok(list.text.includes('gina@example.com'));
  assert.ok(list.text.includes(`value="${g.user.affiliate_id}"`), 'account matched by email');
  assert.ok((await admin.get('/admin/wholesale')).text.includes('paid purchase'));
  const credit = await admin.post(`/admin/wholesale/purchases/${p.id}/credit`, { affiliate_id: g.user.affiliate_id });
  assert.equal(credit.location, '/admin/wholesale/purchases');
  assert.equal(credits.available(g.user.id), 3500);
  assert.equal(credits.account(g.user.id).status, 'active');
  assert.ok(credits.account(g.user.id).attribution_ack_at, 'terms accepted at checkout carry over');
  assert.equal(db.get('SELECT status FROM credit_purchases WHERE id = ?', p.id).status, 'credited');
  // Can't be credited twice
  await admin.post(`/admin/wholesale/purchases/${p.id}/credit`, { affiliate_id: g.user.affiliate_id });
  assert.equal(credits.available(g.user.id), 3500);
  // Support can see purchases but not add credits
  const sup = new Client();
  await sup.signin('sue@test.local', 'Support-Pass-1');
  assert.equal((await sup.post(`/admin/wholesale/purchases/${p.id}/credit`, { affiliate_id: g.user.affiliate_id })).status, 403);

  // Full refund in Stripe → refunded, unissued credits written off
  await signedWebhook({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_gina', refunded: true } } });
  assert.equal(db.get('SELECT status FROM credit_purchases WHERE id = ?', p.id).status, 'refunded');
  assert.equal(credits.available(g.user.id), 0);
  assert.deepEqual(credits.reconcile().problems, []);
});
