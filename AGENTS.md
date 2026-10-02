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
- `CONTRIBUTING.md` — the human-facing version of the Git workflow below

## Hard constraints

These are not preferences. Violating them breaks the deployment target.

**Cloudflare Workers free plan:**

- 10 ms CPU per invocation (cron triggers included). Network wait does not
  count — only actual JS execution. This is the binding limit, not quotas.
- 50 external subrequests per invocation (1000 to Cloudflare services)
- 6 simultaneous outgoing connections
- 100,000 requests/day, 128 MB memory
- Cron triggers: 1 minute granularity, 5 per account, **no retries on failure**
- D1 free: 500 MB per database (5 GB per account), 5M rows read/day, 100k rows
  written/day. Since 2026-09-01 exceeding the daily limits returns errors until
  00:00 UTC, not a soft counter. A full database rejects writes ("Exceeded
  maximum DB size") until rows are deleted.

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
- Keep D1 daily reads and writes within the budget guards in `docs/spec.md`
  ("D1 schema"); `pnpm check` enforces them.
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
- Semantic Versioning: patch for a fix with no behavior change, minor for a
  backward-compatible feature, major for a breaking one. The release PR picks the
  highest level in the milestone. `PROJECT.version` in `src/core/constants.ts` is
  user-visible: it is in every Discord message and in the User-Agent sent to all
  three upstream APIs.

## Git workflow

Applies to every agent and every human, cloud sessions included.

- One concern per PR, one concern per commit. Branch names: `feat/…`, `fix/…`,
  `perf/…`, `docs/…`, `test/…`, `chore/…`, `ci/…`.
- Work happens in a milestone `vX.Y.Z` with a release branch `release/X.Y.Z` cut
  from `main`. The version number in both names is provisional: if the highest
  change level in the milestone ends up different, rename the milestone and the
  branch. Task PRs target the release branch. Repository infrastructure
  (issue and PR templates, community files, CI, agent rules) targets `main`,
  because GitHub reads templates only from the default branch. If the task has no
  milestone yet, ask the user which one to use.
- Every task has an issue made from the forms in `.github/ISSUE_TEMPLATE/` and
  attached to the milestone (a small fix from an outside contributor may arrive
  without one; a maintainer then creates it). The PR body follows `.github/PULL_REQUEST_TEMPLATE.md`
  and links the issue with `Refs #n`; `Closes #n` only fires for merges into `main`,
  so the release PR carries the `Closes` lines.
- A PR never edits `package.json`'s `version`, `PROJECT.version` or `CHANGELOG.md`.
  Describe the change in the PR body; the release PR collects the descriptions.
- Before every commit: `pnpm check`, then review the uncommitted diff with
  `.agents/agents/code-reviewer.md` (in Claude Code, start a general-purpose agent
  and give it that file as its instructions), fix the verified findings, commit.
  The review comes before the commit, not after it.
- Commits are Conventional Commits and GPG-signed. Never `--no-gpg-sign`; plumbing
  such as `git commit-tree` needs an explicit `-S`. If signing fails because the
  agent is locked, stop and tell the user; never handle a passphrase.
- Merge locally: rebase the branch on its base, `git merge --ff-only`, push, then
  `git push origin --delete <branch>`. Never `gh pr merge` or the web merge button:
  GitHub's server-side merge strips signatures.
- Release: when the milestone is done, one release PR (`release/X.Y.Z` into `main`)
  bumps `package.json`, `PROJECT.version` and `CHANGELOG.md` and lists `Closes #n`
  for every issue. The changelog section is written from the milestone's PR bodies
  (a draft comes from `gh api repos/odin-sons/ratatoskr/releases/generate-notes`,
  grouped by `.github/release.yml`): move `[Unreleased]` to a `## [x.y.z] -
  YYYY-MM-DD` heading and leave `[Unreleased]` empty above it; the release workflow
  extracts that exact heading and fails without it. After the PR lands on `main`, tag it (`git tag -s vX.Y.Z -m 'vX.Y.Z'`, `git push origin
  vX.Y.Z`). The tag triggers `.github/workflows/release.yml`: a GitHub Release from
  the matching `CHANGELOG.md` section, then a deploy gated on approving the
  `production` environment (a required reviewer approves; it is not automatic).
- Text written for the repository (docs, templates, issue and PR bodies) goes
  through the `unslop` skill when it is available.

## Commands

```
pnpm dev             # wrangler dev
pnpm test            # vitest
pnpm check           # typecheck, lint, tests, validate-config: what CI runs
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
