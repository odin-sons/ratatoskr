# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.1] - 2026-10-01

### Fixed

- Hexium: an update to a package still on page 1 of the listing (still among the
  most recently *created* packages, which can last hours or days after creation
  regardless of how many times it's been updated since) had its full per-package
  lookup skipped whenever the listing happened to deliver that same new version
  this tick. The listing never carries a download link, so the update committed
  with a null `download_url` — and since the store's package upsert replaces
  `download_url` wholesale on a version change, it clobbered any previously-good
  link too. The delivered-listing dedup now only excuses the lookup for a
  package the store has never seen; a version change of an already-known
  package always gets a full lookup. Ticks without an index scan now look up known
  packages whose version the listing changed (at most 6 per tick).

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
