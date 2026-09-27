# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
