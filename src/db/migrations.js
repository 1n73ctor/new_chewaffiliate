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
];
