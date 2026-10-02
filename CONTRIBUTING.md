# Contributing to ratatoskr

ratatoskr is a Discord bot that reports mod updates from Thunderstore, Hexium and Nexus Mods. It runs on the Cloudflare Workers free plan, so most design decisions come from three limits: 10 ms of CPU, 50 subrequests and the D1 row quotas per day. Read `AGENTS.md` ("Hard constraints") before you propose a change; a change that breaks one of them cannot be merged however useful it is.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), not through a public issue.

## Where to start

- A defect: open a bug report. The form asks for the version, the area and what you expected.
- A new capability: open a feature request and describe the problem before the solution.
- A question or a setup problem: use [Discussions](https://github.com/odin-sons/ratatoskr/discussions).
- A typo or a broken link can go straight to a pull request against the open release branch; a maintainer files the issue.

Check the open issues first. Issues labelled `good first issue` and `help wanted` are the ones where a pull request is welcome.

Never paste a webhook URL, an API key or a token into an issue, a pull request or a test. The bot strips URLs and webhook paths from its `event: "run"` log line; terminal and dashboard output is not cleaned at all.

## Setup

You need Node.js 24 and pnpm (the exact pnpm version is pinned in `package.json`).

```
pnpm install
pnpm check      # typecheck, lint, tests, config validation
pnpm test       # tests only
pnpm dev        # wrangler dev with scheduled-event testing
```

`pnpm check` is what CI runs. It has to pass before a pull request is reviewed. The README explains deployment; you do not need a Cloudflare account to work on the code, because tests run against an in-memory SQLite shim.

## Making a change

1. Find or create an issue. Maintainers attach it to a milestone (`vX.Y.Z`).
2. Branch from the milestone's release branch (`release/X.Y.Z`), not from `main`. Name the branch `feat/…`, `fix/…`, `perf/…`, `docs/…`, `test/…`, `chore/…` or `ci/…`.
3. Write the test first for behavior changes; a bug fix starts with a test that reproduces it.
4. Keep one concern per pull request and one concern per commit.
5. Open the pull request against the release branch and fill in the template. Link the issue with `Refs #n`.

Repository infrastructure (issue and pull request templates, community files, CI, agent rules) targets `main` directly, because GitHub reads templates only from the default branch.

### Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(hexium): …`, `fix(drain): …`. Commits on the release branch are signed. If you cannot sign, say so in the pull request and a maintainer re-signs your commits after review; the author stays you.

### Version and changelog

Pull requests do not change the version in `package.json`, `PROJECT.version` in `src/core/constants.ts` or `CHANGELOG.md`. Describe the change in the pull request body; the release pull request collects those descriptions into the changelog and bumps the version once. Versions follow [Semantic Versioning](https://semver.org/): patch for a fix, minor for a backward-compatible feature, major for a breaking change.

### Review and merge

A maintainer reviews every pull request. Expect questions about worst-case cost: how many subrequests, how many D1 rows, how many milliseconds of CPU, ideally with a measurement. Maintainers merge with a fast-forward after rebasing on the release branch, so the history stays linear and signed.

## Code conventions

- TypeScript in strict mode, zero runtime dependencies. Adding one needs a discussion first.
- Platform-agnostic logic in `src/core`, Cloudflare specifics only in `src/cloudflare`.
- Numbers that mirror an external limit live in `src/core/constants.ts` with a note on where they come from.
- Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- Comments are rare. Name what an unusual construct is for, in one line; put the reasoning in the pull request.
- Code, comments, documentation and commit messages are in English.

## Licence

The project is AGPL-3.0-or-later. By sending a contribution you agree that it is licensed under the same terms. Do not copy code from repositories without a licence, for example `thunderstore-ui` (see `docs/legal.md`).
