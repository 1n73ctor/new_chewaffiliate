'use strict';
// Ordered list of schema migrations. Each entry runs once; PRAGMA user_version
// records how many have been applied. Never edit a shipped migration — append.

module.exports = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id                    INTEGER PRIMARY KEY,
    affiliate_id          TEXT UNIQUE,
    first_name            TEXT NOT NULL,
    last_name             TEXT NOT NULL,
    email                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
    mobile                TEXT,
    country               TEXT,
    password_hash         TEXT NOT NULL,
    role                  TEXT NOT NULL DEFAULT 'affiliate',
    status                TEXT NOT NULL DEFAULT 'pending_verification',
    email_verified_at     TEXT,
    phone_verified_at     TEXT,
    terms_accepted_at     TEXT,
    agreement_version     TEXT,
    agreement_accepted_at TEXT,
    agreement_ip          TEXT,
    marketing_consent     INTEGER NOT NULL DEFAULT 0,
    marketing_consent_at  TEXT,
    sms_consent           INTEGER NOT NULL DEFAULT 0,
    sms_consent_at        TEXT,
    referred_by           INTEGER REFERENCES users(id),
    referral_click_id     TEXT,
    signup_source         TEXT,
    signup_ip             TEXT,
    app_link_code         TEXT UNIQUE,
    app_link_code_expires TEXT,
    app_user_ref          TEXT,
    app_linked_at         TEXT,
    app_activated_at      TEXT,
    last_login_at         TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_users_referred_by ON users(referred_by);
  CREATE INDEX idx_users_status ON users(status);
  CREATE INDEX idx_users_app_ref ON users(app_user_ref);

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip         TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE verification_codes (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel     TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT NOT NULL,
    consumed_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_codes_user ON verification_codes(user_id);

  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE outbox (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    channel    TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    subject    TEXT,
    body       TEXT,
    driver     TEXT,
    status     TEXT NOT NULL DEFAULT 'sent',
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_outbox_user ON outbox(user_id);

  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_by INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE pathway_categories (
    id          INTEGER PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    tagline     TEXT,
    image       TEXT,
    icon        TEXT,
    sort        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE pathways (
    id          INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES pathway_categories(id),
    title       TEXT NOT NULL,
    summary     TEXT,
    details     TEXT,
    status      TEXT NOT NULL DEFAULT 'coming_soon',
    cta_label   TEXT,
    cta_url     TEXT,
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_pathways_cat ON pathways(category_id, sort);

  CREATE TABLE destinations (
    id     INTEGER PRIMARY KEY,
    key    TEXT NOT NULL UNIQUE,
    label  TEXT NOT NULL,
    kind   TEXT NOT NULL DEFAULT 'site',
    url    TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    sort   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE campaigns (
    id              INTEGER PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    description     TEXT,
    destination_key TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    starts_on       TEXT,
    ends_on         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE content_categories (
    id   INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE content_assets (
    id              INTEGER PRIMARY KEY,
    category_id     INTEGER REFERENCES content_categories(id) ON DELETE SET NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    caption         TEXT,
    platforms       TEXT,
    media_type      TEXT NOT NULL DEFAULT 'image',
    file_path       TEXT,
    thumb_path      TEXT,
    external_url    TEXT,
    destination_key TEXT,
    campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'draft',
    created_by      INTEGER REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_assets_status ON content_assets(status, category_id);

  CREATE TABLE todays3 (
    rank     INTEGER PRIMARY KEY CHECK (rank BETWEEN 1 AND 3),
    asset_id INTEGER REFERENCES content_assets(id) ON DELETE SET NULL,
    set_by   INTEGER REFERENCES users(id),
    set_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE content_usage (
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset_id          INTEGER NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
    previewed_at      TEXT,
    caption_copied_at TEXT,
    link_created_at   TEXT,
    downloaded_at     TEXT,
    PRIMARY KEY (user_id, asset_id)
  );

  CREATE TABLE tracked_links (
    id              INTEGER PRIMARY KEY,
    code            TEXT NOT NULL UNIQUE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label           TEXT,
    campaign_id     INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    content_id      INTEGER REFERENCES content_assets(id) ON DELETE SET NULL,
    source          TEXT,
    destination_key TEXT NOT NULL,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_links_user ON tracked_links(user_id);

  CREATE TABLE clicks (
    id                INTEGER PRIMARY KEY,
    click_id          TEXT NOT NULL UNIQUE,
    link_id           INTEGER REFERENCES tracked_links(id) ON DELETE SET NULL,
    affiliate_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    campaign_id       INTEGER,
    content_id        INTEGER,
    source            TEXT,
    destination_key   TEXT,
    visitor_id        TEXT,
    ip_hash           TEXT,
    user_agent        TEXT,
    referer           TEXT,
    is_bot            INTEGER NOT NULL DEFAULT 0,
    is_self           INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_clicks_aff ON clicks(affiliate_user_id, created_at);
  CREATE INDEX idx_clicks_link ON clicks(link_id);

  CREATE TABLE events (
    id                INTEGER PRIMARY KEY,
    type              TEXT NOT NULL,
    affiliate_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    subject_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    click_id          TEXT,
    link_id           INTEGER,
    campaign_id       INTEGER,
    content_id        INTEGER,
    source            TEXT,
    destination_key   TEXT,
    value_cents       INTEGER,
    currency          TEXT,
    external_id       TEXT,
    origin            TEXT NOT NULL DEFAULT 'web',
    metadata          TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_events_external ON events(type, external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX idx_events_aff ON events(affiliate_user_id, created_at);
  CREATE INDEX idx_events_subject ON events(subject_user_id, type);

  CREATE TABLE commission_rules (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    percent_bps  INTEGER NOT NULL DEFAULT 0,
    currency     TEXT NOT NULL DEFAULT 'USD',
    active       INTEGER NOT NULL DEFAULT 0,
    description  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE commissions (
    id                INTEGER PRIMARY KEY,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id          INTEGER REFERENCES events(id) ON DELETE SET NULL,
    rule_id           INTEGER REFERENCES commission_rules(id) ON DELETE SET NULL,
    amount_cents      INTEGER NOT NULL,
    currency          TEXT NOT NULL DEFAULT 'USD',
    status            TEXT NOT NULL DEFAULT 'pending',
    description       TEXT,
    note              TEXT,
    created_by        INTEGER REFERENCES users(id),
    status_changed_by INTEGER REFERENCES users(id),
    status_changed_at TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_commissions_event_rule ON commissions(event_id, rule_id) WHERE event_id IS NOT NULL AND rule_id IS NOT NULL;
  CREATE INDEX idx_commissions_user ON commissions(user_id, status);

  CREATE TABLE rewards (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    label      TEXT NOT NULL,
    amount     TEXT,
    unit       TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',
    event_id   INTEGER REFERENCES events(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, kind)
  );

  CREATE TABLE announcements (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    body       TEXT,
    link_url   TEXT,
    link_label TEXT,
    pinned     INTEGER NOT NULL DEFAULT 0,
    published  INTEGER NOT NULL DEFAULT 0,
    publish_on TEXT,
    expires_on TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE training_modules (
    id        INTEGER PRIMARY KEY,
    title     TEXT NOT NULL,
    summary   TEXT,
    sort      INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE training_lessons (
    id        INTEGER PRIMARY KEY,
    module_id INTEGER NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
    title     TEXT NOT NULL,
    summary   TEXT,
    body      TEXT,
    video_url TEXT,
    minutes   INTEGER,
    sort      INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE training_progress (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson_id    INTEGER NOT NULL REFERENCES training_lessons(id) ON DELETE CASCADE,
    completed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, lesson_id)
  );

  CREATE TABLE resources (
    id          INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    category    TEXT,
    url         TEXT,
    audience    TEXT NOT NULL DEFAULT 'public',
    sort        INTEGER NOT NULL DEFAULT 0,
    published   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE pages (
    slug       TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    body       TEXT,
    version    TEXT,
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE faqs (
    id        INTEGER PRIMARY KEY,
    question  TEXT NOT NULL,
    answer    TEXT,
    category  TEXT,
    sort      INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE support_tickets (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name        TEXT,
    email       TEXT NOT NULL,
    topic       TEXT,
    subject     TEXT NOT NULL,
    message     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE ticket_notes (
    id         INTEGER PRIMARY KEY,
    ticket_id  INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE affiliate_notes (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE api_keys (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    created_by   INTEGER REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at   TEXT
  );

  CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY,
    actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    detail      TEXT,
    ip          TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_audit_time ON audit_log(created_at);
  `,

  /* 2: remove the pre-launch "Draft for review" notice from legal pages */ `
  UPDATE pages
     SET body = ltrim(substr(body, instr(body, char(10)) + 1), char(10) || char(13))
   WHERE body LIKE '> Draft for review by Chew Network management and counsel.%';
  UPDATE pages SET version = '1.0' WHERE version = 'draft-1';
  UPDATE settings SET value = '1.0' WHERE key = 'agreement_version' AND value = '2026-09-draft-1';
  `,

  /* 3: account lockout + two-step sign-in (TOTP) for staff */ `
  ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN locked_until TEXT;
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_pending_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER;

  CREATE TABLE recovery_codes (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_recovery_user ON recovery_codes(user_id);
  `,

  /* 4: pay-per-click — click validation status + daily aggregated commissions */ `
  ALTER TABLE clicks ADD COLUMN status TEXT NOT NULL DEFAULT 'ineligible';
  ALTER TABLE clicks ADD COLUMN reject_reason TEXT;
  ALTER TABLE clicks ADD COLUMN confirmed_at TEXT;
  CREATE INDEX idx_clicks_ppc ON clicks(affiliate_user_id, status, created_at);
  CREATE INDEX idx_clicks_ip ON clicks(ip_hash, created_at);

  ALTER TABLE commissions ADD COLUMN period TEXT;
  ALTER TABLE commissions ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
  CREATE UNIQUE INDEX idx_commissions_daily ON commissions(user_id, rule_id, period)
    WHERE period IS NOT NULL AND status = 'pending';

  -- Networks each account has signed in from (hashed), to spot self-clicking.
  CREATE TABLE login_ips (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_hash   TEXT NOT NULL,
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, ip_hash)
  );
  `,

  /* 5: See It. Cook It. wholesale credits — packages, inventory batches, grants,
        consumption, creator attribution and an append-only credit ledger */ `
  CREATE TABLE wholesale_accounts (
    user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    wholesale_id        TEXT NOT NULL UNIQUE,
    status              TEXT NOT NULL DEFAULT 'active',
    attribution_ack_at  TEXT,
    attribution_ack_version TEXT,
    site_request_url    TEXT,
    site_request_note   TEXT,
    site_request_status TEXT,
    site_requested_at   TEXT,
    notify_low_balance  INTEGER NOT NULL DEFAULT 1,
    notify_claims       INTEGER NOT NULL DEFAULT 1,
    notify_earnings     INTEGER NOT NULL DEFAULT 1,
    low_balance_notified_at TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE promo_domains (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain      TEXT NOT NULL,
    token       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    checked_at  TEXT,
    verified_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, domain)
  );

  CREATE TABLE credit_packages (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    currency    TEXT NOT NULL DEFAULT 'USD',
    credits     INTEGER NOT NULL CHECK (credits > 0),
    active      INTEGER NOT NULL DEFAULT 1,
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE package_orders (
    id                INTEGER PRIMARY KEY,
    ref               TEXT NOT NULL UNIQUE,
    user_id           INTEGER NOT NULL REFERENCES users(id),
    package_id        INTEGER REFERENCES credit_packages(id) ON DELETE SET NULL,
    package_name      TEXT NOT NULL,
    price_cents       INTEGER NOT NULL,
    currency          TEXT NOT NULL,
    credits           INTEGER NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    stripe_session_id TEXT UNIQUE,
    stripe_payment_intent TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at           TEXT,
    refunded_at       TEXT
  );
  CREATE INDEX idx_orders_user ON package_orders(user_id, id);

  -- Inventory a wholesale affiliate owns. Credits leave "available" when they are
  -- reserved for a claim or granted to a creator, and come back if a claim expires.
  CREATE TABLE credit_batches (
    id                INTEGER PRIMARY KEY,
    ref               TEXT NOT NULL UNIQUE,
    user_id           INTEGER NOT NULL REFERENCES users(id),
    order_id          INTEGER UNIQUE REFERENCES package_orders(id),
    source            TEXT NOT NULL,
    credits_total     INTEGER NOT NULL CHECK (credits_total > 0),
    credits_available INTEGER NOT NULL CHECK (credits_available >= 0),
    credits_written_off INTEGER NOT NULL DEFAULT 0 CHECK (credits_written_off >= 0),
    status            TEXT NOT NULL DEFAULT 'active',
    note              TEXT,
    created_by        INTEGER REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (credits_available + credits_written_off <= credits_total)
  );
  CREATE INDEX idx_batches_user ON credit_batches(user_id, status, id);

  -- App users (See It. Cook It. creators). Only a masked ref is ever shown to affiliates.
  CREATE TABLE creators (
    id                  INTEGER PRIMARY KEY,
    ref                 TEXT NOT NULL UNIQUE,
    app_user_id         TEXT NOT NULL UNIQUE,
    email_hash          TEXT,
    subscription_status TEXT NOT NULL DEFAULT 'none',
    subscription_plan   TEXT,
    subscription_updated_at TEXT,
    last_active_at      TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_creators_email ON creators(email_hash);

  -- One wholesale affiliate per creator, for the life of the app (PRIMARY KEY).
  CREATE TABLE creator_attribution (
    creator_id        INTEGER PRIMARY KEY REFERENCES creators(id),
    affiliate_user_id INTEGER NOT NULL REFERENCES users(id),
    source            TEXT NOT NULL,
    grant_id          INTEGER,
    link_id           INTEGER,
    click_id          TEXT,
    campaign_id       INTEGER,
    assigned_at       TEXT NOT NULL DEFAULT (datetime('now')),
    assigned_by       INTEGER REFERENCES users(id)
  );
  CREATE INDEX idx_attr_affiliate ON creator_attribution(affiliate_user_id, assigned_at);

  CREATE TABLE attribution_transfers (
    id           INTEGER PRIMARY KEY,
    creator_id   INTEGER NOT NULL REFERENCES creators(id),
    from_user_id INTEGER REFERENCES users(id),
    to_user_id   INTEGER NOT NULL REFERENCES users(id),
    reason       TEXT NOT NULL,
    by_user_id   INTEGER REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A claim link: a tracked link that hands out free credits.
  CREATE TABLE claim_offers (
    id         INTEGER PRIMARY KEY,
    link_id    INTEGER NOT NULL UNIQUE REFERENCES tracked_links(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    credits    INTEGER NOT NULL CHECK (credits > 0),
    max_claims INTEGER NOT NULL CHECK (max_claims > 0),
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Credits given to one creator. "pending" = claimed on the website, waiting for the
  -- creator to sign in to the app; its credits are reserved until then.
  CREATE TABLE credit_grants (
    id                INTEGER PRIMARY KEY,
    ref               TEXT NOT NULL UNIQUE,
    user_id           INTEGER NOT NULL REFERENCES users(id),
    creator_id        INTEGER REFERENCES creators(id),
    offer_id          INTEGER REFERENCES claim_offers(id),
    link_id           INTEGER,
    click_id          TEXT,
    claim_code        TEXT UNIQUE,
    email_hash        TEXT,
    ip_hash           TEXT,
    credits           INTEGER NOT NULL CHECK (credits > 0),
    credits_remaining INTEGER NOT NULL CHECK (credits_remaining >= 0),
    status            TEXT NOT NULL,
    source            TEXT NOT NULL,
    override_by       INTEGER REFERENCES users(id),
    expires_at        TEXT,
    activated_at      TEXT,
    closed_at         TEXT,
    close_reason      TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (credits_remaining <= credits)
  );
  CREATE INDEX idx_grants_user ON credit_grants(user_id, status);
  CREATE INDEX idx_grants_creator ON credit_grants(creator_id, status, id);
  CREATE INDEX idx_grants_email ON credit_grants(email_hash, status);
  CREATE INDEX idx_grants_offer ON credit_grants(offer_id, status);

  -- Which batch funded which part of a grant (a grant can span two batches).
  CREATE TABLE credit_grant_parts (
    id        INTEGER PRIMARY KEY,
    grant_id  INTEGER NOT NULL REFERENCES credit_grants(id),
    batch_id  INTEGER NOT NULL REFERENCES credit_batches(id),
    credits   INTEGER NOT NULL CHECK (credits > 0),
    remaining INTEGER NOT NULL CHECK (remaining >= 0),
    CHECK (remaining <= credits)
  );
  CREATE INDEX idx_parts_grant ON credit_grant_parts(grant_id, id);
  CREATE INDEX idx_parts_batch ON credit_grant_parts(batch_id);

  -- Credits spent in the app (one row per completed video), reported by the app.
  CREATE TABLE credit_consumptions (
    id          INTEGER PRIMARY KEY,
    ref         TEXT NOT NULL UNIQUE,
    creator_id  INTEGER NOT NULL REFERENCES creators(id),
    credits     INTEGER NOT NULL CHECK (credits > 0),
    job_id      TEXT,
    status      TEXT NOT NULL DEFAULT 'consumed',
    reversed_at TEXT,
    reverse_reason TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_consumptions_creator ON credit_consumptions(creator_id, id);

  CREATE TABLE credit_consumption_parts (
    consumption_id INTEGER NOT NULL REFERENCES credit_consumptions(id),
    part_id        INTEGER NOT NULL REFERENCES credit_grant_parts(id),
    credits        INTEGER NOT NULL CHECK (credits > 0),
    PRIMARY KEY (consumption_id, part_id)
  );

  -- Append-only record of every credit movement. Never updated or deleted.
  CREATE TABLE credit_ledger (
    id             INTEGER PRIMARY KEY,
    ref            TEXT NOT NULL UNIQUE,
    type           TEXT NOT NULL,
    user_id        INTEGER REFERENCES users(id),
    creator_id     INTEGER REFERENCES creators(id),
    batch_id       INTEGER REFERENCES credit_batches(id),
    grant_id       INTEGER REFERENCES credit_grants(id),
    consumption_id INTEGER REFERENCES credit_consumptions(id),
    credits        INTEGER NOT NULL,
    source         TEXT,
    status         TEXT NOT NULL DEFAULT 'posted',
    reversal_of    INTEGER REFERENCES credit_ledger(id),
    actor_id       INTEGER REFERENCES users(id),
    note           TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_ledger_user ON credit_ledger(user_id, id);
  CREATE INDEX idx_ledger_creator ON credit_ledger(creator_id, id);
  CREATE INDEX idx_ledger_batch ON credit_ledger(batch_id);
  CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE ON credit_ledger
    BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END;
  CREATE TRIGGER credit_ledger_no_delete BEFORE DELETE ON credit_ledger
    BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END;

  -- Attribution enforced in the database: a creator only ever receives credits from
  -- the wholesale affiliate they are assigned to.
  CREATE TRIGGER grants_match_attribution_ins BEFORE INSERT ON credit_grants
    WHEN NEW.creator_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM creator_attribution WHERE creator_id = NEW.creator_id AND affiliate_user_id != NEW.user_id)
    BEGIN SELECT RAISE(ABORT, 'creator_assigned_elsewhere'); END;
  CREATE TRIGGER grants_match_attribution_upd BEFORE UPDATE OF creator_id ON credit_grants
    WHEN NEW.creator_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM creator_attribution WHERE creator_id = NEW.creator_id AND affiliate_user_id != NEW.user_id)
    BEGIN SELECT RAISE(ABORT, 'creator_assigned_elsewhere'); END;

  -- Revenue events from the app carry the creator; commissions get their basis,
  -- payout reference and a link to the entry they reverse.
  ALTER TABLE events ADD COLUMN creator_id INTEGER REFERENCES creators(id);
  ALTER TABLE commissions ADD COLUMN basis TEXT;
  ALTER TABLE commissions ADD COLUMN payout_ref TEXT;
  ALTER TABLE commissions ADD COLUMN reversal_of INTEGER REFERENCES commissions(id);

  ALTER TABLE tracked_links ADD COLUMN utm_campaign TEXT;

  ALTER TABLE content_assets ADD COLUMN format TEXT;
  ALTER TABLE content_assets ADD COLUMN download_allowed INTEGER NOT NULL DEFAULT 1;

  ALTER TABLE training_modules ADD COLUMN track TEXT NOT NULL DEFAULT 'general';
  ALTER TABLE training_lessons ADD COLUMN coming_soon INTEGER NOT NULL DEFAULT 0;

  -- Approved copy: ready-to-use ads, giveaway templates and the creator FAQ.
  CREATE TABLE promo_copy (
    id        INTEGER PRIMARY KEY,
    kind      TEXT NOT NULL,
    audience  TEXT,
    title     TEXT NOT NULL,
    body      TEXT NOT NULL,
    guidance  TEXT,
    sort      INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 1
  );

  -- "Become a Business Affiliate" inquiries, routed to sales/admin.
  CREATE TABLE business_leads (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    phone       TEXT NOT NULL,
    company     TEXT,
    audience    TEXT NOT NULL,
    volume      TEXT NOT NULL,
    consent_at  TEXT NOT NULL,
    lead_source TEXT,
    page        TEXT,
    affiliate_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status      TEXT NOT NULL DEFAULT 'new',
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,

  /* 6: direct credit purchases from the homepage ("Buy credits") — paid through
        Stripe by email, credited to an affiliate account by an admin */ `
  CREATE TABLE credit_purchases (
    id                INTEGER PRIMARY KEY,
    ref               TEXT NOT NULL UNIQUE,
    email             TEXT NOT NULL COLLATE NOCASE,
    name              TEXT NOT NULL,
    phone             TEXT,
    package_id        INTEGER REFERENCES credit_packages(id) ON DELETE SET NULL,
    package_name      TEXT NOT NULL,
    price_cents       INTEGER NOT NULL,
    currency          TEXT NOT NULL,
    credits           INTEGER NOT NULL,
    terms_version     TEXT NOT NULL,
    terms_accepted_at TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    stripe_session_id TEXT UNIQUE,
    stripe_payment_intent TEXT,
    ip_hash           TEXT,
    paid_at           TEXT,
    refunded_at       TEXT,
    credited_user_id  INTEGER REFERENCES users(id),
    credited_batch_id INTEGER UNIQUE REFERENCES credit_batches(id),
    credited_by       INTEGER REFERENCES users(id),
    credited_at       TEXT,
    admin_note        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_purchases_status ON credit_purchases(status, id);
  CREATE INDEX idx_purchases_email ON credit_purchases(email);
  `,
];
