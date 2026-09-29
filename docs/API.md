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
