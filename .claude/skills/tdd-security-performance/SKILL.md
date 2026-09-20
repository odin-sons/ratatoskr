---
name: tdd-security-performance
description: Playbook for writing and reviewing TypeScript server code (Node.js and edge runtimes such as Cloudflare Workers): test-first development, security by construction, and per-algorithm cost analysis with optimisation, plus an architecture review checklist. Use when writing new logic or when reviewing a module, diff or commit range.
---

# TDD, security and performance

Two modes share one set of principles:

- **Writing code** — follow "Writing code: test-first", "Security by construction"
  and "Algorithm cost" below, in that order, for every unit of logic.
- **Reviewing code** — use sections 1-8, then verify that the writing rules were
  actually followed (tests exist and assert behaviour, every algorithm has a
  stated cost, trust boundaries are guarded).

Review as an architect, not a linter. Judge whether the design will survive
production, then look at individual lines. Every finding needs a concrete failure
scenario; drop anything you cannot ground in the code.

## 1. Boundaries and dependency direction

- Core logic depends on interfaces (ports); platform code (D1, `fetch`, Workers
  types, `node:*`) lives only in adapters. Flag any import that points from core
  to an adapter, or any platform global used inside core.
- Ports are minimal and honest: every method has one reason to exist, no leaky
  return types (driver rows, `Response` objects) crossing a boundary.
- Pure functions for decisions (diff, filter, render), effects at the edge. A
  function that both decides and performs I/O is hard to test and to budget.
- Composition root builds dependencies once; no hidden singletons, no module
  top-level work that costs CPU on every cold start.

## 2. Async and concurrency

- Every promise is awaited, returned or explicitly detached with an error
  handler. Flag floating promises and `async` callbacks passed to `forEach`.
- `Promise.all` where one failure must not cancel the rest is a bug: use
  `allSettled` or per-item try/catch. Conversely, do not swallow errors silently.
- Unbounded fan-out (`map(fetch)` over a growing list) violates connection and
  subrequest limits. Require an explicit cap and a deferral path for the rest.
- No check-then-act across an `await` on shared state; prefer idempotent writes
  (`INSERT OR IGNORE`, deterministic ids) over locks.
- Timeouts and `AbortSignal` on every outbound call; retries only where the
  operation is idempotent, with backoff and a ceiling.

## 3. Failure model

- State the crash points: what is persisted, what is lost if the process dies
  between two statements. Cursors and offsets advance only after the data they
  cover is durably committed, in the same transaction.
- Failures are isolated per unit of work (per source, per subscription). One bad
  input must not take down the batch.
- Errors carry context but never secrets (URLs with tokens, API keys, webhook
  paths). Logs are one line, structured enough to grep.
- Distinguish retryable from permanent failures explicitly; park instead of
  looping forever.

## 4. Resource budgets

- Treat CPU time, memory, subrequests, connections and storage quotas as part of
  the interface. Find the binding constraint and check the code respects it.
- Large payloads: scan, stream or slice; never `JSON.parse` or `split` something
  whose size is upstream-controlled. Look for accidental O(n²) (nested `find`,
  `includes` in loops, repeated `Array.from`).
- Bounded caches and queues; every collection that grows with input has a cap.
- Database: every query has a supporting index (check `EXPLAIN QUERY PLAN`),
  batches respect bound-parameter and statement limits, writes are minimal.

## 5. Security

- All upstream responses are untrusted: validate shape before use, sanitise text
  before it reaches a rendering surface, escape when building markup or links.
- SSRF: outbound URLs come from config or are validated against an allowlist of
  hosts; never fetch a URL taken from upstream data without checking it.
- No `eval`, `new Function`, dynamic `import()` of untrusted paths, or string-built
  SQL. Bind parameters only.
- Secrets never enter the repo, logs, error messages or URLs. Credentials are
  sent only to the host they belong to; redirects on authenticated requests are
  not followed blindly.
- Privacy-relevant filters (for example NSFW) default to the safe side and fail
  closed when data is missing.

## 6. TypeScript and module hygiene

- `strict` on; no `any` leaking across module boundaries; unknown input narrowed
  by guards, not asserted with `as`.
- Discriminated unions for results instead of nullable soup; exhaustive `switch`.
- ESM only, explicit extensions where the tooling requires them, no circular
  imports, no barrel files that defeat tree shaking on edge bundles.
- Runtime dependencies are a liability: each needs a reason. Prefer platform APIs
  (`fetch`, WebCrypto, `URL`, `TextDecoder`).
- Constants that mirror external limits live in one module with the source
  named; magic numbers elsewhere are findings.

## 7. Testability

- Time, randomness, network and storage are injected. If a test needs a global
  patch to run, the design is wrong.
- Property tests for invariants (nothing dropped, limits respected), example
  tests for behaviour, failure-injection tests for crash safety and idempotency.
- Tests assert behaviour, not implementation; flag tests that would still pass
  with the feature deleted.

## 8. Observability and operations

- Each scheduled run produces a report a human can read: what ran, what was
  skipped, what was deferred, what failed.
- Config is validated at build time, not discovered at runtime in production.
- Migrations are idempotent and safe to run twice.

## Writing code: test-first

Discover the repository's own commands first (`package.json` scripts, CI). Here:
`pnpm vitest run <path>` for a focused run, `pnpm test` and `pnpm typecheck`
before declaring done.

1. **RED** — write a failing test for one behaviour. Watch it fail for the right
   reason; a test that passes immediately proves nothing.
2. **GREEN** — the minimum code that passes. No speculative options.
3. **REFACTOR** — clean up with tests green; re-run after every step.
4. **Bug fix = Prove-It** — first a test that reproduces the bug and fails, then
   the fix, then the full suite.

Test rules:

- Small tests dominate: pure logic, no I/O, milliseconds. Cross a boundary (D1,
  `fetch`) only in a few integration tests, against a real local implementation
  (here `node:sqlite` behind the D1 shim) rather than mocks.
- Prefer real implementation, then fake, then stub, then mock. Mock only slow,
  non-deterministic or side-effecting boundaries. Inject time, randomness,
  network and storage.
- Assert state and outcomes, not which internal methods were called.
- One behaviour per test, names that read as a specification, Arrange-Act-Assert,
  DAMP over DRY — each test tells its whole story.
- Every invariant gets a property test (`fast-check`): nothing dropped, limits
  respected, idempotent on replay, never throws on arbitrary input.
- Every abuse case from "Security by construction" gets a test written before the
  guard it exercises.
- Never skip, weaken or delete a test to get green. Do not re-run an unchanged
  suite for reassurance.

Done means: every new behaviour has a test, bug fixes have a reproduction test
that failed first, the full suite and typecheck pass, no test was disabled.

## Security by construction

Threat-model before coding a feature that touches input, secrets or outbound
calls: list trust boundaries (upstream APIs, D1 rows, secrets, Discord), name the
assets (webhook URLs, API keys, channel reputation), and run STRIDE over each
boundary. Write abuse cases next to use cases and make them the first tests.

Always:

- Validate untrusted data at the boundary and narrow it to a typed value; reject
  or skip malformed input, never coerce silently. Size-cap everything whose size
  upstream controls.
- Parameterised SQL only; identifiers and chunk sizes come from constants.
- Encode output for its sink: escape Markdown and link text, neutralise mentions,
  strip HTML, set `allowed_mentions: { parse: [] }`.
- Outbound: fixed allowlisted hosts or a validated URL shape; credentials go only
  to their own host; no blind redirects on authenticated requests; every call has
  a timeout.
- Secrets live in environment bindings only; never in code, logs, errors, URLs or
  test fixtures. If one leaks, rotate it — deleting the line is not enough.
- Fail closed: unknown safety flags (NSFW, deprecated) resolve to the safe side
  and are sticky, never silently reset.
- Errors and logs are one line, without payloads or credentials.
- New runtime dependencies require asking first; audit the lockfile, block
  install scripts by default, review lockfile diffs.

Ask the user before: new auth flows, new categories of stored sensitive data,
new external integrations, changes to rate limiting.

## Algorithm cost

Every algorithm that runs per invocation, per event or per input item carries an
explicit cost line before it is written and again in review. The binding
constraint here is 10 ms CPU per Worker invocation, so cost is a correctness
property, not a nicety.

For each algorithm state, in the test file or a one-line note beside the code
only when the choice is non-obvious:

- **Time** in terms of the variables that actually grow (N packages, E events,
  S subscriptions, B bytes of payload) — worst case, not average.
- **Space and allocation**: intermediate arrays, strings, parsed objects, copies.
  Large upstream strings are scanned or sliced, not split or parsed whole.
- **I/O cost**: subrequests, D1 statements, rows read and written, bound
  parameters, bytes transferred. Compare against the free-tier budget in
  `CLAUDE.md`.
- **Budget share**: the fraction of 10 ms CPU / 50 subrequests it may consume at
  maximum realistic input.

Choose the cheapest algorithm by default, and go for the maximum optimisation the
budget calls for:

- Replace nested loops with a single pass plus a `Map`/`Set` index (O(n·m) becomes
  O(n+m)); precompute per-subscription or per-run structures once, outside loops.
- Do work lazily and stop early: scan until the target is found, parse only
  matching slices, short-circuit on the cheapest predicate first.
- Avoid allocation in hot paths: no `split`/`map`/`filter` chains over large
  inputs, no repeated `slice`, `JSON.parse`, `RegExp` construction or `Array.from`
  inside loops; hoist regexes; prefer `indexOf` and char codes over regex on
  megabyte inputs; beware catastrophic backtracking.
- Batch I/O: one `IN (...)` chunked under the parameter limit instead of N
  queries; one transaction instead of N commits; write only rows that changed.
- Push work to where it is free: native decompression and `fetch` decoding do not
  spend JS CPU; conditional requests avoid parsing entirely.
- Bound everything: caps on items, bytes, retries, concurrency, with a deferral
  path for the remainder.

Prove it — do not trust intuition:

1. **Measure** the baseline on realistic maximum input (the real payload sizes
   documented in `docs/api-notes.md`), same command and same conditions each time.
   Add a loose-threshold timing test where the budget is tight, with a generous
   multiple of the measured value and a warm-up before timing.
2. **Change one thing at a time**, re-measure the same way.
3. **Keep** a change only if it beats run-to-run noise and tests stay green; a
   neutral or worse result is **reverted**, even if already written. Correctness
   gates the number: an optimisation that drops needed work is a regression.
4. **Log** attempts, kept and reverted, in the PR description or `PERF.md` so a
   dead idea is not tried twice.
5. Review question for every loop, and every `await` inside one: what is the worst
   case, what does it cost against the budget, and is there a strictly cheaper
   way that keeps behaviour identical?

Red flags: cost stated as "should be fast"; quadratic behaviour over
events × subscriptions or packages × versions; parsing then discarding; an
optimisation kept without a measurement; a timing test with no headroom.

## Severity

- **critical**: data loss, security hole, or a violated hard limit that breaks
  the deployment target.
- **major**: wrong behaviour under realistic input, or a missing safeguard for a
  known failure mode.
- **minor**: maintainability, clarity, small inefficiency.
- Do not report style preferences, formatting, or anything a linter enforces.
