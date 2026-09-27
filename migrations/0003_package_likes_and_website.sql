-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One-time upgrade for a database created before `packages.likes` and `packages.website_url` existed.
--   wrangler d1 execute ratatoskr --remote --file=./migrations/0003_package_likes_and_website.sql
-- Then apply schema.sql as usual. Not repeatable: the first ALTER fails once the columns exist.

ALTER TABLE packages ADD COLUMN likes INTEGER;
ALTER TABLE packages ADD COLUMN website_url TEXT;
