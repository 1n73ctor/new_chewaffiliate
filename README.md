# Chew Network — Affiliate Website

The public affiliate site, free signup flow, affiliate back office and admin described in the **Chew Network Affiliate Website — Suraj Blueprint**.

> Build it like a clean consumer technology platform whose affiliate program happens to be free. The front end stays simple. The power of Chew is revealed after login.

- **Stack:** Node.js 20+, Express 4, EJS (server-rendered), SQLite (better-sqlite3), vanilla CSS/JS
- **Why this stack:** pages are server-rendered with one CSS file and one small script. There's no client framework or web font, so mobile pages load fast (blueprint §13). The SQLite schema is plain SQL and ports to Postgres if the app is scaled out.

## Quick start

```bash
npm install
npm run seed:demo   # optional: sample Content Kitchen assets + demo logins
npm start           # http://localhost:3000
```

- On first start, migrations run and base data is seeded: 128 pathways in 8 categories, legal page drafts, FAQs, training, resources and destinations.
- An admin account is created. Set `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`, or read the generated password from `data/initial-admin.txt`.
- Without SMTP or Twilio configured, emails and texts (including verification codes) go to the server console and to **`/dev/outbox`**. That page is development only.
- `npm test` runs the end-to-end suite (`test/e2e.test.js`) against a throwaway database.

Demo logins after `npm run seed:demo` (password `ChewDemo-2026`):

| Email | Role |
|---|---|
| `affiliate@chew.local` | Affiliate (back office) |
| `support@chew.local` | Support: Vanessa's support-level admin |
| `content@chew.local` | Content: Ram's Content Kitchen, training, announcements |
| `finance@chew.local` | Finance: commission rules, approvals and payouts |
| `sales@chew.local` | Sales: Mike's read-only affiliates and tracking view |

Demo data **never** includes clicks, events or commissions. Dashboards only show real tracked activity.

## Configuration

Copy `.env.example` to `.env`. For production:

- `NODE_ENV=production`
- `BASE_URL`: the public URL, used in referral links, QR codes and emails
- `SESSION_SECRET`: a long random string
- `SMTP_*`: required for verification emails
- `TWILIO_*`: optional, for SMS codes
- `TRUST_PROXY`: set when running behind a proxy

Run behind HTTPS. Cookies are `Secure` in production. Back up `data/` (the database plus `data/uploads`).

Management edits core content in **Admin → Settings**, with no deployment: homepage copy, benefit strip, app-store URLs, the attribution window, the activation reward and the agreement version.

## Deploy on a VPS with Docker (e.g. GoDaddy VPS)

`docker-compose.yml` runs two containers:

- **app**: the website, built from the `Dockerfile`
- **caddy**: gets and renews the HTTPS certificate automatically

The database and uploads persist in a Docker volume. HTTPS is required: in production, cookies are `Secure`, so sign-in only works over HTTPS.

**Before you start**

- **DNS:** in GoDaddy → your domain → DNS, add an **A record** (`@`, or a subdomain like `affiliates`) pointing at the VPS IP address. Do this first, or the certificate request fails.
- **Firewall:** open ports **22, 80 and 443**. Caddy needs port 80 to get the certificate.

**On the VPS** (Ubuntu, logged in over SSH as a sudo user):

```bash
# 1. Install Docker (one time)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER        # then log out and back in

# 2. Get the code
git clone -b new_chewaffiliate https://github.com/1n73ctor/new_chewaffiliate.git chew
cd chew

# 3. Configure
cp .env.example .env
openssl rand -hex 32                 # copy this into SESSION_SECRET
nano .env
```

In `.env`, set:

| Setting | Value |
|---|---|
| `DOMAIN` | your domain, e.g. `affiliates.chew.network` |
| `SESSION_SECRET` | the random string from `openssl rand -hex 32` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | your first admin login |
| `SMTP_*`, `MAIL_FROM` | your email-sending account, so verification codes arrive |

`NODE_ENV`, `PORT` and `BASE_URL` are set by `docker-compose.yml`, so leave them alone.

```bash
# 4. Start
docker compose up -d --build
docker compose ps                    # app should show "healthy"
docker compose logs -f app           # watch the logs (Ctrl+C to exit)
```

Open `https://<your domain>`. On first start, Caddy can take a minute to get the certificate.

**Update to a new version**

```bash
git pull
docker compose up -d --build
```

**Back up the database and uploads**

```bash
docker volume ls                     # the volume is named <folder>_chew-data, e.g. chew_chew-data
docker compose stop app
docker run --rm -v chew_chew-data:/data -v "$PWD":/backup alpine tar czf /backup/chew-backup-$(date +%F).tgz -C /data .
docker compose start app
```

Don't run `npm run seed:demo` on the live server; the demo accounts are for local testing only.

---

## Blueprint coverage

| § | Requirement | Where |
|---|---|---|
| 1 | White, Amazon-simple look. Chew green primary, orange for major actions, food photography, no income counters | `public/css/app.css`, `views/public/home.ejs` |
| 2 | Header: Logo · How It Works · Ways to Earn · See It. Cook It. · Resources · Help · Search · Sign In (outlined) · JOIN FREE (orange). Join Free always visible on mobile | `views/partials/site-header.ejs` |
| 3 | Hero: eyebrow, headline, supporting text, 3 bullets, JOIN CHEW FREE →, “Already an affiliate? Sign In”, phone visual, food photo, App Store / Google Play badges | `views/public/home.ejs` |
| 4 | Quick benefit strip (5 items, editable) | Admin → Settings → Homepage copy |
| 5 | See It. Cook It. section: 3 feature cards, store buttons. Store URLs editable in admin. Store clicks keep affiliate attribution | `/go/app/:platform`, `lib/tracking.js` |
| 6 | 8 category cards on the homepage (not all 125), `/ways-to-earn` page, per-pathway admin status (Available Now / Coming Soon / In Development / Partner Program). Only Available Now is shown as active | `routes/public.js`, Admin → Pathways |
| 7 | Signup: Register → Email/phone verification → Affiliate Agreement → Account created → Affiliate ID → Welcome → Back office. No payment. Separate marketing and SMS consent. Auto Affiliate ID | `routes/join.js`, `views/join/*` |
| 8 | Back office nav (Dashboard · Content Kitchen · My Links · Ways to Earn · Analytics · Commissions · Training · Resources · See It. Cook It. · Account). Dashboard: ID, link, QR, Today's 3, training progress, real stats, announcements | `routes/office.js`, `views/office/*` |
| 9 | Activation card: download → link/recognize → activation event → profile updated. `app_download_clicked`, `app_account_linked` and `activation_completed` tracked separately. Reward is configurable, not hard-coded | `lib/activation.js`, `routes/api.js`, `docs/API.md` |
| 10 | Content Kitchen: grid, categories across the top, thumbnail/title/platform/usage status, Preview · Copy Caption · Get My Link · Download, 🔥 TODAY'S 3 | `views/office/content-kitchen.ejs`, Admin → Content Kitchen / Today's 3 |
| 11 | Tracking: affiliate_id, campaign_id, content_id, source/channel, destination/product, timestamp, conversion event | `clicks` + `events` tables, Admin → Tracking report (CSV) |
| 12 | Admin: affiliates and statuses, content and categories, Today's 3, pathways, app-store URLs, campaigns/links/announcements, training/resources, commission rules and ledger permissions, role-based access | `routes/admin/*`, `lib/permissions.js` |
| 13 | Mobile-first: large tap targets (44–58px), short form, Join Free above the fold, no pop-ups, one continuous account → app → back office flow | CSS, `views/join/welcome.ejs` |
| 14 | Homepage build order 01–11 | `views/public/home.ejs` (asserted in the tests) |
| 15 | Team hand-offs: Surendra (app API), Ram (Content Kitchen uploads), Mike (sales view), Vanessa (support role) | `docs/API.md`, roles |
| 16 | Definition of Done | See the next section |

### Definition of Done (§16)

- **A prospect understands Chew in seconds.** The hero states the offer, that it's free and that no purchase is required, above the fold.
- **A prospect can join from mobile in about a minute.** Six short fields, one code and one agreement tick.
- **A unique Affiliate ID and back office are created automatically**, e.g. `CHW7K3M9Q`, using an unambiguous alphabet.
- **Affiliate links and QR codes work.** Primary link `/a/<ID>`, tracked links `/r/<code>`, QR codes as SVG/PNG.
- **See It. Cook It. download and activation events connect back to the Chew account** through store redirects and the link-code / activation API.
- **Content Kitchen and Today's 3 are usable.** Admins upload assets and pick the day's three; affiliates copy captions with their link filled in.
- **The 125+ Ways page clearly separates live programs from future ones**, with status badges, an "Available now" box and a disclaimer.
- **Admin can update core content without a developer**: settings, legal pages, FAQs, pathways, training, resources, announcements and campaigns.
- **Vanessa can support users without full developer permissions** through the `support` role: look-ups, resending codes, reset links, manual verification, suspending/reactivating, notes and tickets.
- **All displayed analytics and commissions come from real tracked activity.** Bot previews and self-clicks are excluded, and there is no sample data in the stats.

## How tracking works

```
/a/CHW7K3M9Q?s=instagram          primary link (optional s=source, c=campaign-slug, ct=content id, d=destination)
/r/AB3K9QZ                        tracked link (created in My Links or via Content Kitchen "Get My Link")
/go/app/ios | android | auto      store buttons (records app_download_clicked)
```

1. **A click** stores who, which link, campaign, content, source, destination and when. It gets a random `click_id`, a first-party visitor ID and a hashed IP (never the raw IP). Bots and link previews are flagged and excluded from stats, and so are the affiliate's own clicks.
2. A signed, HMAC-protected **attribution cookie** keeps the last click for the attribution window (default 30 days, configurable).
3. **Results** (`events`) inherit the click's attribution:
   - `affiliate_signup` at account creation
   - app events from the store redirect and the API
   - `qualifying_action` / `purchase` from partners via the API
4. When an event matches an **active commission rule**, a *Pending* ledger entry is created. Finance moves it Pending → Approved → Paid, or → Reversed. Every change goes to the audit log.

## Roles

| Role | For | Can |
|---|---|---|
| `admin` | Suraj / administrators | Everything |
| `support` | Vanessa | View affiliates, resend codes, send reset links, verify manually, suspend/reactivate, notes, tickets, read tracking, read the ledger |
| `content` | Ram | Content Kitchen, Today's 3, announcements, training, resources, campaigns |
| `finance` | Finance | Commission rules, approvals, payouts, adjustments, read affiliates and tracking |
| `sales` | Mike | Read affiliates, tracking and tickets |

The full permission matrix is under **Admin → Staff & roles**.

## Security

- **Sign-in:** bcrypt password hashes, 32-byte random session tokens stored only as SHA-256 hashes, `__Host-` cookies (Secure, HttpOnly, SameSite=Lax) in production. Staff sessions expire after 12 hours.
- **Two-step sign-in (TOTP)** for staff, in Admin → My account. Secrets are AES-256-GCM encrypted at rest, codes can't be replayed, and recovery codes are single-use and stored hashed. The staff list shows who has it on — turn it on for every admin.
- **Brute force:** per-IP rate limits, plus a per-account lockout (10 failed attempts → 15 minutes) stored in the database so it survives restarts.
- **Passwords:** 8+ characters for affiliates and 12+ for staff; common passwords and the account's own email are refused.
- **Forms:** CSRF tokens on every form, simple query parsing, and only safe same-site redirects (`?next=`, `?ref=`).
- **Headers:** a strict Content-Security-Policy with no inline scripts or styles (`style-src 'self'`, `frame-ancestors 'none'`), HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, and `Cache-Control: no-store` on dynamic pages. Keep it that way: don't add `style=""` attributes or inline `<script>` — use classes in `public/css/app.css`.
- **Uploads** (admin only): checked by content, not just extension, and served with a sandboxing CSP; non-media files download instead of opening.
- **Email:** messages that can go to an address nobody has verified (signup code, password reset, support confirmation) never include text a visitor typed, and names are restricted to letters, so the site can't be used to send phishing text.
- **Roles:** Support-level staff can only see affiliate accounts, not staff/admin accounts.

## Project layout

```
src/
  app.js, server.js, config.js
  db/            migrations.js (schema), seed.js, seed-data/ (pathways, legal drafts, training…)
  lib/           auth, tracking, activation, stats, charts, content, settings, permissions, notify, qr…
  routes/        public, join, auth, track, office, api, admin/*
  views/         layouts/, partials/, public/, join/, auth/, office/, admin/
public/          css/app.css, js/app.js, img/
docs/API.md      integration API for the See It. Cook It. backend and partners
test/            end-to-end tests
```

## Before launch: open items for management

These are decisions, not code. Everything is editable in Admin.

1. **Legal pages** (Terms, Privacy, Affiliate Agreement, Promotional Guidelines, Earnings Disclosure) are starter text. Edit them in Admin → Legal pages, and bump the agreement version in Settings → Signup whenever the agreement changes.
2. **Pathway statuses are placeholders.** Only three pathways this build supports are marked *Available Now*: Share Content Kitchen Posts, Share See It. Cook It., Refer New Affiliates. Confirm every status in Admin → Pathways.
3. **App-store URLs** are blank until the listings are live. Until then the buttons show "coming soon".
4. **Commission rules** start empty and inactive. Add them once amounts are approved.
5. **The activation reward** is off. Its name, amount and unit are configurable after management and counsel finalize them (blueprint §9).
6. **Activation event.** Suraj and Surendra agree what "activation completed" means. The app backend then calls `POST /api/v1/events` (see `docs/API.md`).
7. **Media.** Food photos in `public/img/food` are Unsplash placeholders. Replace them with Ram's approved media. App Store / Google Play badges should be swapped for the official badge artwork per Apple and Google guidelines.
8. **Email/SMS providers.** Configure SMTP (required) and Twilio (optional) in `.env`.
