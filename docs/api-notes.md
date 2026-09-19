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
their schema with a TODO saying the backend serializer is still rolling out and
the frontend deployed first. **Verify live whether the version number is
present.** If absent, resolve it with:

```
GET /api/cyberstorm/package/{namespace}/{name}/versions/
```

one request per changed package (a handful per tick).

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

**[assumed]** `/api/experimental/package-index/` probably exists here too (it
does on Hexium). If so, use it for reconciliation exactly as on Hexium.

---

## Hexium

Base: `https://{game}.hexium.gg` for listings, `https://hexium.gg` for
`/api/experimental/package/...` per Gale. The asymmetry is real — do not
assume one host for both.

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
change on their side that would remove the need for index polling entirely.
Until then, updates to existing Hexium packages come from `package-index`.

### Package index — the fallback that makes Hexium workable

**[source]** From their OpenAPI spec:

```
GET /api/experimental/package-index/
```

Described as "Newline-delimited JSON stream of all packages (latest version per
mod)". NDJSON, one line per package, no version history. Valheim has 1062
packages.

**[assumed]** Line shape — verify with `curl … | head -1`. Expected to carry
`date_updated` and a version.

Read it without parsing the whole thing: one pass over the raw text with
`indexOf('"date_updated":"', pos)`, compare the following 24 characters to the
stored cursor lexicographically (ISO-8601 sorts correctly as a string), and
`JSON.parse` only the lines that match. Do not `split('\n')` — that allocates
a thousand strings for nothing.

If served with `Content-Encoding: gzip`, `fetch` decompresses natively, outside
the JS CPU budget.

### Changelog, per version

**[source]** Same shape as Thunderstore, on `https://hexium.gg`:

```
GET /api/experimental/package/{namespace}/{name}/{version}/changelog/
GET /api/experimental/package/{namespace}/{name}/{version}/readme/
```

### Other

**[live]** `/api/v1/package/` returns the full dump — 1062 records for Valheim.
Works, but do not use from a Worker.

**[source]** `/api/v1/package-listing-index/` and `/api/v1/package-listing-chunk/`
exist, gzip. Superseded by `package-index` for our purposes.

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
