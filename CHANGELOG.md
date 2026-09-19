# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
