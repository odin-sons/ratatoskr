-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One-time upgrade for a database created before the bot columns of `subscriptions` existed.
--   wrangler d1 execute ratatoskr --remote --file=./migrations/0005_bot_subscriptions.sql
-- Then apply schema.sql as usual. Run it once. Existing rows become webhook subscriptions and keep working unchanged.

DROP TABLE IF EXISTS subscriptions_new;

CREATE TABLE subscriptions_new (
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
  CHECK ((transport = 'webhook' AND webhook_url IS NOT NULL) OR (transport = 'bot' AND channel_id IS NOT NULL))
);

INSERT INTO subscriptions_new (id, guild_id, webhook_url, thread_id, filter, mode, digest_interval_min, enabled)
SELECT id, guild_id, webhook_url, thread_id, filter, mode, digest_interval_min, enabled FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;

CREATE INDEX idx_subscriptions_enabled ON subscriptions (enabled);
CREATE INDEX idx_subscriptions_channel ON subscriptions (channel_id);
CREATE INDEX idx_subscriptions_guild ON subscriptions (guild_id);
