# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-10-03

### Added

- A D1 usage monitor. It reads the account's daily D1 usage from Cloudflare's
  analytics API, alerts in the alert channel at 50, 70, 85 and 95 % of the
  rows-read, rows-written and database-size limits and when the day's usage is
  projected to pass 100 %, and degrades optional work in three steps (pause
  reconcile and changelog fetches, scan the Hexium index half as often, stop
  scanning it). Polling and delivery never stop. It needs the Worker secrets
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_ANALYTICS_TOKEN` (a token with only
  Account Analytics: Read) and is off without both.
- A weekly usage report with a seven-day table and chart goes to the alert
  channel on Fridays at 20:00 UTC+3. The chart is rendered by mermaid.ink; the
  numbers are in the message, so a down image service costs only the picture.
- `pnpm run usage [--days N] [--json]` prints the same usage reading.
- Limit alerts: the Hexium package index reports its lines, bytes and visited
  lines against its caps and alerts at 70, 85 and 95 % and when a cap is
  exceeded, naming the cap and what stops working. They go to the alert channel
  set by the Worker secret `ALERT_WEBHOOK_URL`. The level last alerted is kept in
  a new `alert_state` table.
- `WORKER_NAME` and `D1_DATABASE_NAME` (both default to `ratatoskr`) set the
  Worker and D1 database names at deploy time, so several instances can share
  one Cloudflare account without editing a committed file. `pnpm add-subscription`
  and `pnpm subscriptions` default `--database` to `D1_DATABASE_NAME`.
- A dated watch list of known risks in `docs/spec.md`, and a guard in
  `pnpm check` that keeps the worst-case Hexium D1 reads within a tenth of the
  daily limit.
- CONTRIBUTING, CODE_OF_CONDUCT and SECURITY documents, issue forms, a pull
  request template and release-note categories.

### Changed

- The three daily reconcile runs fire from one cron trigger, so an instance uses
  two of the five triggers a free account allows.
- A source's state row is rewritten at most once an hour while its cursor is
  unchanged, which cuts about 790 D1 writes a day.
- CI runs once per change, and the README shows status badges.

### Fixed

- A Hexium update of a known package no longer loses its download link: the
  per-package lookup now runs for every changed known package, and an update
  whose lookup failed is held back and retried on the next tick instead of being
  committed without the link.
- A Hexium package whose name contains a double underscore, such as
  `Pin_It__AutomaticMapPins`, no longer shows backslashes in the message title.

### Deploy notes

- Apply `schema.sql` to the remote database before deploying; it creates
  `alert_state`.
- Deploy outside 03:00-05:15 UTC. The new reconcile cron can take up to 15
  minutes to propagate, and a run delivered under the old schedule is skipped.
- After the deploy the dashboard should show two cron triggers for the Worker.

## [1.2.0] - 2026-10-01

### Added

- `pnpm add-subscription --thread-id <id>` delivers into an existing forum
  post or text-channel thread instead of the webhook's parent channel.
  `pnpm subscriptions list` now also shows each subscription's thread id.
  The thread must already exist; this never creates one.

## [1.1.1] - 2026-09-28

### Fixed

- The tag-triggered deploy read `RATATOSKR_LANGUAGE`, `RATATOSKR_EMOJI` and
  the `STORE_EMOJI_*` values as GitHub secrets; they aren't credentials, so
  they now come from the `production` environment's variables instead. The
  first real deploy after setting up the environment had reset the live
  bot's language and store emoji to their defaults because those four were
  entered as variables, not secrets, and the workflow only read secrets.

## [1.1.0] - 2026-09-27

### Changed

- A new package's message never shows a Changelog block, even if a source
  happened to return one: a first release has no prior version to change
  from. The details phase still runs for a new package (a source's website
  may only be discoverable there), but its changelog and changelog URL are
  discarded rather than stored.
- A digest details at most `MAX_DETAILED_PER_DIGEST` (50) watchlist hits or
  immediate-mode updates per render; a backlog beyond that still gets a
  compact list entry, never dropped or parked. A new package is never
  counted against this cap, since it never carries a changelog and stays
  cheap regardless of count. Bounds the CPU cost of one digest render to a
  small, fixed amount however large the backlog grows.

## [1.0.2] - 2026-09-27

### Changed

- `wrangler.local.jsonc` (a hand-maintained, git-ignored duplicate of
  `wrangler.jsonc`) is gone. `wrangler.jsonc` commits a placeholder
  `database_id`; `pnpm run deploy` substitutes the real one, read from
  `D1_DATABASE_ID` (`.env`), into a throwaway copy next to it, deployed
  from and deleted immediately after.
- New `pnpm run wrangler` command for any other `wrangler` subcommand that
  needs the real database id (for example `d1 execute`); `pnpm
  add-subscription` and `pnpm subscriptions` now print that instead of a
  raw `wrangler d1 execute ...`.

### Added

- `src/cloudflare/crons.test.ts`: verifies `wrangler.jsonc`'s
  `triggers.crons` matches `src/cloudflare/crons.ts`, so the two can no
  longer drift apart silently.

### Fixed

- `pnpm run deploy`/`pnpm run wrangler` no longer silently run for real
  when called as `... -- --dry-run`: pnpm forwards the `--` separator
  itself into the script's argv instead of stripping it, which made
  wrangler read the following flag as a positional after an
  end-of-options marker and ignore it outright.

## [1.0.1] - 2026-09-27

### Added

- ESLint (flat config, typescript-eslint's non-type-checked `recommended`)
  as part of `pnpm check`/`pnpm lint`. Type-checked linting isn't available
  yet: typescript-eslint doesn't support TypeScript 7. Works around that with
  the TypeScript team's own documented side-by-side shim instead of
  downgrading the compiler `tsc --noEmit` uses.
- Tag-triggered GitHub Releases (`.github/workflows/release.yml`): pushing a
  `vX.Y.Z` tag cuts a release from that version's `CHANGELOG.md` section.

### Changed

- CI: split the single `check` job into parallel `typecheck`/`lint`/`test`/
  `validate-config` jobs, consolidated Node/pnpm/install into one composite
  action (`.github/actions/setup`), swapped `pnpm/action-setup` for
  Corepack, and pinned `ubuntu-24.04`. Roughly halved total workflow wall
  time (measured, not estimated).
- Test suite: `pool: 'threads'` and `isolate: false` in `vitest.config.ts`,
  since Vitest was spawning one worker per test file regardless of
  available cores.

### Fixed

- The Russian/English render-cost comparison test no longer flakes under
  CI load: it now samples both locales in alternation instead of one after
  the other, so a transient scheduling spike lands on both instead of
  skewing whichever one happened to be mid-measurement.

## [1.0.0] - 2026-09-27

### Added

- Cron-triggered Cloudflare Worker with no inbound routes, designed for the
  free plan (10 ms CPU, 50 subrequests per invocation).
- Sources: Thunderstore, Hexium, and Nexus Mods (optional, disabled by default).
- New-package and version-change detection with per-source cursors, cold-start
  bootstrapping, and cross-store deduplication.
- D1-backed outbox with idempotent enqueueing, backoff, and parking of
  repeatedly failing deliveries.
- Per-subscription filters: sources, event kinds, watchlist, categories,
  NSFW opt-in (NSFW excluded by default), and cross-store dedup toggle.
- Immediate and digest delivery, with a digest degradation ladder that never
  drops a mod to fit Discord's size limits.
- Changelog excerpt extraction for the published version.
- `ratatoskr.config.json` with build-time validation (`pnpm validate-config`).
- `pnpm add-subscription` helper that prints the `wrangler d1 execute` command
  for a new subscription after validating its inputs.
- `pnpm check` (typecheck, tests, config validation) and a GitHub Actions CI
  workflow.
- README with setup guide, configuration reference, and the licensing and
  acceptable-use disclaimers described in `docs/legal.md`.
- Immediate messages are Discord Components V2 messages (thumbnail, header,
  changelog and categories blocks, link buttons); a trailing subtext line
  outside the coloured block links to the project's source, always present;
  digests keep classic embeds with the same wording.
- Message language (`LANGUAGE`, catalogs `en` and `ru` in `src/i18n`) and a
  configurable emoji for the source link (`RATATOSKR_EMOJI`); `pnpm run deploy`
  passes both from `.env` (`RATATOSKR_LANGUAGE`, `RATATOSKR_EMOJI`).
- Per-subscription `includeChangelog` opt-out (`--no-changelog`) to keep long
  changelogs out of a broad subscription's messages.
