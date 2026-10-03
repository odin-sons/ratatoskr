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
  a non-boolean `is_deprecated` quarantines the candidate (a listing item and a lookup alike). A package the
  store has never seen and the listing already delivered at the same version needs no
  lookup. A known package whose version changed always gets one: on a scan tick via the index, on other ticks via
  the listing page (at most 6 per tick).

Updates on Hexium arrive with up to 15 minutes of latency, plus one scan
interval per 15 pending changes. That is acceptable for a digest that fires
every 30 minutes anyway. Neither the listing nor the index honours
`If-None-Match` (no `ETag`, no `Last-Modified`), so every scan downloads the
whole index; do not raise the cadence without measuring. A scan with comparison
costs ~1.9-2.7 ms CPU cold at 1318 lines and about 4.3 ms including decode and the
stored-version map at the 3500-line cap `HEXIUM_INDEX_MAX_LINES` (`docs/api-notes.md`
has the numbers and the growth estimate: the cap is reached in about two months). An
index beyond the caps, or one that cannot be read, is skipped and the listing result
is kept; the source then only sees new packages. That degradation is not silent: the
poll result carries `warnings`, which the core puts in the source report and the run
log line.

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
  bootstrap as unseen packages. A poll whose index has more unreadable lines than
  `max(3, 1%)` seeds nothing, keeps the cursor and warns, so a transient glitch cannot
  leave holes that would later be announced as new packages.

### Reconciliation

Three times a day (03:01, 04:01 and 05:01 UTC), walk the full index for each store that offers one (for
Hexium, the whole package index in one read), compare against D1 and emit anything
missed: packages whose version differs from D1 or that D1 lacks get a full lookup,
at most 20 per run, unchanged packages produce nothing. This covers the two real gaps:
cron triggers have no retries, so a failed tick is simply skipped; and a burst
larger than one listing page slips past a page-1 poller.

Reconciliation is a separate cron at a different hour, and it is subject to the
same per-tick budget — process one store per run. One cron expression, `1 3,4,5 * * *`,
fires the three runs, so an instance uses two of the five cron triggers a free account
allows (the tick and this one) and two instances fit one account. The run's
`reconcileIndex` (0, 1, 2) comes from the UTC hour of the scheduled time; the minute 1 is
never on the 5-minute tick grid, so a reconcile run never overlaps a tick run (both drain
the outbox and write cursors). Each run gets `sliceHint = floor(scheduledTime / 1 day) * 3 + reconcileIndex` in its
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
`src/cloudflare/d1-store.test.ts` enforces this for every `D1Store` method (a method the
test does not exercise fails it), and `src/core/d1-budget.test.ts` derives the worst-case
daily reads and writes from the cadence constants and bounds them against the free limits.

**Read budget guard (10 %).** The Hexium known-versions read returns one row per stored Hexium
package on every index scan (96 a day) and every reconcile run (3 a day), so its worst case is
`(96 + 3) x HEXIUM_INDEX_MAX_LINES` rows a day. `d1-budget.test.ts` requires that to stay within 10 %
of the daily row-read limit (500,000 of 5,000,000), which leaves the rest of the workload, manual
queries and growth clear of the limit. At the 3,500-line cap it is 346,500 (6.9 %), so the cap can
rise to about 5,000 lines before the test fails. Raising the cap or the scan cadence beyond that is a
deliberate decision: re-measure CPU (see `docs/api-notes.md`), then change the share here and in the
test in the same commit.

```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,              -- 'thunderstore:valheim'
  cursor TEXT,                      -- ISO-8601 or opaque
  etag TEXT,
  bootstrapped INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT                   -- last state write; at most SOURCE_STATE_REFRESH_MS stale, read only by the refresh check
);

CREATE TABLE packages (
  source TEXT NOT NULL,
  package_id TEXT NOT NULL,         -- 'Owner-Name'
  latest_version TEXT NOT NULL,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  url TEXT NOT NULL,
  icon_url TEXT,
  download_url TEXT,                -- direct download link for the Download button, nullable, sticky like icon_url
  downloads INTEGER,                -- total download count, nullable; the latest non-null value wins
  likes INTEGER,                    -- like/rating count, nullable; the latest non-null value wins
  website_url TEXT,                 -- author-supplied website, nullable; the latest non-null value wins
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
  thread_id TEXT,                   -- forum post or channel thread, NULL for the parent channel
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

CREATE TABLE alert_state (
  alert_key TEXT PRIMARY KEY,   -- '<source id>:<limit id>', e.g. 'hexium:valheim:index-lines'
  level INTEGER NOT NULL,       -- last level alerted or cleared: 0 below 70 %, 1, 2, 3, 4 exceeded
  notified_at TEXT NOT NULL
);
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

### Subscription filter

The `filter` JSON is a `SubscriptionFilter` (`src/core/types.ts`). Every key is
optional and an absent or empty list imposes no restriction. The keys are ANDed:
an event is delivered only if it passes every one that is set.

| Key | Effect |
|---|---|
| `sources` | Restrict to these source ids (`store:community`). |
| `kinds` | `new`, `update`, or both. |
| `packages` | Allowlist. Only packages that match an entry are delivered. |
| `excludePackages` | Denylist. Packages that match an entry are never delivered. Wins over every other key, including `packages` and `watchlist`. |
| `allowNsfw` | NSFW is excluded unless this is exactly `true`. |
| `includeCategories`, `excludeCategories` | Category restriction, case-insensitive. |
| `watchlist` | Highlight only: a hit is shown in detail in a digest. Never restricts delivery. |
| `dedupAcrossStores` | Collapse the same release seen on several stores (default `true`). Evaluated per subscription against the events that subscription's own filter accepts. |
| `includeChangelog` | `false` never renders the Changelog block for this subscription's messages, regardless of excerpt length (default `true`). A rendering setting, not a matching rule: the changelog is still fetched (subject to the usual caps) for any other subscription that wants it. |

Deprecated packages are never reported as `update` events.

Package entries (`packages`, `excludePackages`, `watchlist`) share one rule: an
entry matches when, compared case-insensitively and exactly (no partial match),
it equals the package id, the `Owner-Name` pair, or the bare owner name.

Enforcement points:

- Fan-out: `compileFilter` builds the lookup sets once per subscription per tick.
  A check is O(1) per set (package keys are lowercased once per package and
  reused across subscriptions, categories are O(categories of the package)), so the
  fan-out costs O(events x subscriptions) cheap checks. Measured on Node:
  about 40 to 70 ns per event x subscription pair at 10 and 50 subscriptions
  with `packages`, `excludePackages` and `includeCategories` set (about 250 ns when only
  one subscription pays for the per-package lowercasing).
- Delivery: due rows are re-checked against the subscription's current filter
  (see "Progressive delivery" below), so a filter change, `disable` or `remove`
  takes effect for rows already queued.
- Reading: the stores narrow the stored JSON with `parseFilter`
  (`src/core/filter.ts`). A wrong type in any known key makes the subscription be
  skipped, never treated as an open filter. Unknown keys are dropped.
- Writing: `scripts/validate-config.ts` (`validateSubscription`,
  `validateSubscriptionFilter`) rejects unknown keys and malformed values before
  any SQL is printed. Subscription ids match `^[A-Za-z0-9_-]{1,64}$`.

### Managing subscriptions

Each subscription is one row, so several channels with independent filters are
several rows. Two scripts print (never execute) the `pnpm run wrangler d1
execute` commands:

- `pnpm add-subscription`: a plain `INSERT`, so a duplicate `--id` fails on the
  primary key instead of replacing a row. The filter comes from repeatable flags
  (`--source`, `--kind`, `--package`, `--exclude-package`, `--category`,
  `--exclude-category`, `--allow-nsfw`) or from raw JSON (`--filter`,
  `--filter-file`), never both.
- `pnpm subscriptions <list|disable|enable|remove|set-filter>`. `list` selects
  `id, guild_id, mode, filter, enabled, thread_id` and the webhook id only; the
  webhook token is never selected, and a URL of an unexpected shape prints
  `(unrecognised)`.
  `remove` deletes the subscription row first, then its undelivered outbox rows
  (delivered rows age out through the normal purge). `set-filter` replaces the whole
  filter and refuses to run without a filter flag.

`subscriptions.thread_id`, set by `--thread-id` on `pnpm add-subscription`,
delivers into an existing forum post or channel thread instead of the
webhook's parent channel — a documented Discord webhook-execute parameter,
applied by `DiscordSender.send` (`src/cloudflare/discord-sender.ts`) as a
`thread_id` query parameter at send time. This project never creates a
thread; pointing a subscription at one that was deleted just fails delivery
like any other bad destination.

It is a column of its own, not folded into `webhook_url`: several
subscriptions can share one real Discord webhook while targeting different
threads, and `drain.ts`'s per-webhook rate limiting and retry/starvation
grouping (`perWebhook`, `blocked`) key on `webhook_url` alone, which only
stays correct if that string never varies by destination.

`schema.sql` creates a fresh database and does not alter existing tables. A change
to an existing table ships as a numbered file in `migrations/`, applied once
(`0001_outbox_delivered_at.sql` adds `outbox.delivered_at` and its indexes,
`0002_package_download_url_and_downloads.sql` adds `packages.download_url` and `packages.downloads`,
`0003_package_likes_and_website.sql` adds `packages.likes` and `packages.website_url`); a test
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
| D1 rows written | 100,000/day | ~9,000 | 9 % |
| D1 rows read | 5,000,000/day | ~220,000 | 4 % |
| Cron triggers | 5/account | 2 | 40 % |
| External subrequests | 50/invocation | ≤ 48, enforced | — |

D1 figures are measured on the live database (2026-10-02, extrapolated to a full UTC day; the D1
dashboard and `pnpm run wrangler d1 insights <database name>`). About 83 % of the reads are one query,
the Hexium known-versions read behind each index scan.

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

The changelog fetch is the per-event **details phase**: the adapter's `fetchChangelog` returns the
excerpt, its URL and, when the package has no website yet, the package website. Thunderstore needs
a second request for the website (its listing and `/versions/` carry none; Hexium's lookup already
did), so an adapter declares `detailRequests` (2 for Thunderstore, else 1) and the tick selects, in
order, at most `TICK_BUDGET.maxChangelogFetches` (12) events whose declared requests all fit in
`remaining - SUBREQUEST_SEND_RESERVE`; the rest render without details and are not retried. A
result with an excerpt, a URL or a website is stored with one `Store.setEventDetails` call (event
columns, and the package's `website_url` when found). Arithmetic: with polls P, details D and sends S,
S <= 24 (reserved), D <= min(12 x 2, 48 - P - 24), so P + D + S <= 48 for every P; the cap of 12
events at the worst cost of 2 requests is exactly the 24 requests above the reserve
(`MAX_DETAIL_REQUESTS_PER_EVENT` in `src/core/constants.ts`; `src/core/subrequest-budget.test.ts`
checks the bound and that no selected event is served half). A request the budget still refuses
(the wrapped `fetch` floor) leaves that event without the website, never without its changelog,
because the changelog request goes first. Each job runs its two requests one after the other, so the
six-connection cap holds.

## Digest rendering

At this volume, one message per mod is unusable: 800 notifications a day is one
every two minutes. Default output is therefore a digest.

- New packages: full embeds with icon and description. There are only tens per
  day and they deserve the space. Never a changelog: a first release has no
  prior version to change from.
- Updates: a compact list, one embed per store with its own colour and a heading
  line carrying the store and the count.
- Digest interval per subscription, default 30 minutes.
- Changelog excerpts only for updates shown in detail: watchlist hits and every
  update delivered to an `immediate` subscription (see "Detailed events and
  changelogs").

### Message layout

Every text is untrusted upstream data: names, owners, versions and descriptions
go through the escaping and mention-neutralising in `src/render/text.ts`; URLs are
validated http(s) and percent-encoded; `allowed_mentions.parse` is always `[]`.
Every user-visible string of the renderer comes from a catalog in `src/i18n` (see
"Localisation"); the wording below is the English catalog.

**Header block** (shared by both message kinds). One block of Markdown:

```
## {store emoji }[Name](package url)                h2 link, no version; without a store emoji just the linked name
⬆️ Updated by Owner · 1.2.2 → 1.2.3 · <t:UNIX:R>    🆕 New by Owner · 1.0.0 · <t:UNIX:R> for new packages
ℹ️ 94.2 MB · Downloaded 12,345 times · 21 likes     each part only when known; a new package never shows a download
                                                     count (it is always zero); the line is omitted when none is left
Also on [Hexium](url)                               only when the release exists on other stores
(blank line)
description excerpt                                 only when there is one, at most 350 characters
```

The `description` catalog message and `SECTION_EMOJI.description` stay defined (for future
template customisation) even though no heading is rendered from them today.

- The kind emoji are `KIND_EMOJI` in `src/render/layout.ts` (update: U+2B06 U+FE0F);
  the label emoji are `SECTION_EMOJI`. Owner is plain escaped text; a missing owner
  drops "by Owner" (`Updated`), a missing timestamp drops its part of the line. An
  update without an earlier version shows only the new one. Without a usable package
  URL the title is not a link.
- `<t:UNIX:R>` is a Discord relative timestamp (viewer-local; hovering shows the
  full local time). It uses `pkg.updatedAt`, then the event's `createdAt`, then the
  render time; the style letter is `DISCORD.timestampStyleRelative`.
- Downloads are shown from zero up; likes only above zero; both must be non-negative
  safe numbers (the whole part is shown), else the part is omitted. Numbers are grouped
  by a small manual function using the catalog's separator; sizes use the catalog's
  units and decimal separator.
- `Changelog`: the excerpt from the changelog module (final Markdown), re-fitted to
  `CHANGELOG_DISPLAY_MAX` (500) characters in total: cut on a line boundary, else at a
  word boundary, never inside a link, ending with `…` and one `[Full changelog](url)`
  link in the catalog language that stays inside the budget (`finalizeExcerpt`). A link
  in the body labelled like that link is degraded to plain text, so the trailing link
  stays unique. Only shown when there is an excerpt.
- `🗂️ Categories`: escaped names, at most 8 entries of at most 32 characters and 200
  characters in total, a cut list ends with `…`, omitted when empty.

**Immediate message** (`renderImmediate`, one event). A Discord Components V2
message: `{ flags: 32768, allowed_mentions: { parse: [] }, components: [Container] }`
with no `content` and no `embeds` (Discord rejects them next to the V2 flag). The
container (type 17) has `accent_color` = the store colour and holds, separated by
dividers (type 14):

1. the header block, in a Section (type 9) whose accessory is a Thumbnail (type 11,
   the package icon) when the icon URL is a usable http(s) URL without credentials,
   else in a plain TextDisplay (type 10);
2. `**Changelog**` and the excerpt, in a TextDisplay, only when there is one;
3. `**🗂️ Categories**` and the list, in a TextDisplay, only when non-empty;
4. an action row (type 1) of link buttons (type 2, style 5), only when at least one is
   valid (an empty action row is not a valid component, so the row is left out entirely
   when it would be): `Mod page` (`pkg.url`; emoji = the store's custom emoji, else a
   Unicode fallback per store), `Download` (`pkg.downloadUrl`, U+2B07 U+FE0F), `Website`
   (`pkg.websiteUrl`, placed right after Download). Only http(s) URLs without credentials,
   at most 512 characters, whose host Discord accepts are kept (label at most 80, at most
   5 buttons); an invalid URL drops its button. Discord answers 400 for a host without a
   real top-level domain (`https://mysite`, `https://a.b`), so `hasDeliverableHost`
   (`src/text/url.ts`) admits only an IPv4 literal or a dotted name of `[a-z0-9-]` labels
   ending in a letters-only label of two or more letters or an `xn--` label; the Website
   URL is filtered by the same rule before it is stored. A custom emoji becomes
   `{ id, name, animated }`; a Unicode one `{ name }` only when it is a pictographic emoji
   (a non-emoji symbol makes Discord answer 400). If Discord answers an immediate message
   with 400 anyway, the drain renders it once more with only the mod page button
   (`optionalButtons: false`) and resends it; the run report counts that as `degraded`,
   and when the resend fails too the row is parked;
5. outside the container, as a second top-level component (a Text Display is itself a
   top-level content component, so it needs no container of its own): a trailing subtext
   line, `-# <emoji> [ratatoskr v<version>](repo url)`, built by `sourceSubtext` in
   `src/render/layout.ts` from `PROJECT` and the emoji from `RATATOSKR_EMOJI` or a
   squirrel fallback. This is the AGPL notice; it is always present, whatever else in the
   message is missing or invalid, and it is not part of the action row (which the 400-retry
   above can drop).

Discord limits for a V2 message (`DISCORD.componentsV2*`): 40 components in total (nested
ones count), 4000 characters of text across all text displays. The renderer's caps
(description 350, changelog 500, categories 200, also-on 300, title parts capped
individually) keep the worst case near 2200 characters, and a property test with hostile
input asserts both limits and the 6000/4000 sums. Non-application webhooks may send
components only when the request has `?with_components=true`, which `DiscordSender` adds
when the payload has components; the URL is never logged.

**Detailed embed** (digest: new packages and watchlist hits). A classic embed with the
header block as its description (so the h2 link title is its first line), the mod icon
as `thumbnail`, the store colour bar, and no `title`, `url`, `timestamp` or footer. Its
fields are `Changelog` (full width, only when there is one) and `🗂️ Categories`, then
the project field (below): an embed holds at most three fields, so the 25-field and
1024-character value limits cannot be hit.

**Compact list embed** (digest updates). The first description line is the
heading `{emoji }**Thunderstore** · 37 updates` (the count of that embed, with the
localised plural; a store split over several embeds gets one heading each), followed by
one line per mod. Footers cannot render custom emoji or links, so list embeds have no
footer of their own.

**Project link** (AGPL notice in digests, which cannot carry buttons). The last field of the
last embed of every digest message is non-inline, named with a zero-width space (Discord
requires a non-empty name) and valued `-# [ratatoskr v1.0.2](https://github.com/odin-sons/ratatoskr)`,
built from `PROJECT` (`PROJECT_FIELD` in `src/render/layout.ts`). It is not part of any
description. A digest that spans several messages numbers them: the footer of the last embed
of each message is only the localised `(i/n)` (`Messages.page`), and no other embed has a
footer. The packer reserves room for the field and the footer up front (`TEXT_BUDGET`,
`PAGE_SUFFIX_RESERVE`, whose fit for every catalog a test asserts), so the line can never be
dropped or push a message beyond 6000 characters. Tests assert that every digest message
ends with it, including pathological digests, in every language. Immediate messages have no
project field; their trailing source subtext (see the action-row paragraph above) carries
the same notice instead.

**Store emoji.** The optional Worker setting `STORE_EMOJIS` (an object or JSON
string keyed by store) holds full custom emoji markup, validated with
`^<a?:[A-Za-z0-9_]{2,32}:[0-9]{17,20}>$`. It is parsed once per invocation
(`parseStoreEmojis`; invalid entries are ignored with one warning naming only the
keys), carried in `TickDeps`/`DrainDeps` to every render call, and re-validated by
the renderer. It appears in the title of detailed messages, on the `Mod page` button and
in compact list headings; a store without an entry shows no emoji in the title and a
Unicode fallback on the button. `RATATOSKR_EMOJI` (a string, same validation, invalid
value ignored with one warning naming only the key) is the emoji of the trailing source
subtext line.

**Localisation.** `src/i18n` holds a typed catalog per language (`en.ts`, `ru.ts`); the
`Messages` interface makes a missing key a compile error. Plural forms come from small
hand-written rules per language (`plural.ts`, no `Intl`): English one/other, Russian
one/few/many/other. The Worker setting `LANGUAGE` (default `en`; an unknown value falls
back to `en` with one warning naming only the key) is parsed once per invocation
(`parseLanguage`), carried in `TickDeps`/`DrainDeps` to every render call as
`RenderOptions.locale` and resolved by `getMessages`. Log lines, adapter warnings and the run
report stay English.

### Detailed events and changelogs

The details phase still runs for every new package too (a source's package
listing often carries its website only there), but a new package's changelog
is never kept: it has no prior version to change from, so the render layer
drops it unconditionally (`kind: 'new'` short-circuits `changelogExcerpt`)
regardless of what a source returned. An update's changelog is fetched and
kept when at least one subscription receiving it shows it in detail: it is a
watchlist hit of a digest subscription, or the subscription is `immediate`
(every immediate message is a detailed message). The per-tick caps are
unchanged: at most `maxChangelogFetches` fetches, always leaving the send
reserve of the shared subrequest budget unspent; the remainder is rendered
without a changelog and counted in `changelogSkipped`. Many mods ship no
`CHANGELOG.md`; their field is simply
omitted.

At render time, a digest details at most `MAX_DETAILED_PER_DIGEST` (50)
watchlist hits and immediate-mode updates in one call, oldest first; a
backlog beyond that still gets a compact list entry, never dropped or
parked (`cappedDetailed` in `src/core/drain.ts`). A new package is never
counted against this cap, since it never carries a changelog and stays
cheap however many are backlogged. This bounds the cost of one digest
render to a small, fixed amount regardless of how large the backlog grows.

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
  An immediate row whose render throws is parked directly. An immediate row that Discord rejects with 400 is first resent once without its Download and Website buttons (one log line, no URLs; `degraded` in the run report). A package row with corrupt
  `categories` JSON is read with no categories rather than failing the whole `takeDue`.

Cost per digest:
O(rows) plus at most `1 + 3 + log2(n)` renders, each smaller than the last;
measured (Node, 400 events, real renderer) about 1.5 ms for 50 detailed events,
4.4 ms for 400 compact updates in one message and 4.6 ms for a mixed 20 % new
backlog (two renders, 250 then 177 entries). `MAX_DETAILED_PER_DIGEST` now
makes "50 detailed events" the actual worst case for one render, not just an
example: however large the backlog, at most 50 of its watchlist hits and
immediate-mode updates are ever detailed at once (see "Detailed events and
changelogs").

### Discord limits

Every number here is an external constraint. Put them in one constants module
with this file cited. Message components (link buttons): at most 5 action rows and
5 buttons per row, label at most 80 characters, URL at most 512 characters.
Components V2 messages (flag 32768, immediate mode): 40 components in total including
nested ones, 4000 characters of text across all text displays, no `content` and no
`embeds`.

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

Draft — implemented in `src/render`. Each list embed opens with its store heading
line and the message ends with the project field (see "Message layout"); the ladder
counts only the item lines:

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
link to the full changelog. The stored excerpt is re-fitted to 500 characters
(`CHANGELOG_DISPLAY_MAX`) when a message is rendered; see "Message layout".

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
- Cron invocations must not overlap: the reconcile cron is off the tick grid.

### Run report

Each scheduled run logs exactly one JSON line (`event: "run"`): cron, per-source
`status`/`events`/`error`, `sent`, `failed`, `deferred` (work that runs later:
sources not polled, outbox rows not attempted), `parked`, `degraded` (immediate
messages delivered only after a resend without optional buttons), `filtered` (rows
dropped at delivery because the filter changed), `purged`, `changelogFetches`,
`changelogSkipped` (dropped, never retried), `alerts` (limit alerts sent), `alertsFailed`,
`subrequests` and `elapsedMs`.
Error texts are one line, capped at 200 characters, with any `scheme://` URL (any case)
and any `.../webhooks/...` path (with or without a scheme) replaced by `[url]`; every
logged error text goes through this filter. Webhook URLs and secrets are never logged.

### Limit alerts

Some internal limits switch a feature off without failing anything. The Hexium package
index is the case that started this: past `HEXIUM_INDEX_MAX_LINES` (3,500 lines),
`HEXIUM_INDEX_MAX_BYTES` (1,792,000 bytes) or `HEXIUM_INDEX_MAX_ITERATIONS` (7,000 visited
lines, blank ones included) the scan is refused, and updates of packages the store already
knows stop being detected while new packages still are. Before alerts, the only trace was a
warning in the run log.

An adapter reports each limit it measured as a `CapUsage` (limit, observed value, whether it
was exceeded, what stops working, the name of the constant) on a successful poll. The Hexium
adapter reports the line, byte and visited-line usage on every index scan, and an exceeded limit, with the
cap that fired, when the scan is refused; the visited-line cap is reported too. Alerts come
from index scans of a bootstrapped source; an index already over a cap during the cold-start
seed or a reconcile run only logs a warning. The byte share is measured on the decoded text,
so it is a close approximation of the bytes. After every source has been polled and committed,
and before changelogs and delivery, each tick:

- a limit is at level 1, 2 or 3 from 70 %, 85 % and 95 % of its value (`CAP_ALERT_THRESHOLDS`)
  and at level 4 when exceeded;
- an alert goes to the alert channel when a limit reaches a higher level than the one stored
  in `alert_state`, and again every 24 hours (`CAP_ALERT_REPEAT_MS`) while it stays exceeded;
- a lower level is stored without an alert, so crossing the threshold again alerts again;
- the alert names the source, the limit, the numbers, the consequence and the constant, and
  costs one subrequest from the tick's budget;
- a refused send stores nothing, so the next tick retries; a missing `ALERT_WEBHOOK_URL`
  sends and stores nothing and logs `alert due but ALERT_WEBHOOK_URL is not set`.

The alert channel is the webhook in the Worker secret `ALERT_WEBHOOK_URL`, separate from every
subscription. The state is read with one query per tick that reported a limit (every third
tick for Hexium) and written only when a level changes. If the table is missing or D1
fails, the tick logs `limit alerts failed` and carries on with polling and delivery. Alert
text is English; it is addressed to the operator, not to the channel's readers.

## Configuration

No inbound endpoint means no slash commands. Configuration is `wrangler secret`
and `wrangler d1 execute`. Accepted trade-off for a zero-surface deployment.

Optional deploy-time names `WORKER_NAME` and `D1_DATABASE_NAME` (default `ratatoskr`)
let several instances share one Cloudflare account; `scripts/wrangler-config.ts` writes them into the
throwaway config next to the real `database_id`. Optional Worker secret `ALERT_WEBHOOK_URL` (see "Limit alerts"). Optional Worker variable `STORE_EMOJIS` (object or JSON string, keyed by store) sets
custom store emoji, `RATATOSKR_EMOJI` (string) the emoji of the trailing source subtext and
`LANGUAGE` (`en` default, `ru`) the message language; see "Message layout". Real ids
belong in the operator's git-ignored `.env`, never in the repository:
`wrangler.jsonc` commits a placeholder `database_id`, and `scripts/wrangler-config.ts`
substitutes the real one (from `D1_DATABASE_ID`) into a throwaway copy next to it at
deploy time, deleted right after. `pnpm run deploy` reads `STORE_EMOJI_*`, `RATATOSKR_EMOJI`
and `RATATOSKR_LANGUAGE` (not `LANGUAGE`, the POSIX locale variable) from `.env`, validates
them (a bad value stops the deploy and is never echoed) and passes them as `--var`
(`LANGUAGE:xx` for the language).

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

### Watch list

Time-bound risks and limits nobody has measured yet. Re-measure before trusting a
number here, and update its date when you do.

1. **Hexium index cap (3500 lines).** 1490 lines on 2026-10-02 (1318 on 2026-09-26,
   1113 on 2026-09-20), growing 29 to 34 per day, so the cap is reached between
   2026-11-30 and 2026-12-11. Past it the index scan is skipped: updates to Hexium
   packages the store already knows stop being detected (new packages still are). The
   bot alerts in the alert channel at 70 %, 85 % and 95 % of the line and byte caps and
   daily once a cap is exceeded (see "Limit alerts"; the thresholds fall around 2026-11-02,
   2026-11-18 and 2026-11-29). Decide before mid-November 2026: ask
   Hexium for a server-side sorted or filtered listing, build an incremental scan, or
   raise the cap with a fresh CPU measurement (4000 lines was rejected at 4.8 ms, see
   `docs/api-notes.md`). Re-measure with the line count of
   `https://valheim.hexium.gg/api/experimental/package-index/` or
   `SELECT COUNT(*) FROM packages WHERE source = 'hexium:valheim'`.
2. **D1 free-tier limits** (5M rows read and 100k rows written per day; exceeding
   them errors until 00:00 UTC). Measured on 2026-10-02 with the D1 dashboard and
   `wrangler d1 insights`, 20.75 hours into the UTC day: 191.65k rows read and 8.16k
   rows written, about 220k (4.4 %) and 9.4k (9.4 %) for the full day. One query
   makes up 83 % of the reads: `SELECT package_id, latest_version FROM packages WHERE
   source = ?`, the Hexium known-versions read, 107 runs of about 1,490 rows. At the
   3,500-line cap it reads 346,500 rows a day (6.9 %). Writes are mostly outbox and
   event inserts plus a source-state upsert on every tick (865 a day; PR #5 cuts it).
   The Hexium lookup fix in PR #1 adds a known-versions read of at most 20 ids on each
   of the roughly 192 non-scan ticks (about 4k rows a day); re-check the analytics
   once it ships, and after any change that adds a per-tick scan of a growing table.
3. **A parked outbox row is never retried.** A non-retryable Discord answer parks it
   for good. On 2026-10-01 the first send to a freshly created forum thread was parked
   this way (cause not established); the same message sent by hand minutes later was
   accepted. After adding a subscription, check
   `SELECT COUNT(*) FROM outbox WHERE parked = 1` and re-queue what was lost.
