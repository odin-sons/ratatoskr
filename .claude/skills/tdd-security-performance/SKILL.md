---
name: tdd-security-performance
description: Playbook for writing and reviewing TypeScript server code (Node.js and edge runtimes such as Cloudflare Workers): test-first development, security by construction, and per-algorithm cost analysis with optimisation, plus an architecture review checklist. Use when writing new logic or when reviewing a module, diff or commit range.
---

# TDD, security and performance

Writing code: apply Part A in order for every unit of logic — test first, then
security, then cost. Reviewing code: apply Part B, then check that Part A was
actually followed. Every finding needs a concrete failure scenario; drop what you
cannot ground in the code. Review as an architect, not a linter.

# Part A — Writing code

## A1. Test-first

Discover the repository's own commands first (`package.json`, CI). Here:
`pnpm vitest run <path>` focused, `pnpm test` and `pnpm typecheck` before done.

1. **RED** — a failing test for one behaviour, failing for the right reason.
2. **GREEN** — the minimum code that passes; no speculative options.
3. **REFACTOR** — tidy with tests green; re-run after each step.
4. **Bug fix = Prove-It** — reproduce with a failing test, then fix, then full suite.

Rules:

- Small tests dominate: pure logic, no I/O, milliseconds. Cross a boundary (D1,
  `fetch`) in few integration tests against a real local implementation (here
  `node:sqlite` behind the D1 shim). Prefer real > fake > stub > mock; mock only
  slow, non-deterministic or side-effecting boundaries.
- Inject time, randomness, network and storage; a test that needs a global patch
  signals a design flaw.
- Assert outcomes, not internal calls. One behaviour per test, spec-like names,
  Arrange-Act-Assert, DAMP over DRY.
- Invariants get property tests (`fast-check`): nothing dropped, limits respected,
  idempotent on replay, never throws on arbitrary input. Crash safety and
  idempotency get failure-injection tests.
- Every abuse case from A2 gets a test written before its guard.
- Never skip, weaken or delete a test to get green; flag tests that would still
  pass with the feature removed; do not re-run an unchanged suite.

Done: each new behaviour has a test, bug fixes have a reproduction that failed
first, suite and typecheck pass, nothing disabled.

## A2. Security by construction

Threat-model before coding anything touching input, secrets or outbound calls:
list trust boundaries (upstream APIs, D1 rows, secrets, Discord), name assets
(webhook URLs, API keys, channel reputation), run STRIDE per boundary, write abuse
cases beside use cases.

- Validate untrusted data at the boundary and narrow it to a typed value with a
  guard, not `as`; skip or reject malformed input, never coerce. Size-cap anything
  upstream controls.
- Parameterised SQL only; no `eval`, `new Function`, or dynamic `import()` of
  untrusted paths.
- Encode for the sink: escape Markdown and link text, neutralise mentions, strip
  HTML, always `allowed_mentions: { parse: [] }`.
- Outbound: fixed hosts or a validated URL shape (SSRF); credentials only to their
  own host; no blind redirects on authenticated requests; a timeout on every call;
  retry only idempotent operations, with backoff and a ceiling.
- Secrets live in environment bindings only — never in code, logs, errors, URLs or
  fixtures. A leaked secret is rotated, not just deleted.
- Fail closed: unknown safety flags (NSFW, deprecated) resolve to the safe side and
  are sticky, never silently reset.
- Errors and logs are one line, without payloads or credentials.
- Runtime dependencies need the user's approval; audit the lockfile, block install
  scripts by default, review lockfile diffs.

Ask the user first: new auth flows, new categories of stored sensitive data, new
external integrations, changes to rate limiting.

## A3. Algorithm cost

Every algorithm that runs per invocation, per event or per input item carries an
explicit cost line before it is written and again in review. The binding limit is
10 ms CPU per Worker invocation, so cost is a correctness property.

State, in the test or in a one-line note only where the choice is non-obvious:

- **Time** in the variables that grow (N packages, E events, S subscriptions,
  B payload bytes), worst case.
- **Space/allocation**: intermediate arrays, strings, parsed objects, copies.
- **I/O**: subrequests, D1 statements, rows read/written, bound parameters, bytes,
  checked against the budget in `CLAUDE.md`. Every query has an index
  (`EXPLAIN QUERY PLAN`), batches respect parameter and statement limits.
- **Budget share** at maximum realistic input.

Pick the cheapest algorithm by default and optimise as far as the budget calls for:

- Nested loops become one pass plus `Map`/`Set` (O(n·m) → O(n+m)); hoist per-run
  and per-subscription structures out of loops.
- Work lazily and stop early: scan to the target, parse only matching slices,
  cheapest predicate first.
- No allocation in hot paths: no `split`/`map`/`filter` chains, repeated `slice`,
  `JSON.parse`, `RegExp` construction or `Array.from` over large or looped input;
  prefer `indexOf`/char codes to regex on megabyte input; avoid backtracking.
- Batch I/O: chunked `IN (...)` not N queries; one transaction not N; write only
  changed rows. Let native code work for free: decompression, `fetch` decoding,
  conditional requests.
- Bound everything: caps on items, bytes, retries, concurrency, with a deferral
  path. Caches and queues that grow with input have a limit.

Prove it:

1. **Measure** on realistic maximum input (payload sizes in `docs/api-notes.md`),
   same command and conditions each time. Where the budget is tight add a
   loose-threshold timing test with a warm-up and generous headroom.
2. **Change one thing at a time**; re-measure identically.
3. **Keep** a change only if it beats run-to-run noise with tests green; neutral or
   worse is **reverted**, even if written. An optimisation that drops needed work
   is a regression.
4. **Log** kept and reverted attempts in the PR description or `PERF.md`.
5. For every loop, and every `await` inside one, ask: worst case? cost against the
   budget? a strictly cheaper equivalent?

Red flags: "should be fast" with no numbers; quadratic behaviour over
events × subscriptions or packages × versions; parsing then discarding; an
optimisation kept without measurement; a timing test with no headroom.

# Part B — Review lens

## B1. Boundaries and dependency direction

- Core depends on ports; platform code (D1, `fetch`, Workers types, `node:*`) lives
  in adapters only. Flag imports pointing from core to an adapter or platform
  globals used in core.
- Ports are minimal; no driver rows or `Response` objects crossing a boundary.
- Pure functions decide, the edge performs effects; a function doing both is hard
  to test and to budget.
- One composition root; no hidden singletons; no CPU-costly module top-level work.

## B2. Async and concurrency

- Every promise is awaited, returned or detached with an error handler; no `async`
  callbacks in `forEach`.
- `Promise.all` where one failure must not cancel the rest is a bug (`allSettled`
  or per-item try/catch); swallowing errors silently is a bug too.
- Unbounded fan-out (`map(fetch)`) violates connection and subrequest limits.
- No check-then-act across an `await` on shared state; prefer idempotent writes
  (`INSERT OR IGNORE`, deterministic ids) over locks.
- Timeouts and `AbortSignal` on outbound calls.

## B3. Failure model

- State the crash points: what is persisted, what is lost between two statements.
  Cursors advance only after the data they cover is committed, in the same
  transaction.
- Failures are isolated per unit of work (source, subscription); one bad input
  never takes down the batch.
- Retryable and permanent failures are distinguished; park rather than loop.

## B4. TypeScript and module hygiene

- `strict`; no `any` across module boundaries; discriminated unions over nullable
  soup; exhaustive `switch`.
- ESM only, no circular imports, no barrel files that defeat edge bundle
  tree-shaking.
- Prefer platform APIs (`fetch`, WebCrypto, `URL`, `TextDecoder`) to dependencies.
- Constants mirroring external limits live in one module with the source named;
  magic numbers elsewhere are findings.

## B5. Operations

- Each scheduled run yields a readable report: ran, skipped, deferred, failed.
- Config is validated at build time; migrations are idempotent.

## Severity

- **critical**: data loss, security hole, or a violated hard limit that breaks the
  deployment target.
- **major**: wrong behaviour under realistic input, or a missing safeguard for a
  known failure mode.
- **minor**: maintainability, clarity, small inefficiency.
- Do not report style preferences, formatting, or anything a linter enforces.
