-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Message templates per subscription.
--   wrangler d1 execute ratatoskr --remote --file=./migrations/0008_templates.sql
-- Run it once, any time after 0005. Safe to repeat; applying schema.sql creates the same table.

CREATE TABLE IF NOT EXISTS templates (
  subscription_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('immediate', 'digest_line')),
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, kind)
) WITHOUT ROWID;
