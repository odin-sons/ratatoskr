-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One-time upgrade for a database created before `subscriptions.thread_id` existed.
--   wrangler d1 execute ratatoskr --remote --file=./migrations/0004_subscription_thread_id.sql
-- Then apply schema.sql as usual. Not repeatable: the ALTER fails once the column exists.

ALTER TABLE subscriptions ADD COLUMN thread_id TEXT;
