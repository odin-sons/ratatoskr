# Bot implementation plan (2.0.0)

Working plan for milestone v2.0.0. The design is in `docs/spec.md`, section
"Bot". Delete this file when 2.0.0 ships.

Task pull requests target `release/2.0.0`; the first one targets `main` because
it changes the agent rules. Each pull request carries its tests, and `pnpm check`
passes before it merges.

| Order | Issue | Scope | Needs |
|---|---|---|---|
| 1 | #37 | Agent rules allow one signed `POST /interactions` (into `main`) | none |
| 2 | #38 | Spec, README, SECURITY and this plan | none |
| 3 | #39 | Migration `0005`, `Store` writes, thread and message maps, indexes | none |
| 3 | #40 | `Target`, `BotSender`, message ids in `SendResult` | none |
| 4 | #41 | `fetch` handler, signature check, router, permissions, deferred replies | #39, #40 |
| 5 | #42 | `/subscribe`, `/unsubscribe`, `/list`, `register-commands` | #41 |
| 6 | #43 | Thread routing in `drain.ts`, forum posts, digest posts | #39, #40, #42 |
| 7 | #44 | `alsoMatch`, `/filter`, `/include`, `/exclude`, autocomplete | #42 |
| 7 | #45 | `/info`, "Mod info" message command | #39, #40, #42 |
| 8 | #46 | Setup guide | all of the above |

#39 and #40 are independent, as are #44 and #45, so each pair can run in parallel.
The release pull request (`release/2.0.0` into `main`) bumps `package.json`,
`PROJECT.version` and `CHANGELOG.md`, and carries the `Closes` lines.

## Verification

- Unit tests per pull request. Signature tests use a real Ed25519 key pair, D1
  tests use `src/cloudflare/testing/d1-shim.ts`, and every new `Store` method
  runs through `src/testing/store-contract.ts` on both stores.
- Budget tests: CPU of the fetch handler, subrequests of thread creation,
  D1 reads and writes in `d1-budget.test.ts`.
- Routing tests in `drain`: `new` creates a post or anchor, `update` goes into
  the thread, a deleted thread is recreated, a digest batch becomes one post.
- Before the release: an end-to-end run on a test server with one text channel
  and one forum (`/subscribe`, an event, the thread, `/filter`, `/info`,
  `/unsubscribe`), then `SELECT COUNT(*) FROM outbox WHERE parked = 1`.
