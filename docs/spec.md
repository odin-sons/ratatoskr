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
  getCursor(source: SourceId): Promise<Cursor | null>;
  commit(events: ModEvent[], cursor: Cursor): Promise<void>;
  takeOutbox(limit: number): Promise<OutboxRow[]>;
  markDelivered(ids: string[]): Promise<void>;
}

interface Sender {
  send(webhookUrl: string, payload: DiscordMessage): Promise<SendResult>;
}
```

Cloudflare adapter: D1 + `fetch`. A Node adapter (SQLite) and a Vercel adapter
should require no changes to the core.

## Sources

Per game, per store. Game is configuration, not code. Cost is linear in
enabled sources: one listing fetch per source per tick.

| Source | Per-tick listing | Covers new | Covers updates |
|---|---|---|---|
| Thunderstore | `cyberstorm/listing?ordering=last-updated` | yes | yes |
| Hexium | `frontend/packages` (creation order) | yes | **no** |
| Nexus | `mods/updated.json?period=1d` | via `latest_added` | yes |

Hexium has no sorted-by-update listing and will not get one soon — the
undocumented sort parameters were tested and are ignored. So Hexium runs on a
**split cadence**:

- every tick: `frontend/packages?page=1` — 20 items, cheap, authoritative for
  new packages
- every 3rd tick (~15 min): `package-index` NDJSON scan — the only way to see
  updates to existing packages

Updates on Hexium therefore arrive with up to 15 minutes of latency. That is
acceptable for a digest that fires every 30 minutes anyway, and it cuts index
traffic from 288 to 96 fetches a day. Send `If-None-Match` — if Hexium honours
it, most of those cost nothing at all.

Do not raise the index cadence to every tick without measuring: ~1000 lines of
NDJSON is on the order of several hundred kilobytes, and 288 pulls a day of it
is a noticeable amount of someone else's bandwidth for no latency gain that
survives the digest interval.

### Reconciliation

Once a day, walk the full `package-index` for each store that offers one,
compare against D1 and emit anything missed. This covers the two real gaps:
cron triggers have no retries, so a failed tick is simply skipped; and a burst
larger than one listing page slips past a page-1 poller.

Reconciliation is a separate cron at a different hour, and it is subject to the
same per-tick budget — process one store per run.

### Cold start

First run per source seeds state and emits nothing. A `bootstrapped` flag per
source. Without it the first tick fires a thousand notifications.

### What counts as an update

Trigger on a change of `version_number`, never on a timestamp moving.
Timestamps shift when a description is edited, a category changes or a rating
lands. A version change is unambiguous.

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
CREATE INDEX idx_events_created ON events (created_at);

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
  UNIQUE (subscription_id, event_id)   -- idempotency
);
CREATE INDEX idx_outbox_due ON outbox (next_attempt_at);
```

The `UNIQUE (subscription_id, event_id)` constraint is what makes a re-run
after a crash safe.

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
| External subrequests | 50/invocation | ≤ 21 | — |

Quotas are not the constraint. CPU time and Discord readability are.

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
- Outbox rows exceeding an attempt ceiling get parked, not silently dropped.

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

1. ~~Sorted listing on Hexium~~ — resolved, negative. The undocumented sort
   parameters are ignored. Hexium runs on the split cadence above.
   Size, encoding and `ETag` support of `package-index` still need measuring
   before the cadence is final.
2. Does Thunderstore's cyberstorm listing currently return
   `latest_version_number`? If not, one extra request per changed package.
3. Exact line shape of `/api/experimental/package-index/` on Hexium, and
   whether Thunderstore exposes the same endpoint.
4. Does either store honour `If-None-Match` on the listing endpoints?
5. Final degradation ladder formats.
6. Measured CPU per tick — needs a real deployment to confirm the 10 ms budget
   holds with NDJSON scanning.
