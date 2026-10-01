-- SPDX-License-Identifier: AGPL-3.0-or-later
-- ratatoskr D1 schema for a fresh install; re-applying it to a database it created is harmless.
--   wrangler d1 execute ratatoskr --remote --file=./schema.sql
-- It does not alter existing tables. A database created before `outbox.delivered_at` existed
-- needs migrations/0001_outbox_delivered_at.sql once, and one created before `packages.download_url` and
-- `packages.downloads` existed needs migrations/0002_package_download_url_and_downloads.sql once, and one created before
-- `packages.likes` and `packages.website_url` existed needs migrations/0003_package_likes_and_website.sql once, and one
-- created before `subscriptions.thread_id` existed needs migrations/0004_subscription_thread_id.sql once, before this file.

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  cursor TEXT,
  etag TEXT,
  bootstrapped INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT
);

CREATE TABLE IF NOT EXISTS packages (
  source TEXT NOT NULL,
  package_id TEXT NOT NULL,
  store TEXT NOT NULL,
  latest_version TEXT NOT NULL,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  url TEXT NOT NULL,
  icon_url TEXT,
  download_url TEXT,
  downloads INTEGER,
  likes INTEGER,
  website_url TEXT,
  description TEXT,
  categories TEXT NOT NULL DEFAULT '[]',
  size_bytes INTEGER,
  is_nsfw INTEGER NOT NULL DEFAULT 0,
  is_deprecated INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, package_id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  package_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('new', 'update')),
  version_from TEXT,
  version_to TEXT NOT NULL,
  changelog TEXT,
  changelog_url TEXT,
  release_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
DROP INDEX IF EXISTS idx_events_created;
CREATE INDEX IF NOT EXISTS idx_events_release ON events (release_key, created_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  thread_id TEXT,
  filter TEXT NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'digest' CHECK (mode IN ('immediate', 'digest')),
  digest_interval_min INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_enabled ON subscriptions (enabled);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  parked INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  UNIQUE (subscription_id, event_id)
);
DROP INDEX IF EXISTS idx_outbox_due;
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (next_attempt_at) WHERE parked = 0 AND delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_delivered ON outbox (delivered_at) WHERE delivered_at IS NOT NULL;

-- Example subscription (one per Discord channel webhook). Keep the webhook URL secret.
-- INSERT INTO subscriptions (id, guild_id, webhook_url, thread_id, filter, mode, digest_interval_min)
-- VALUES (
--   'my-guild-main',
--   '123456789012345678',
--   'https://discord.com/api/webhooks/123456789012345678/YOUR_WEBHOOK_TOKEN',
--   NULL,
--   '{"sources":["thunderstore:valheim"],"kinds":["new","update"],"allowNsfw":false,"dedupAcrossStores":true}',
--   'digest',
--   30
-- );

-- Same webhook, but this subscription delivers into one of its existing forum posts instead of
-- the parent channel (pnpm add-subscription --thread-id <id> sets this for you).
-- INSERT INTO subscriptions (id, guild_id, webhook_url, thread_id, filter, mode, digest_interval_min)
-- VALUES (
--   'my-guild-forum-post',
--   '123456789012345678',
--   'https://discord.com/api/webhooks/123456789012345678/YOUR_WEBHOOK_TOKEN',
--   '222233334444555566',
--   '{"sources":["hexium:valheim"]}',
--   'digest',
--   30
-- );
