-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Index behind `/info` inside a mod thread: the mod of a (channel, thread) pair.
--   wrangler d1 execute ratatoskr --remote --file=./migrations/0007_mod_threads_thread_index.sql
-- Run it once, any time after 0005. Safe to repeat; applying schema.sql creates the same index.

CREATE INDEX IF NOT EXISTS idx_mod_threads_thread ON mod_threads (channel_id, thread_id);
