# Upstream API notes

Every entry is marked with how it was established:

- **[live]** — called and inspected by hand
- **[source]** — read from the vendor's own client code or OpenAPI spec
- **[assumed]** — inferred, not yet confirmed. Verify before relying on it.

Thunderstore and Hexium share a common ancestry: Hexium is an API-compatible
fork. Their `/api/experimental/` surfaces match. Their listing surfaces do not.

---

## Thunderstore

Base: `https://thunderstore.io`

### Listing (per tick)

**[source]** From `thunderstore-ui/packages/thunderstore-api`:

```
GET /api/cyberstorm/listing/{community}/?ordering=last-updated&page=1
```

`ordering` accepts `newest`, `most-downloaded`, `top-rated`, `last-updated`.
Other query params: `q`, `section`, `included_categories`,
`excluded_categories`, `nsfw`, `deprecated`.

Item fields **[source]**: `namespace`, `name`, `description`, `icon_url`,
`categories[]`, `last_updated`, `download_count`, `rating_count`, `size`,
`is_deprecated`, `is_nsfw`, `is_pinned`, `community_identifier`.

`latest_version_number`, `install_url`, `download_url` are marked optional in
their schema. **[live]** (2026-09) the listing does **not** return the version
number; `categories` are objects (`{id, name, slug}`), and the default query is
`nsfw=False&deprecated=False`, so NSFW and deprecated packages never appear.
Pinned packages sit at the head with an old `last_updated`. Resolve the version
with:

```
GET /api/cyberstorm/package/{namespace}/{name}/versions/
```

one request per changed package, capped per tick. **[live]** The response is an
array of `{version_number, datetime_created, download_url, ...}` in no
guaranteed order — take the maximum `datetime_created` as the version and the
second-largest as `previousVersion` (null when the package has a single version).
The body is refused above 512 KB (`VERSIONS_MAX_BYTES`, about 2300 versions),
checked while streaming and before `JSON.parse`; the package is then skipped like a
404 (the cursor moves past it) and one line naming the package id is logged.
Measured cold, parse plus scan: ~1 ms at 512 KB, ~12 ms at 25,000 versions (5.3 MB).

**[live]** (2026-09-20) The adapter sends `nsfw=false&deprecated=false`
explicitly instead of relying on the server default; both forms returned
the same status and size (15,016 bytes). Flags are still checked per item and fail
closed: `is_nsfw` counts as safe only when it is the boolean `false`, so a
missing, null or non-boolean flag marks the package NSFW. `is_deprecated` is
`true` only when it is the boolean `true`.

Backlog: when more than one listing page (20 items) of updates is pending, the
adapter reads the pending items from the bottom of the backlog so that the
oldest are handled first and the cursor never passes an unseen update. While
this lasts the cursor is `<iso>@<page>`, where `<page>` is the listing page the
next poll resumes at; a plain timestamp (and a missing or stale page) is
accepted and means "start at page 2". Each poll reads at most
`thunderstoreListingPages` (3) listing pages.

**[live]** Conditional requests: no `ETag`, but `Last-Modified` is sent and
`If-Modified-Since` returns a real 304. `Cache-Control: public, max-age=60`.
The adapter stores the validator in the `etag` slot as `lm:<Last-Modified>`.

This is not in the public Swagger; r2modman calls parts of the cyberstorm API
undocumented. It is what the production site runs on, but treat breakage as a
realistic risk and fail soft.

### Changelog, per version

**[live]** Both work. Prefer the first — Markdown goes into Discord almost
unchanged, HTML would need conversion.

```
GET /api/experimental/package/{namespace}/{name}/{version}/changelog/
→ { "markdown": string | null }

GET /api/cyberstorm/package/{namespace}/{name}/v/{version}/changelog/
→ { "html": string }
```

`/readme/` exists in both shapes. This is the endpoint Gale uses.

Returns the whole `CHANGELOG.md` as shipped in that version's archive, not a
diff. Extraction strategy in `docs/spec.md`.

Changelog responses are refused above 128 KB (`CHANGELOG_MAX_BYTES` in
`src/sources/budget.ts`, checked while streaming and before any `JSON.parse`),
and the extractor looks at no more than the first 128 K characters of the
markdown and at most 4096 heading or fence lines. The excerpt it returns is
final Discord Markdown: HTML stripped, mentions neutralised, only http(s)
`[text](url)` links kept, and a single trailing `[Full changelog](url)` link
inside the character budget. Discord's own Markdown parser differs from
CommonMark (a code block closes at the first following fence, inline code spans
lines, there are no `~~~` fences), so the excerpt models no code at all: every
backtick and `<` is escaped, the colon of `]:` is escaped, and every `](` outside
a kept http(s) link is escaped, so no code span, fence, autolink, reference
definition or other link target can form. A fence in the changelog therefore
shows as escaped text; fences still count when the extractor looks for the
section of a version. Numeric entities that decode to bidi, zero-width, filler,
variation-selector, tag or control characters are dropped during entity decoding,
as are the raw characters. Link targets carry `%40` instead of `@` where they
spell `@everyone` or `@here`. The renderer inserts the excerpt with only invisible
character stripping, mention neutralising and a length cap.

### Full catalogue

**[source]** `GET /c/{community}/api/v1/package-listing-index/` → gzipped JSON
array of chunk URLs; each chunk is gzipped JSON of packages with
`date_created`, `date_updated`, `versions[]`. Full dump, not incremental.

**[source]** `GET /c/{community}/api/v1/package/` — everything in one response.
Thunderstore themselves recommend against it for large communities; it has hit
response size limits for e.g. `riskofrain2`. Do not use from a Worker.

**[live]** `/api/experimental/package-index/` 302-redirects to an 83 MB gzipped
JSON covering every game; the per-community
`/c/{community}/api/v1/package-listing-index/` is 13 chunks of ~1.3 MB gzip
(~14 MB raw) each. Neither is workable from a Worker, so Thunderstore has no
reconciliation.

---

## Hexium

Base: `https://{game}.hexium.gg` for the listing, dump, index, package detail and
changelog. `hexium.gg` also serves changelogs but cannot resolve
`frontend/p/...` (404). Gale uses the bare host for `/api/experimental/package/...`.

### Cyberstorm

**[live]** `/api/cyberstorm/listing/{community}/` → **404**. Only
`/api/cyberstorm/community/{community_id}/` exists. The fork took cyberstorm
partially.

### Listing

**[live]** `GET /api/experimental/frontend/packages/?page=N`

20 items per page. Response: `{ bg_image_src, categories[], community_name,
has_more_pages, packages[] }`.

Item fields, exact **[live]**:

```
name, full_name, owner, package_url, version_number, date_updated,
rating_score, download_count, is_pinned, is_deprecated, has_nsfw_content,
categories[], icon_url, description, uuid4
```

Note this **does** carry `version_number` and `date_updated` — no second
request needed to diff.

**Critical: the default order is package creation descending, not last
updated.** Established two ways: the embedded sequential id in `uuid4`
(`00000547-…-000000000547`) decreases monotonically down the page, and the
first twelve items match the website's `?sort=newest` exactly while
`?sort=updated` produces a completely different head. A package updated at
23:34 sat in position 14 while one updated at 16:48 sat in position 11.

So this endpoint catches **new packages** reliably and **misses updates to
existing packages**.

**[live]** `?sort=updated` and `?ordering=last-updated` were both tried on this
endpoint. Both return exactly the same payload as no parameter at all — they are
ignored, not honoured. Do not retry this.

The website does serve `?sort=updated`, so the backend supports the ordering; it
is simply not exposed on the API. Worth asking Hexium to expose it — a one-line
change on their side that would remove the need for dump polling entirely.
Until then, updates to existing Hexium packages come from the `/api/v1/package/` dump.

### Full dump: `/api/v1/package/` — the update source

**[live]** `GET /api/v1/package/` on `{game}.hexium.gg` returns one compact JSON
array with a record per package. Valheim, 2026-09-20: 1113 records, 4,461,836
bytes raw (4,461,314 characters), ~425 KB gzip (`content-encoding: gzip`,
chunked), **no `ETag` or `Last-Modified`**. The largest record is 173,566
characters; 377 packages have a single version and the most versions on one
package is 41.

Record keys: `name, full_name, owner, package_url, donation_link, date_created,
date_updated, uuid4, rating_score, is_pinned, is_deprecated, has_nsfw_content,
categories[], versions[]`. `versions[]` items: `name, full_name, description,
icon, version_number, dependencies, suggestions, download_url, downloads,
date_created, website_url, is_active, uuid4, file_size`.

- Records are separated by `}]},{"name":"` (the last version object closes, the
  array closes, the record closes; `"versions":[]},{"name":"` for a record with
  no versions) and version items by `},{"name":"`; neither sequence can occur
  inside a JSON string (a quote there is escaped). A version item that itself ends
  with an array (`...]},{"name":"`) is not a record boundary. The scanner cuts the
  body at the record separator and only ever searches inside one record or one
  version item, so every search is bounded by the record and the total cost is
  linear in the body size. A region that does not end with the record close is
  unreadable and quarantined, and so is a region holding a second `date_updated`
  marker (the separators were lost); the second-marker check runs on every full
  extraction and, in lean mode, on records over 16 KiB. There is no per-record size
  limit: a real record with hundreds of versions is about 4.2 KB per version, and
  the body as a whole is bounded by `MAX_SCAN_BYTES`.
- `"date_updated":"` occurs exactly once per record, in the header before
  `versions[]`. The first eight hex digits of `uuid4` are only sometimes a
  sequential creation id (410 of 1113 real records); slicing by them modulo the
  slice count is still stable, because the value is a fixed property of the record.
- `versions[]` is not reliably ordered: 27 of 1113 records list a version out
  of `date_created` order (one was oldest-first with `date_updated` older than
  its newest version). The adapter reads every version item of a fully
  extracted record and takes the newest and second-newest by `date_created`
  (`version` and `previousVersion`; null when there is one version). Lean
  extraction (seeding, unchanged reconciliation) takes the first listed version
  and leaves `previousVersion` unknown. Semver order is not usable: 89 records
  list a lower version number after a higher one. `is_active` was true
  everywhere.
- `has_nsfw_content` and `is_deprecated` are present and boolean (0 NSFW, 48
  deprecated in Valheim), as are description, icon, categories and `file_size`.
  A record whose `has_nsfw_content` is not the literal `true` or `false` is
  unreadable and is never emitted (fail closed); so is a record whose
  `is_deprecated` is missing or not a boolean. The listing item flag is treated the same way:
  anything but the boolean `false` marks the package NSFW.
- Unreadable records (no `versions[]`, no readable version, bad flag, missing or
  invalid `date_updated`) are quarantined: skipped, counted, and reported in a
  single count-only log line per poll. Seeding and the steady-state cursor keep
  advancing. The poll is skipped (listing fallback, cursor held) when no record
  at all could be read, when the first 8 records all fail, or when no record
  is recognised.
- `date_updated` must be a canonical `YYYY-MM-DDTHH:MM:SS.ffffffZ` stamp with
  in-range fields, otherwise the record is unreadable. The cursor is
  `max(previous cursor, newest stamp)` and stamps more than one hour
  (`CURSOR_FUTURE_SLACK_MS`) after the poll time never raise it, so a bad or
  far-future record cannot freeze or poison it. The seed marker
  (`seed:<slice>:<iso>`) is validated the same way. A stored cursor (or seed
  marker) that is already more than that hour ahead of the poll time, written by an
  older version, is cut back to the poll time when read; the same rule applies to
  the Thunderstore and Nexus cursors.

Never `JSON.parse` the body: a full parse takes ~8 ms. Measured cold, one fresh
Node process per figure, real payload (before -> after this scanner):

| Operation | CPU before -> after |
|---|---|
| Scan with `date_updated >= cursor` (33 matches) | ~2.9 -> ~2.7 ms |
| Scan where no record matches | ~2.5 -> ~1.9 ms |
| Lean extraction of all 1113 records | ~5.2 -> ~4.6 ms |
| Lean extraction of one quarter of the records | ~3.9 -> ~3.2 ms |
| Full extraction of one quarter of the records | ~4.8 -> ~5.4 ms |
| Full extraction of all 1113 records | ~8.4 -> ~11.9 ms |

Full extraction got dearer because every version item is now read for
`previousVersion`. It runs for matched records only in steady state and for
changed packages in reconciliation, in slices (see `docs/spec.md`).

Response reading concatenates the streamed chunks and decodes once
(`TextDecoder`, ~2 ms for 4.4 MB plus ~0.5 ms to concatenate) instead of decoding
every chunk and joining the strings (~4.7 ms with 16 KB chunks, more with larger
ones). The size limit is still enforced while streaming.

Budget: a steady-state dump tick costs about 1.3 ms per MB of payload (decode,
concatenate, scan), ~5.8 ms at today's 4.46 MB, and ~7.8 ms at the 6 MiB
`MAX_SCAN_BYTES`, the largest cap that still leaves room for the rest of the tick.

Reconciliation slices by `ctx.sliceHint mod hexiumDumpSlices` when the core
provides a hint (it increases by one per reconcile run, so the three daily runs
cover different slices) and by day number otherwise.

### Package index — no longer used

**[live]** `GET /api/experimental/package-index/`: NDJSON, one line per package
with `{"namespace","name","version_number","file_format","file_size","dependencies":[],"suggestions":[]}`.
There is **no `date_updated`** and no description, icon, categories, NSFW or
deprecated flag. 1063 lines, ~377 KB, chunked `application/x-ndjson`, no
`ETag` or `Last-Modified`. The game subdomain serves that game only; `hexium.gg`
merges every game (1116 lines). Because it cannot tell us whether a package is
NSFW, it is not used for detection or seeding.

### Changelog, per version

**[source]** Same shape as Thunderstore, on `https://hexium.gg`:

```
GET /api/experimental/package/{namespace}/{name}/{version}/changelog/
GET /api/experimental/package/{namespace}/{name}/{version}/readme/
```

### Other

**[source]** `/api/v1/package-listing-index/` and `/api/v1/package-listing-chunk/`
exist, gzip. Superseded by `/api/v1/package/` for our purposes.

**[source]** `/api/experimental/frontend/p/{namespace}/{name}/` returns full
package detail including `versions[]`, `last_updated`, `markdown`.

---

## Nexus Mods

Base: `https://api.nexusmods.com`. Auth: personal API key in the `apikey`
header. **Disabled by default** — see `docs/legal.md`.

**[source]**

```
GET /v1/games/{domain}/mods/updated.json?period=1d      # also 1w, 1m
GET /v1/games/{domain}/mods/latest_added.json
GET /v1/games/{domain}/mods/{id}.json
GET /v1/games/{domain}/mods/{id}/changelogs.json        # keyed by version
GET /v1/games/{domain}/mods/md5_search/{md5}.json
```

`updated.json` returns ids and timestamps only — names and images need a second
call per mod, which is what consumes quota. Cache mod metadata indefinitely and
refresh only on version change.

`changelogs.json` returns an object keyed by version number mapping to an array
of lines. Already split per version, unlike the Thunderstore side.

Rate limits: 2000 requests/hour, 20,000/day per key. Every response carries
`X-RL-*` headers — read them and self-throttle rather than counting locally.

GraphQL v2 at `https://api.nexusmods.com/v2/graphql` has a separate rate limit
pool and does not consume v1 quota. Most of it is reachable without
authentication; some operations need OAuth. Useful for batch metadata lookups.

`contains_adult_content` must be filtered — see `docs/legal.md`. It fails closed:
only the boolean `false` marks a mod safe, so a missing, null or non-boolean
value marks it adult.

Timestamps (`latest_file_update`, `updated_timestamp`, `created_timestamp`) are
epoch seconds; a value outside 1970-9999 (or non-numeric) makes that row
unusable and it is skipped instead of failing the whole poll. Changelog
responses are refused above 128 KB, and a `changelogs.json` entry that is not a
list of strings is ignored line by line.

---

## Rules for all upstreams

- Send a descriptive `User-Agent`: project name, version, repository URL.
  This is the single thing that distinguishes an integrator from a scraper when
  an admin reads the logs. Workers egress from shared Cloudflare IPs — getting
  banned harms other people.
- Store `ETag` per source in D1 and send `If-None-Match`. A 304 costs no
  bandwidth, no parsing and no CPU.
- Respect `Cache-Control`.
- Treat every upstream response as untrusted input. Descriptions and changelogs
  are user-submitted; sanitise before putting them in an embed.
