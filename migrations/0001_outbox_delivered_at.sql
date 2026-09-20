-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One-time upgrade for a database created before `outbox.delivered_at` existed.
--   wrangler d1 execute ratatoskr --remote --file=./migrations/0001_outbox_delivered_at.sql
-- Then apply schema.sql as usual. Not repeatable: the ALTER fails, and nothing else runs, once the column exists.

ALTER TABLE outbox ADD COLUMN delivered_at TEXT;
DROP INDEX IF EXISTS idx_outbox_due;
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (next_attempt_at) WHERE parked = 0 AND delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_delivered ON outbox (delivered_at) WHERE delivered_at IS NOT NULL;
