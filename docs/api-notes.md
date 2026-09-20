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
guaranteed order — take the maximum `datetime_created`.

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
array with a record per package. Valheim, 2026-09-20: 1112 records, 4,436,211
bytes raw, ~425 KB gzip (`content-encoding: gzip`, chunked), **no `ETag` or
`Last-Modified`**.

Record keys: `name, full_name, owner, package_url, donation_link, date_created,
date_updated, uuid4, rating_score, is_pinned, is_deprecated, has_nsfw_content,
categories[], versions[]`. `versions[]` items: `name, full_name, description,
icon, version_number, dependencies, suggestions, download_url, downloads,
date_created, website_url, is_active, uuid4, file_size`.

- `"date_updated":"` occurs exactly once per record, in the header before
  `versions[]`. `uuid4` carries a sequential creation id.
- The header is `{"name":…,"categories":[…],"versions":[`, so a record can be cut
  at fixed markers without parsing.
- `versions[]` is newest-first by `date_created` in 1111 of 1112 records; one
  two-version package is oldest-first, and there `date_updated` predates its
  newest version. The adapter therefore compares the first and the last listed
  version by `date_created`. Semver order is not usable: 89 records list a
  lower version number after a higher one. `is_active` was true everywhere.
- `has_nsfw_content` and `is_deprecated` are present (0 NSFW, 48 deprecated in
  Valheim), as are description, icon, categories and `file_size`.

Never `JSON.parse` the body: a full parse takes ~8 ms. The adapter does one
`indexOf` pass over the raw text and extracts fields by offset (measured cold,
fresh Node process, real payload):

| Operation | CPU |
|---|---|
| `TextDecoder` decode of 4.4 MB | ~2 ms |
| Scan with `date_updated >= cursor` (few matches) | ~2.7 ms, ~4.6 ms with decode |
| Lean extraction of all 1112 records (id, flags, first version) | ~5 ms, ~7 ms with decode |
| Lean extraction of one quarter of the records | ~3.1 ms, ~5.1 ms with decode |
| Full extraction of all 1112 records | ~8 ms, ~10 ms with decode |

Per-record extraction by offset beat parsing each record's header and newest
version with `JSON.parse` (~11 ms cold, ~8.8 ms warm for the same work).
A full extraction does not fit the 10 ms budget, so seeding and reconciliation
run in slices (see `docs/spec.md`). The 8 MB `MAX_SCAN_BYTES` leaves about 1.8x
headroom over today's payload.

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

`contains_adult_content` must be filtered — see `docs/legal.md`.

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
