-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One-time upgrade for a database created before `subscriptions.channel_kind` existed.
--   wrangler d1 execute ratatoskr --remote --file=./migrations/0006_subscription_channel_kind.sql
-- Then apply schema.sql as usual. Not repeatable: the ALTER fails once the column exists. Existing rows become `text`.

ALTER TABLE subscriptions ADD COLUMN channel_kind TEXT NOT NULL DEFAULT 'text' CHECK (channel_kind IN ('text', 'forum'));
