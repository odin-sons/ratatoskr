# Specification

## Shape

A cron-triggered Worker with no inbound routes. One tick does:

```
cron (*/5)
  └─ for each enabled source:
       fetch listing (ETag / If-None-Match)
       diff against cursor + seen-state in D1
       write events + outbox rows          ← one transaction
       advance cursor                       ← same transaction
  └─ drain outbox within this tick's budget
```

The upstream poll is **global per deployment**, never per guild. One fetch feeds
every subscribed channel. Only filtering and rendering are per subscription.

Cross-deployment cache sharing is impossible without a public endpoint, and we
do not want one. Each operator gets their own free-tier quota, which is used at
single-digit percentages anyway.

### Portability

Keep the core (diff, matcher, renderer) free of Cloudflare APIs, behind:

```ts
interface Store {
  getSourceState(source: SourceId): Promise<SourceState | null>;
  commit(batch: CommitBatch): Promise<void>;                       // packages, events, outbox, cursor: one transaction
  recentEventsByReleaseKeys(keys: string[], sinceIso: string): Promise<Map<string, ModEvent[]>>;  // one call per batch
  existingEventIds(ids: string[]): Promise<Set<string>>;          // events are never deleted; one call per batch
  takeDue(nowIso: string, limit: number): Promise<DueDelivery[]>;  // oldest first
  markDelivered(ids: string[], deliveredAtIso: string): Promise<void>;
  markFailedMany(ids: string[], nextAttemptAtIso: string, parked: boolean): Promise<void>;  // bumps attempts
  rescheduleRows(ids: string[], nextAttemptAtIso: string): Promise<void>;                   // leaves attempts alone
  purgeDelivered(olderThanIso: string, limit: number): Promise<number>;
  // ...plus source-state, subscription and changelog accessors; see src/core/ports.ts
}

interface Sender {
  send(webhookUrl: string, payload: DiscordMessage): Promise<SendResult>;
}
```

Cloudflare adapter: D1 + `fetch`. A Node adapter (SQLite) and a Vercel adapter
should require no changes to the core. Every `Store` implementation must pass
the shared contract suite in `src/testing/store-contract.ts` (run against the
in-memory store and the D1 store over a SQLite shim).

## Sources

Per game, per store. Game is configuration, not code. Cost is linear in
enabled sources: one listing fetch per source per tick (Hexium adds an index read and
at most 15 lookups every 3rd tick).

| Source | Per-tick listing | Covers new | Covers updates |
|---|---|---|---|
| Thunderstore | `cyberstorm/listing?ordering=last-updated` | yes | yes |
| Hexium | `frontend/packages` (creation order) + `package-index` and per-package lookups | yes | yes, via the index |
| Nexus | `mods/updated.json?period=1d` | via `latest_added` | yes |

Hexium has no sorted-by-update listing and will not get one soon — the
undocumented sort parameters were tested and are ignored. The full dump
`/api/v1/package/` carries every version of every package and grows without
bound (4.4 MB to 6.7 MB in six days), so it is not used. Updates come from the
lean package index `/api/experimental/package-index/` (NDJSON, one line per
package with only its latest version, ~515 KB for 1318 packages, growing only with
the package count) plus one per-package lookup
`/api/experimental/package/{namespace}/{name}/` for each package that changed.
Hexium therefore runs on a **split cadence**:

- every tick: `frontend/packages?page=1` — 20 items, cheap, catches new
  packages within one tick, with their flags
- every 3rd tick (~15 min): read the index once and scan it in a single
  `indexOf` pass, comparing each line's `version_number` with the versions the
  store already knows. Candidates are the packages whose version differs and the
  packages the store has never seen (this path only runs after bootstrap).
  Each candidate gets one lookup, at most 15 per poll, six at a time, starting
  at a window that advances by 15 per scan; the poll is then reported
  incomplete and the rest are found again by the next scan, so nothing is
  lost. The snapshot is built from the lookup only: version = `latest`, flags
  and categories from the community entry, `updatedAt` = `date_updated`,
  `sizeBytes` from the index line. A failed lookup defers its candidate;
  nothing is ever emitted from lean index data. The index has no NSFW or
  deprecated flag, so those come from the lookup and fail closed: a missing
  community entry or a `has_nsfw_content` other than boolean `false` means NSFW,
  a non-boolean `is_deprecated` quarantines the candidate. A package the
  listing already delivered at the same version needs no lookup

Updates on Hexium arrive with up to 15 minutes of latency, plus one scan
interval per 15 pending changes. That is acceptable for a digest that fires
every 30 minutes anyway. Neither the listing nor the index honours
`If-None-Match` (no `ETag`, no `Last-Modified`), so every scan downloads the
whole index; do not raise the cadence without measuring. A scan costs ~1.5 ms
CPU at 1318 lines (4 ms for the whole tick, 7 ms at the 3000-line cap
`HEXIUM_INDEX_MAX_LINES`; `docs/api-notes.md` has the numbers). An index beyond
the caps, or one that cannot be read, is skipped with one log line and the
listing result is kept; the source then only sees new packages until the cap is
raised.

- **Cold start** seeds every package from the index as a lean snapshot (index
  version, size, `isNsfw` and `isDeprecated` false, no metadata) in 8 stable
  slices, one per poll (about 40 minutes), slice = hash of `namespace-name`
  modulo 8. No events: the poll returns `complete: false` until the last slice,
  which keeps the source un-bootstrapped and silent. Seeded rows are safe
  because they are never emitted: any later event for such a package goes
  through a lookup that supplies the real flags, and the stores' upserts keep
  flags sticky and never overwrite richer stored fields with nulls. The seed
  cursor is `seed:<next slice>`; a cursor that is out of range or of an older
  format restarts at slice 0, and the cursor is empty after the last slice.
  Packages created while seeding are found by the first index scans after
  bootstrap as unseen packages.

### Reconciliation

Three times a day, walk the full index for each store that offers one (for
Hexium, the whole package index in one read), compare against D1 and emit anything
missed: packages whose version differs from D1 or that D1 lacks get a full lookup,
at most 20 per run, unchanged packages produce nothing. This covers the two real gaps:
cron triggers have no retries, so a failed tick is simply skipped; and a burst
larger than one listing page slips past a page-1 poller.

Reconciliation is a separate cron at a different hour, and it is subject to the
same per-tick budget — process one store per run. Reconcile crons run at minute
1 (`1 3`, `1 4`, `1 5`), never on the 5-minute tick grid, so a reconcile run
never overlaps a tick run (both drain the outbox and write cursors). Each run
gets `sliceHint = floor(scheduledTime / 1 day) * 3 + reconcileIndex` in its
`PollContext`, which advances by one per run, so an adapter with more pending work
than one run can do (Hexium: more than 20 changed packages) starts at a different
candidate each run.

The same run purges delivered outbox rows older than 7 days (at most 1000 per
run, index-backed); see the outbox notes below.

### Cold start

First run per source seeds state and emits nothing. A `bootstrapped` flag per
source. Without it the first tick fires a thousand notifications.

### What counts as an update

Trigger on a change of `version_number`, never on a timestamp moving.
Timestamps shift when a description is edited, a category changes or a rating
lands. A version change is unambiguous.

A package the store has never seen is `new`, unless its snapshot carries a
distinct `previousVersion` (the adapter knows an earlier release exists, e.g.
a pre-existing mod that only got its first update after a partial cold start):
then it is an `update` from that version, with no new-package treatment and no
forced changelog fetch.

Deduplicate across stores on `(normalised_owner, normalised_name,
version_number)` within a 24-hour window: authors publish to Thunderstore and
Hexium minutes apart. First event wins and carries links to the others. Make
this optional per subscription — some channels will want the raw per-store feed.

## D1 schema

Sketch, not final. Indexes are load-bearing: D1 free allows 5M row reads per
day and a full scan on `events` is the only realistic way to reach it. Every
query must show `SEARCH … USING INDEX` under `EXPLAIN QUERY PLAN`.

```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,              -- 'thunderstore:valheim'
  cursor TEXT,                      -- ISO-8601 or opaque
  etag TEXT,
  bootstrapped INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT
);

CREATE TABLE packages (
  source TEXT NOT NULL,
  package_id TEXT NOT NULL,         -- 'Owner-Name'
  latest_version TEXT NOT NULL,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  url TEXT NOT NULL,
  icon_url TEXT,
  categories TEXT,                  -- JSON array
  is_nsfw INTEGER NOT NULL DEFAULT 0,
  is_deprecated INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, package_id)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,              -- hash(source, package_id, version)
  source TEXT NOT NULL,
  package_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- 'new' | 'update'
  version_from TEXT,
  version_to TEXT NOT NULL,
  changelog TEXT,                   -- extracted excerpt, nullable
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_release ON events (release_key, created_at);  -- cross-store dedup lookups

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  filter TEXT NOT NULL,             -- JSON
  mode TEXT NOT NULL,               -- 'immediate' | 'digest'
  digest_interval_min INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  parked INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,                   -- NULL until delivered
  UNIQUE (subscription_id, event_id)   -- idempotency
);
CREATE INDEX idx_outbox_pending ON outbox (next_attempt_at) WHERE parked = 0 AND delivered_at IS NULL;
CREATE INDEX idx_outbox_delivered ON outbox (delivered_at) WHERE delivered_at IS NOT NULL;
```

The `UNIQUE (subscription_id, event_id)` constraint is what makes a re-run
after a crash safe. Delivery does not delete the row: it stamps `delivered_at`,
so a stale read or a version roll-back within the retention window cannot re-create
and re-send a delivered release. Delivered rows are purged after a 7-day retention
by the reconcile run (bounded `DELETE ... WHERE id IN (SELECT ... LIMIT n)` through
`idx_outbox_delivered`).

Purging the outbox does not make an old release deliverable again. Events are never
deleted and their id is deterministic (`source|package|version`), so the tick asks
`existingEventIds` once per source batch (chunked `id IN (...)` over the primary key)
and drops every event that already exists before fan-out: no `events` insert and no
outbox rows. The package upsert and the cursor still commit, so a roll-back to an
already-announced version is recorded silently and the next release is detected
against it. This also keeps a subscription created after a delivery from receiving
an old release on a roll-back.

A subscription whose stored `filter` is not valid JSON or has the wrong shape is
skipped with a one-line warning naming only its id; it never stops the other
subscriptions.

`schema.sql` creates a fresh database and does not alter existing tables. A change
to an existing table ships as a numbered file in `migrations/`, applied once
(`0001_outbox_delivered_at.sql` adds `outbox.delivered_at` and its indexes); a test
applies each migration over the previous schema shape and runs the current queries.

## Volume

Measured/estimated as of 2026-09: Hexium alone produced roughly 270 new and
updated Valheim packages in 24 hours. Thunderstore is higher. Budget for
800 events/day across three stores, of which perhaps 500–600 are unique after
cross-store dedup.

At 288 ticks/day that is under three events per tick — a 20-item listing page
absorbs a tenfold burst.

Quota usage at 800 events/day, two guilds:

| Resource | Free limit | Used | Share |
|---|---|---|---|
| Worker requests | 100,000/day | 288 | 0.3 % |
| D1 rows written | 100,000/day | ~4,000 | 4 % |
| D1 rows read | 5,000,000/day | ~50,000 | 1 % |
| External subrequests | 50/invocation | ≤ 48, enforced | — |

Quotas are not the constraint. CPU time and Discord readability are.

Subrequests are the exception that needs an explicit guard. Polls, changelog
fetches and Discord sends share one per-invocation `SubrequestBudget` (limit 48:
the platform's 50 minus a safety margin). Adapters receive a counting `fetch`
that rejects with a dedicated error once the budget is spent (adapters already
treat a failed fetch as a skipped poll or a missing changelog). Priority: polls
first, then Discord sends, then changelogs, which may only spend what leaves
24 subrequests (the per-tick send cap) unspent. Every send spends one, and a
digest never renders more messages than the budget still allows. Whatever does
not fit is deferred to the next tick, not lost, except changelog excerpts, which
are dropped (`changelogSkipped`).

## Digest rendering

At this volume, one message per mod is unusable: 800 notifications a day is one
every two minutes. Default output is therefore a digest.

- New packages: full embeds with icon and description. There are only tens per
  day and they deserve the space.
- Updates: a compact list, one embed per store with its own colour and footer.
- Digest interval per subscription, default 30 minutes.
- Changelog excerpts only for packages the subscription shows in detail — new
  packages and watchlist hits. This keeps changelog fetches in the tens per day
  rather than the hundreds.

### Progressive delivery

A digest can render to more messages than one webhook may receive in a tick
(~5 per 2 s, and 24 sends per tick overall). It is therefore delivered
progressively, oldest rows first:

1. Take the due rows of a subscription, drop those the subscription's *current*
   filter no longer matches (e.g. `allowNsfw` switched off after fan-out; they
   are marked delivered without sending) and collapse cross-store duplicates.
2. Compute the message allowance: per-webhook cap, per-tick send cap and the
   remaining subrequest budget, whichever is smallest. No allowance means the
   rows stay due.
3. Render the longest leading prefix that fits the allowance: start from at most
   `allowance * 10` detailed embeds plus the compact updates, then scale the
   prefix by allowance / messages for at most three re-renders, then halve. At
   least one entry is always taken, so every webhook makes progress each tick.
4. Send the prefix, mark **only its rows** delivered. The rest stay due and go
   out on the next ticks. A failure fails only the prefix's rows; a partly sent
   prefix may repeat its earlier messages on the retry.

A mod is never dropped or parked because of digest size.

Failure handling in the drain:

- **Batched bookkeeping.** Failed rows are grouped by outcome (retry time, parked) and
  written with one `markFailedMany` per group, a single `db.batch` of `ceil(n / 98)`
  statements; a failed 400-row digest costs at most five statements, not 400.
- **No head-of-line blocking.** When a request to a webhook fails retryably (5xx, 429,
  network), the rest of its rows in the drain window are moved to the same retry time
  with one `rescheduleRows` call and their attempts untouched. Otherwise they stay
  the oldest due rows and fill the `takeDue` window, starving healthy subscriptions.
  Rows deferred only by a cap or the subrequest budget are left where they are.
- **Unrenderable events.** If rendering a digest throws, the failing entries of the
  attempted prefix are found by bisection (about 2n events rendered for one failing
  entry among n, at most n log n for many; at most 400 events per digest in total, after
  which the remaining rows wait for the next tick), parked without retry with the log
  line `outbox parked unrenderable event=<id>`, and the rest is delivered. A render
  error that no single entry reproduces fails the attempted prefix as a transient error.
  An immediate row whose render throws is parked directly. A package row with corrupt
  `categories` JSON is read with no categories rather than failing the whole `takeDue`.

Cost per digest:
O(rows) plus at most `1 + 3 + log2(n)` renders, each smaller than the last;
measured (Node, 400 events, real renderer) about 1.5 ms for 50 detailed events,
4.4 ms for 400 compact updates in one message and 4.6 ms for a mixed 20 % new
backlog (two renders, 250 then 177 entries).

### Discord limits

Every number here is an external constraint. Put them in one constants module
with this file cited.

| Limit | Value | Status |
|---|---|---|
| `content` length | 2000 | documented |
| Embeds per message | 10 | documented |
| `embed.title` | 256 | documented |
| `embed.description` | 4096 | documented |
| `embed.fields` | 25 | documented |
| `embed.fields[].name` | 256 | documented |
| `embed.fields[].value` | 1024 | documented |
| `embed.footer.text` | 2048 | documented |
| `embed.author.name` | 256 | documented |
| **Sum of all text across all embeds in one message** | **6000** | documented — binding |
| Webhook requests | ~5 per 2 s | observed |
| Messages per channel | ~30 per minute | observed |

Always honour `retry_after` from a 429 rather than relying on the observed
figures.

### Degradation ladder

**A mod is never dropped from a digest.** Secondary information may be omitted;
positions may not. Degrade detail first, then add messages.

Draft — to be finalised during implementation, including exact formats and
where the store icon goes:

```
L0  **[Name](url)** 1.2.3 → 1.2.4 · Author · 2.4 MB        ~130 chars
L1  **[Name](url)** 1.2.3 → 1.2.4                          ~105
L2  [Name](url) → 1.2.4                                     ~85
L3  **Author** · [A](u) 1.3 · [B](u) 2.1   (grouped)        ~60/mod
L4  Name 1.2.4, Name2 2.0.1                (no links)       ~25
```

Algorithm:

1. Render at L0. If the message fits the 6000-character budget, send.
2. Otherwise drop to the next level and re-render. The level applies to the
   whole digest, not per item — mixed levels read as a bug.
3. If L4 still overflows, split across messages, footer `(1/3)`. Prefer
   splitting on store boundaries before splitting a store.

L4 fits roughly 240 mods in one message, so a second message should only ever
appear under an anomaly. It must still work when it does.

Required tests:

- Property test: for randomly generated mod lists with random name and URL
  lengths, the rendered output contains exactly as many items as the input.
- Every rendered message satisfies every limit in the table above.
- A single mod with a pathologically long name still renders.

Markdown link URLs count toward the character budget, and they dominate: a
Thunderstore URL is ~64 characters against a ~17-character mod name. Any
compression effort should target URLs first.

## Changelog extraction

The upstream endpoint returns the whole `CHANGELOG.md` shipped with that
version, not a diff. To get the section for the published version:

1. Split on headings matching `^#{1,4}\s`.
2. Take the section whose heading contains the new version number. This
   convention (`## 1.2.4`) is near-universal in this ecosystem.
3. If no heading matches, take the first section — changelogs are
   newest-first by convention.
4. If the response is `null` or nothing usable is found, emit without a
   changelog. This is a nice-to-have, not a feature to fight for.

Truncate to ~1000 characters on a line boundary, never mid-link, and append a
link to the full changelog.

A more exact approach — fetch the changelog for both the old and new version
and diff the prefix — doubles requests for a rare gain. Keep it in mind, do not
implement by default.

Nexus needs none of this: `changelogs.json` is already keyed by version.

## Failure handling

- Cron has no retries. Design each tick to be independently correct.
- One source failing must not block the others. Wrap each adapter; record the
  failure; carry on.
- Hexium is a young platform and its API may change without notice. So may
  Thunderstore's cyberstorm surface, which is partly undocumented. Fail soft
  and log, never crash the tick.
- Discord 429: honour `retry_after`, back off, leave the row in the outbox.
  Every send has a 10 s timeout; a timeout is a retryable failure.
- Outbox rows exceeding an attempt ceiling get parked, not silently dropped.
  Each parking logs `outbox parked rows=N status=S` and counts into the report.
- Cron invocations must not overlap: reconcile crons are off the tick grid.

### Run report

Each scheduled run logs exactly one JSON line (`event: "run"`): cron, per-source
`status`/`events`/`error`, `sent`, `failed`, `deferred` (work that runs later:
sources not polled, outbox rows not attempted), `parked`, `filtered` (rows
dropped at delivery because the filter changed), `purged`, `changelogFetches`,
`changelogSkipped` (dropped, never retried), `subrequests` and `elapsedMs`.
Error texts are one line, capped at 200 characters, with any `scheme://` URL (any case)
and any `.../webhooks/...` path (with or without a scheme) replaced by `[url]`; every
logged error text goes through this filter. Webhook URLs and secrets are never logged.

## Configuration

No inbound endpoint means no slash commands. Configuration is `wrangler secret`
and `wrangler d1 execute`. Accepted trade-off for a zero-surface deployment.

Build-time validation: a schema in `scripts/`, run in CI and pre-deploy, types
generated from it, **not bundled into the Worker**. Runtime input from D1 and
secrets gets a ten-line guard on the write path only — webhook URL looks like a
webhook URL, channel id is numeric. The read path is trusted because we wrote
it.

## Distribution

Deploy-to-Cloudflare button. Each operator runs their own Worker on their own
account and their own quota. No shared hosted instance — see `docs/legal.md`
for why that matters for Nexus specifically.

## Open questions

Resolved live in 2026-09 (see `docs/api-notes.md`):

- Hexium sorted listing — negative; split cadence above.
- Thunderstore cyberstorm listing has no `latest_version_number`; versions come
  from `/versions/`, capped per tick.
- Hexium `package-index` has no `date_updated` or flags and `/api/v1/package/` grows
  without bound; the index detects changes, the per-package lookup supplies flags
  and metadata, and the index also drives seeding and reconciliation.
- Conditional requests — Thunderstore supports `If-Modified-Since` only,
  Hexium supports neither.

Still open:

1. Final degradation ladder formats — implemented in `src/render`; L3 (grouped
   by author) saves little over L2 because URLs dominate.
2. Measured CPU per tick — needs a real deployment to confirm the 10 ms budget.
3. Nexus response shapes are unverified (no API key during development).
4. Persisting `alsoOn` for a release already delivered on another store.
