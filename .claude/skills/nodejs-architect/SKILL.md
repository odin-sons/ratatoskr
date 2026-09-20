---
name: nodejs-architect
description: Architectural review lens for Node.js / TypeScript services, including edge runtimes such as Cloudflare Workers. Use when reviewing module boundaries, async correctness, resource budgets, error handling, security and testability of server-side JavaScript.
---

# Node.js architect

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

## Severity

- **critical**: data loss, security hole, or a violated hard limit that breaks
  the deployment target.
- **major**: wrong behaviour under realistic input, or a missing safeguard for a
  known failure mode.
- **minor**: maintainability, clarity, small inefficiency.
- Do not report style preferences, formatting, or anything a linter enforces.
