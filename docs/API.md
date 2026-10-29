# Chew Network Affiliate API (v1)

Server-to-server API for the **See It. Cook It.** backend (Surendra) and commerce/partner systems.
It closes the loop described in blueprint §9 and §11:

```
Download → Link or recognize Chew account → Complete activation event → Affiliate profile updated
WHO → WHAT CONTENT → WHAT SOURCE → WHAT LINK → WHAT PRODUCT → WHAT RESULT
```

- Base URL: `https://<your-domain>/api/v1`
- Auth: `Authorization: Bearer <api key>`. Create keys in **Admin → API keys**. Only a hash is stored, so a key is shown once.
- Content type: `application/json`
- Rate limit: 600 requests/minute per key (`429` + `Retry-After` when exceeded)
- Every write takes an `external_id`, which makes retries safe: sending the same `type` + `external_id` twice records one event.

---

## The three app events

| Event | Who records it | How |
|---|---|---|
| `app_download_clicked` | This site | Automatically, when anyone taps an App Store / Google Play button (`/go/app/ios`, `/go/app/android`, or a tracked link whose destination is the app). Attribution comes from the visitor's affiliate cookie. |
| `app_account_linked` | App backend | `POST /app/link` (link code or verified email) or `POST /events` |
| `activation_completed` | App backend | `POST /events` with `type: "activation_completed"` |

**What counts as "activation" is still to be defined by Suraj and Surendra** (blueprint §9). Whatever you agree, send `activation_completed` when it happens. The affiliate's back office then updates on its own.

### Store attribution

When **Admin → Settings → Append affiliate attribution** is on, store redirects carry:

- **Apple:** `ct=<AFFILIATE_ID>.<click_id>` (campaign token, max 40 chars), plus `pt=<provider token>` if one is configured.
- **Google Play:** `referrer=utm_source=chew_affiliate&utm_campaign=<AFFILIATE_ID>&click_id=<click_id>` (read it with the Play Install Referrer API).

If the app backend passes `click_id` or `affiliate_id` back in `attribution` (see `POST /events`), results are tied to the exact click, link, content and source.

---

## Endpoints

### `GET /health`
No auth. Returns `{ "ok": true }`.

### `GET /affiliates/:affiliateId`
Checks an Affiliate ID, for example a referral code someone types into the app.

```json
200 { "affiliate_id": "CHW7K3M9Q", "display_name": "Jane D." }
404 { "error": "not_found" }
```

### `POST /app/link`
Links the app user to their Chew account. Pass **one** of:

- `link_code`: the 8-character code shown in **Back Office → See It. Cook It.** It expires after 15 minutes and works once.
- `email` + `email_verified: true`: recognizes an account by an email **the app has already verified**.

Optional: `app_user_id` (your stable user ID, stored so later events can use it) and `external_id`.

```http
POST /api/v1/app/link
Authorization: Bearer chk_...
Content-Type: application/json

{ "link_code": "7KQ2M9XZ", "app_user_id": "sic_48213" }
```

```json
200 { "ok": true, "already_linked": false,
      "user": { "affiliate_id": "CHW7K3M9Q", "first_name": "Jane", "app_linked": true, "activated": false } }
404 { "error": "user_not_found" }            // bad or expired code, or no active account
409 { "error": "app_user_already_linked" }   // app_user_id belongs to another Chew account
```

This records `app_account_linked`. Credit goes to the affiliate who referred this user, if there is one.

### `POST /events`

| Field | Required | Notes |
|---|---|---|
| `type` | yes | `app_account_linked`, `activation_completed`, `qualifying_action`, `purchase` |
| `external_id` | yes | Your unique event ID (idempotency key) |
| `user` | app events | The Chew account that did it: `{ "affiliate_id" }`, `{ "app_user_id" }` or `{ "email" }` |
| `attribution` | commerce events | Who gets credit: `{ "click_id" }` and/or `{ "affiliate_id" }` |
| `destination` | no | Product or destination key, e.g. `meal-kit-box` |
| `value_cents` | no | Integer order value, used by percentage commission rules |
| `currency` | no | ISO code, default `USD` |
| `metadata` | no | Object, stored for auditing |

**Activation:**

```json
{ "type": "activation_completed", "external_id": "act_48213",
  "user": { "app_user_id": "sic_48213" } }
```

```json
200 { "ok": true, "duplicate": false, "event_id": 812,
      "user": { "affiliate_id": "CHW7K3M9Q", "first_name": "Jane", "app_linked": true, "activated": true },
      "reward": null }
```

`reward` is only filled in when management has switched on the configurable activation reward (**Admin → Settings → App activation reward**). The reward's name, amount and unit are never hard-coded.

**Purchase / qualifying action from a partner:**

```json
{ "type": "purchase", "external_id": "order_99812",
  "attribution": { "click_id": "Zx81kQp2mN4r" },
  "destination": "meal-kit-box", "value_cents": 4999, "currency": "USD" }
```

```json
200 { "ok": true, "duplicate": false, "event_id": 813, "commissions_created": 1 }
422 { "ok": false, "error": "unattributed" }   // click_id unknown and no affiliate_id given
```

With a `click_id`, the event inherits the click's affiliate, link, campaign, content and source. That is how every result answers *who → what content → what source → what link → what product → what result*.

---

## Commissions

The API never sets amounts. When an event matches an **active** rule in **Admin → Commission rules**, a **Pending** ledger entry is created for the credited affiliate:

`amount = fixed amount + (value_cents × percent)`

Finance then approves, pays or reverses it. Rules start inactive. Nothing is paid on self-referrals, on suspended or closed affiliates, or on unattributed events.

## Errors

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Missing or invalid field (see `message`) |
| 401 | `unauthorized` | Missing, invalid or revoked key |
| 404 | `user_not_found` / `affiliate_not_found` / `not_found` | No matching active account |
| 409 | `app_user_already_linked` | That app user is linked to another account |
| 422 | `unattributed` | Event could not be credited to anyone |
| 429 | `rate_limited` | Slow down |

## Quick test with curl

```bash
KEY=chk_...   # from Admin → API keys
curl -s localhost:3000/api/v1/affiliates/CHW7K3M9Q -H "Authorization: Bearer $KEY"
curl -s -X POST localhost:3000/api/v1/events -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"type":"activation_completed","external_id":"test-1","user":{"affiliate_id":"CHW7K3M9Q"}}'
```

---

## See It. Cook It. credits (app backend)

The website keeps the **credit ledger** and the **creator ↔ wholesale affiliate attribution**. The app reports what happens in the app. Every write is **idempotent** on your `transaction_id`, so retries and duplicate webhooks are safe — a repeat returns `200` with `"duplicate": true`. All endpoints need the same `Authorization: Bearer <key>` header.

Creators are identified by **your** user ID (`app_user_id`). Affiliates only ever see a masked creator ID (`creator_ref`, e.g. `CR-7K3M9Q`).

### How credits flow

1. A wholesale affiliate shares a **claim link**. A visitor enters their email on the claim page; credits are reserved and they get a **claim code** (also emailed).
2. The creator signs up / signs in to the app → `POST /sic/creators`. The claim is redeemed and the creator is **assigned** to that affiliate — permanently (first eligible attribution wins).
3. Each **completed video** → `POST /sic/consumptions` (default: the current cost from Settings, 399 credits). A failed video → `.../reverse`.
4. **Payments** (subscription, $1.99 download) → `POST /sic/revenue`; refunds/chargebacks → `POST /sic/refunds`; status changes → `POST /sic/subscriptions`.

### `POST /api/v1/sic/creators` — link a creator (call on every sign-up / sign-in)

```json
{ "app_user_id": "u_123", "email": "cora@example.com", "email_verified": true, "claim_code": "AB3K9QZ2", "referrer_affiliate_id": "CHW7K3M9Q" }
```

All fields except `app_user_id` are optional. `email` is only used when `email_verified` is `true` (it matches claims made on the website). `claim_code` is what the creator typed in the app. `referrer_affiliate_id` (e.g. from the install referrer) assigns an unassigned creator to that affiliate if they are an active wholesale affiliate.

```json
{ "ok": true,
  "creator": { "creator_ref": "CR-7K3M9Q", "app_user_id": "u_123", "assigned": true, "affiliate_id": "CHW7K3M9Q", "balance": 798, "video_cost": 399, "subscription_status": "none" },
  "claims": [ { "grant": "G-…", "ok": true, "reason": null } ] }
```

A claim is released back to its affiliate (`ok: false`) when the creator already belongs to another affiliate (`assigned_elsewhere`), still has unused credits (`unused_credits`), or already redeemed another claim (`duplicate_claim`).

### `GET /api/v1/sic/creators/:app_user_id` — balance and status

Returns the same `creator` object. Check `balance >= video_cost` before starting a video.

### `POST /api/v1/sic/consumptions` — a video completed

```json
{ "transaction_id": "gen_789", "app_user_id": "u_123", "job_id": "job_789" }
```

Optional `credits` (default: current cost per video). `201 { "balance": 399 }`, or `409 insufficient_credits` — nothing is taken. Credits come from the creator's grants, oldest first. Two simultaneous requests can never overspend.

### `POST /api/v1/sic/consumptions/:transaction_id/reverse` — the video failed

`{ "reason": "render_failed" }` → credits go back to the creator. Safe to repeat.

### `POST /api/v1/sic/revenue` — a payment

```json
{ "transaction_id": "in_456", "app_user_id": "u_123", "category": "subscription", "amount_cents": 2495, "net_cents": 2120, "currency": "USD", "plan": "monthly" }
```

`category`: `subscription` or `download`. `net_cents` (optional) is the amount after taxes, store and payment fees — commission percentages apply to it when given, otherwise to `amount_cents`. A subscription payment also sets the creator's status to `active`. Commissions follow the **active rules** for *See It. Cook It. subscription payment* / *watermark-free download* in Admin → Commission rules (none are active by default); only the creator's assigned affiliate is credited.

### `POST /api/v1/sic/refunds` — refund or chargeback

```json
{ "transaction_id": "re_1", "original_transaction_id": "in_456", "amount_cents": 2495, "kind": "refund" }
```

`kind`: `refund` or `chargeback`; omit `amount_cents` for a full refund. Pending/approved commissions on the original payment are reversed; if already paid (or partially refunded), a negative adjustment is added and linked to the original entry.

### `POST /api/v1/sic/subscriptions` — status change

`{ "app_user_id": "u_123", "status": "canceled", "plan": "monthly" }` — `status`: `active`, `trialing`, `past_due`, `canceled`, `none`.

### Errors

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Missing or invalid field |
| 404 | `unknown_creator` / `not_found` | Call `POST /sic/creators` first / unknown transaction |
| 409 | `insufficient_credits` | Not enough credits for this video |

### Quick test

```bash
curl -s -X POST localhost:3000/api/v1/sic/creators -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"app_user_id":"u_123","email":"cora@example.com","email_verified":true}'
curl -s -X POST localhost:3000/api/v1/sic/consumptions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"transaction_id":"gen_1","app_user_id":"u_123"}'
```
