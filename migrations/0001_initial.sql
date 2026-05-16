-- Initial schema for grimoire-social.
-- See ../grimoire/docs/social-architecture.md §3.
-- Synthetic user_id PK keeps identity provider pluggable (ADR-001 + extension).

CREATE TABLE users (
  id              TEXT PRIMARY KEY,            -- synthetic; e.g. usr_<base32>
  display_name    TEXT NOT NULL,
  avatar_url      TEXT,
  created_at      INTEGER NOT NULL,            -- unix seconds
  banned_at       INTEGER                      -- soft ban; NULL = active
);

-- One row per (provider, provider_user_id). Lets us add Discord/GitHub later
-- without altering users. Steam goes here as ('steam', '<steamid64>').
CREATE TABLE identity_credentials (
  provider             TEXT NOT NULL,          -- 'steam' for v1
  provider_user_id     TEXT NOT NULL,          -- steamid64 as string
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at            INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX idx_credentials_user ON identity_credentials(user_id);

CREATE TABLE published_profiles (
  id              TEXT PRIMARY KEY,            -- 8-char base32 slug
  owner_user_id   TEXT NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  description     TEXT,
  has_nsfw        INTEGER NOT NULL,            -- derived from blob at publish
  mod_count       INTEGER NOT NULL,
  primary_hero    TEXT,                        -- inferred from mod hints, nullable
  profile_blob    BLOB NOT NULL,               -- gzipped portable profile (~1 KB)
  like_count      INTEGER NOT NULL DEFAULT 0,
  is_featured     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER                      -- soft delete
);
CREATE INDEX idx_profiles_top      ON published_profiles(like_count DESC, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_profiles_new      ON published_profiles(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_profiles_hero     ON published_profiles(primary_hero, like_count DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_profiles_owner    ON published_profiles(owner_user_id);
CREATE INDEX idx_profiles_featured ON published_profiles(updated_at DESC) WHERE is_featured = 1 AND deleted_at IS NULL;

CREATE TABLE likes (
  profile_id      TEXT NOT NULL REFERENCES published_profiles(id),
  voter_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (profile_id, voter_user_id)
);

CREATE TABLE reports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id          TEXT NOT NULL,
  reporter_user_id    TEXT NOT NULL,
  reason              TEXT,
  created_at          INTEGER NOT NULL,
  resolved_at         INTEGER,
  resolution          TEXT                      -- 'dismissed' | 'deleted' | 'banned' | 'reporter_deleted'
);
CREATE INDEX idx_reports_open ON reports(created_at) WHERE resolved_at IS NULL;
