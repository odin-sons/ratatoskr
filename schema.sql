-- SPDX-License-Identifier: AGPL-3.0-or-later
-- ratatoskr D1 schema for a fresh install; re-applying it to a database it created is harmless.
--   wrangler d1 execute <database name> --remote --file=./schema.sql
-- It does not alter existing tables. A database created before `outbox.delivered_at` existed
-- needs migrations/0001_outbox_delivered_at.sql once, and one created before `packages.download_url` and
-- `packages.downloads` existed needs migrations/0002_package_download_url_and_downloads.sql once, and one created before
-- `packages.likes` and `packages.website_url` existed needs migrations/0003_package_likes_and_website.sql once, and one
-- created before `subscriptions.thread_id` existed needs migrations/0004_subscription_thread_id.sql once, and one
-- created before the bot columns of `subscriptions` existed needs migrations/0005_bot_subscriptions.sql once, one created
-- before `subscriptions.channel_kind` existed needs migrations/0006_subscription_channel_kind.sql once, and one created before `/info`
-- needs migrations/0007_mod_threads_thread_index.sql once, and one created before message templates needs migrations/0008_templates.sql once
-- (applying this file creates the same index and table); run them before this file.

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
CREATE INDEX IF NOT EXISTS idx_packages_owner ON packages (owner COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_packages_name ON packages (name COLLATE NOCASE);

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
  transport TEXT NOT NULL DEFAULT 'webhook' CHECK (transport IN ('webhook', 'bot')),
  webhook_url TEXT,
  channel_id TEXT,
  thread_id TEXT,
  label TEXT,
  created_by TEXT,
  filter TEXT NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'digest' CHECK (mode IN ('immediate', 'digest')),
  digest_interval_min INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  thread_per_mod INTEGER NOT NULL DEFAULT 0,
  paused_until INTEGER NOT NULL DEFAULT 0,
  channel_kind TEXT NOT NULL DEFAULT 'text' CHECK (channel_kind IN ('text', 'forum')),
  CHECK ((transport = 'webhook' AND webhook_url IS NOT NULL) OR (transport = 'bot' AND channel_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_enabled ON subscriptions (enabled);
CREATE INDEX IF NOT EXISTS idx_subscriptions_channel ON subscriptions (channel_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_guild ON subscriptions (guild_id);

-- One thread per mod and channel, shared by every subscription of that channel.
CREATE TABLE IF NOT EXISTS mod_threads (
  channel_id TEXT NOT NULL,
  source TEXT NOT NULL,
  package_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  anchor_message_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, source, package_id)
);
CREATE INDEX IF NOT EXISTS idx_mod_threads_thread ON mod_threads (channel_id, thread_id);

-- Message templates of a subscription (docs/templates.md): the message of an event and the line of a mod in a digest.
CREATE TABLE IF NOT EXISTS templates (
  subscription_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('immediate', 'digest_line')),
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, kind)
) WITHOUT ROWID;

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

-- The level each alert was last sent (or cleared) at, so an alert goes out once per level.
CREATE TABLE IF NOT EXISTS alert_state (
  alert_key TEXT PRIMARY KEY,   -- '<source id>:<limit id>', e.g. 'hexium:valheim:index-lines'
  level INTEGER NOT NULL,
  notified_at TEXT NOT NULL
);

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
