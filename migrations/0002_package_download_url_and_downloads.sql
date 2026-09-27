-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One-time upgrade for a database created before `packages.download_url` and `packages.downloads` existed.
--   wrangler d1 execute ratatoskr --remote --file=./migrations/0002_package_download_url_and_downloads.sql
-- Then apply schema.sql as usual. Not repeatable: the first ALTER fails once the columns exist.

ALTER TABLE packages ADD COLUMN download_url TEXT;
ALTER TABLE packages ADD COLUMN downloads INTEGER;
