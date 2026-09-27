# ratatoskr

Discord bot that reports new and updated game mods from Thunderstore, Hexium and
Nexus Mods. Runs entirely on Cloudflare Workers free tier, cron-triggered, with
no inbound HTTP routes.

Named after the squirrel that carries messages up and down Yggdrasil.

Primary target: Valheim. Game is configurable; other people deploy their own
instance for their own game.

## Read first

- `docs/spec.md` — architecture, D1 schema, tick algorithm, digest rendering
- `docs/api-notes.md` — verified upstream endpoints and their gotchas
- `docs/legal.md` — licensing and upstream acceptable-use constraints

## Hard constraints

These are not preferences. Violating them breaks the deployment target.

**Cloudflare Workers free plan:**

- 10 ms CPU per invocation (cron triggers included). Network wait does not
  count — only actual JS execution. This is the binding limit, not quotas.
- 50 external subrequests per invocation (1000 to Cloudflare services)
- 6 simultaneous outgoing connections
- 100,000 requests/day, 128 MB memory
- Cron triggers: 1 minute granularity, 5 per account, **no retries on failure**
- D1 free: 5 GB, 5M rows read/day, 100k rows written/day. Since 2026-09-01
  exceeding these returns errors until 00:00 UTC, not a soft counter.

**Therefore:**

- Never `JSON.parse` a full package dump. Scan large payloads with `indexOf`
  over the raw string and parse only matching slices.
- No `eval` / `new Function` — forbidden in the Workers runtime. This rules out
  runtime-compiled template engines.
- Zero runtime dependencies. Everything via `fetch`, WebCrypto, D1 bindings.
  Build-time dev dependencies are fine.
- No inbound routes. No `workers.dev` subdomain. No custom domain. Cron only.
- No Cloudflare Queues — a D1 outbox table covers our volume and keeps a quota
  free.
- Budget every tick: cap listing fetches, changelog fetches and Discord sends
  per invocation, defer the remainder to the next tick (backpressure).
- Advance a source cursor only after its events are committed to D1, in one
  transaction. Cron has no retries; a crash between read and write silently
  loses updates.

## Conventions

- TypeScript, strict mode.
- All code, comments, file names, commit messages and docs in English.
- Core logic (diff, matcher, renderer) stays platform-agnostic behind
  interfaces. Cloudflare specifics live only in the adapter layer, so the same
  core can run on Node or Vercel later.
- `// SPDX-License-Identifier: AGPL-3.0-or-later` header in every source file.
- Constants that mirror an external limit (Discord, Cloudflare, upstream) live
  in one module with a comment naming the source. Never inline a magic number
  that came from someone else's documentation.
- Conventional commits.
- Semantic Versioning. Bump the version as part of the same change that
  introduces it, not as an afterthought: patch for a fix with no behavior
  change, minor for a backward-compatible feature, major for a breaking one.
  Update in lockstep: `package.json`'s `version` and `PROJECT.version` in
  `src/core/constants.ts` (the latter is user-visible, in every Discord
  message and in the User-Agent sent to all three upstream APIs). Move
  `CHANGELOG.md`'s `[Unreleased]` section to a new `[x.y.z] - YYYY-MM-DD`
  heading in the same commit, leaving `[Unreleased]` empty above it.

## Commands

```
pnpm dev             # wrangler dev
pnpm test            # vitest
pnpm typecheck
pnpm validate-config # build-time config validation, not bundled
wrangler deploy
wrangler d1 execute <db> --file=./schema.sql
```

## What not to do

- Do not add a runtime dependency without asking.
- Do not ship any API key in the repository.
- Do not proxy or mirror mod downloads.
- Do not reproduce upstream content in full — excerpt and link.
- Do not copy code or type definitions from `thunderstore-ui`; that repository
  has no LICENSE file. Write types from observed responses.
- Do not drop mods from a digest to fit a size limit. See the degradation
  ladder in `docs/spec.md`.

## Open questions

Tracked in `docs/spec.md` under "Open questions". Ask before guessing.
