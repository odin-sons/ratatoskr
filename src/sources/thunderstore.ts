// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PackageSnapshot, SourceConfig } from '../core/types.ts';
import type { PollContext, PollResult, SourceAdapter } from '../core/ports.ts';
import { extractChangelog } from '../changelog/extract.ts';
import { CHANGELOG_MAX_BYTES, SOURCE_BUDGET, STALE_CACHE_WINDOW_MS, VERSIONS_MAX_BYTES } from './budget.ts';
import { UnexpectedShapeError, isRecord, num, parseJson, safeSlug, str, type Json } from './guards.ts';
import { ResponseTooLargeError, UpstreamError, conditionalGet, describeError, skipOnError } from './http.ts';
import { clampToNow, maxIso, normalizeIso } from './iso.ts';

export const THUNDERSTORE_ORIGIN = 'https://thunderstore.io';

interface Entry {
  raw: Json;
  namespace: string;
  name: string;
  updated: string;
}

function packageUrl(community: string, namespace: string, name: string): string {
  return `${THUNDERSTORE_ORIGIN}/c/${encodeURIComponent(community)}/p/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/`;
}

function categoryNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const c of value) {
    const name = typeof c === 'string' ? c : isRecord(c) ? str(c.name) : null;
    if (name) names.push(name);
  }
  return names;
}

function parseEntry(item: unknown): Entry | null {
  if (!isRecord(item)) return null;
  const namespace = str(item.namespace);
  const name = str(item.name);
  const updated = typeof item.last_updated === 'string' ? normalizeIso(item.last_updated) : null;
  if (!namespace || !name || !updated) return null;
  return { raw: item, namespace, name, updated };
}

function parseListingPage(text: string): { entries: Entry[]; hasNext: boolean } {
  const body = parseJson(text);
  if (!isRecord(body) || !Array.isArray(body.results)) throw new UnexpectedShapeError('listing has no results[]');
  const entries: Entry[] = [];
  for (const item of body.results) {
    const entry = parseEntry(item);
    if (entry) entries.push(entry);
  }
  if (body.results.length > 0 && entries.length === 0) throw new UnexpectedShapeError('no listing item is usable');
  return { entries, hasNext: typeof body.next === 'string' && body.next.length > 0 };
}

interface Page {
  entries: Entry[];
  hasNext: boolean;
}

/** Contiguous run of listing pages read in one poll. */
interface ListingWindow {
  entries: Entry[];
  /** Every item newer than the cursor is in `entries`. */
  complete: boolean;
  /** Listing page where the next poll resumes when the window is not complete. */
  resume: number | null;
}

const RESUME_SEPARATOR = '@';
const MAX_RESUME_PAGE = 500;

/** Cursor is an ISO timestamp, optionally followed by `@<page>` while a backlog deeper than the page cap drains. */
function parseCursor(raw: string | null | undefined): { iso: string; resume: number | null } | null {
  if (!raw) return null;
  const at = raw.indexOf(RESUME_SEPARATOR);
  const iso = normalizeIso(at === -1 ? raw : raw.slice(0, at));
  if (iso === null) return null;
  const page = at === -1 ? Number.NaN : Number(raw.slice(at + 1));
  return { iso, resume: Number.isInteger(page) && page >= 2 && page <= MAX_RESUME_PAGE ? page : null };
}

function formatCursor(iso: string | null, resume: number | null): string | null {
  return iso !== null && resume !== null ? `${iso}${RESUME_SEPARATOR}${resume}` : iso;
}

/** True when the page ends the backlog: it holds an unpinned item at or before the cursor, or is the last page. */
function reachesCursor(page: Page, cursor: string): boolean {
  if (!page.hasNext) return true;
  let unpinned = 0;
  for (const e of page.entries) {
    if (e.raw.is_pinned === true) continue;
    unpinned += 1;
    if (e.updated <= cursor) return true;
  }
  return unpinned === 0;
}

interface Release {
  version: string;
  created: string;
}

export class ThunderstoreAdapter implements SourceAdapter {
  readonly config: SourceConfig;

  constructor(config: SourceConfig) {
    this.config = config;
  }

  private listingUrl(page: number): string {
    return `${THUNDERSTORE_ORIGIN}/api/cyberstorm/listing/${encodeURIComponent(this.config.community)}/?ordering=last-updated&nsfw=false&deprecated=false&page=${page}`;
  }

  async poll(ctx: PollContext): Promise<PollResult> {
    try {
      return await this.pollInner(ctx);
    } catch (err) {
      return skipOnError(this.config.id, err);
    }
  }

  private async fetchPage(ctx: PollContext, page: number): Promise<Page> {
    const res = await conditionalGet(ctx, this.listingUrl(page), { validator: null });
    if (res.status !== 'ok') throw new UnexpectedShapeError('listing page returned no body');
    return parseListingPage(res.text);
  }

  /** Reads pages down to the one that reaches the cursor; a backlog deeper than the page cap is read from the resume page. */
  private async readWindow(ctx: PollContext, first: Page, cursor: string | null, resume: number | null): Promise<ListingWindow> {
    if (cursor === null || reachesCursor(first, cursor)) return { entries: first.entries, complete: true, resume: null };

    let start = resume ?? 2;
    let run = start === 2 ? first.entries : [];
    let page = start;
    for (let fetched = 1; fetched < SOURCE_BUDGET.thunderstoreListingPages; fetched += 1) {
      let parsed: Page;
      try {
        parsed = await this.fetchPage(ctx, page);
      } catch (err) {
        if (!(err instanceof UpstreamError) || err.status !== 404) throw err;
        if (page === start && start > 2) {
          start = 2;
          page = 2;
          run = first.entries;
          continue;
        }
        parsed = { entries: [], hasNext: false };
      }
      run = run.concat(parsed.entries);
      if (reachesCursor(parsed, cursor)) {
        return { entries: run, complete: start === 2, resume: start === 2 ? null : Math.max(2, page - 1) };
      }
      page += 1;
    }
    return { entries: [], complete: false, resume: page };
  }

  private async pollInner(ctx: PollContext): Promise<PollResult> {
    if (!safeSlug(this.config.community)) throw new Error('invalid community slug');
    const parsedCursor = parseCursor(ctx.state?.cursor);
    const cursor = parsedCursor === null ? null : clampToNow(parsedCursor.iso, ctx.now);

    const first = await conditionalGet(ctx, this.listingUrl(1));
    if (first.status === 'not-modified') return { status: 'not-modified', etag: ctx.state?.etag ?? null };

    const window = await this.readWindow(ctx, parseListingPage(first.text), cursor, parsedCursor?.resume ?? null);

    const seen = new Set<string>();
    const unique = window.entries.filter((e) => {
      const key = `${e.namespace}-${e.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const pageMax = unique.reduce<string | null>((acc, e) => maxIso(acc, e.updated), null);
    let candidates = unique.filter((e) => cursor === null || e.updated > cursor);
    const coldStart = cursor === null;
    candidates.sort((a, b) => (a.updated < b.updated ? -1 : a.updated > b.updated ? 1 : 0));

    let complete = window.complete;
    if (coldStart && candidates.length > SOURCE_BUDGET.thunderstoreVersionLookups) {
      candidates = candidates.slice(-SOURCE_BUDGET.thunderstoreVersionLookups);
      complete = false;
    }

    const packages: PackageSnapshot[] = [];
    let newCursor: string | null = coldStart ? pageMax : cursor;
    let looked = 0;
    for (const entry of candidates) {
      if (looked >= SOURCE_BUDGET.thunderstoreVersionLookups) {
        complete = false;
        break;
      }
      looked += 1;
      let release: { latest: Release; previous: Release | null } | null;
      try {
        release = await this.latestVersion(ctx, entry);
      } catch (err) {
        if (err instanceof UpstreamError && err.status === 404) {
          if (!coldStart) newCursor = maxIso(newCursor, entry.updated);
          continue;
        }
        if (err instanceof ResponseTooLargeError) {
          console.warn(`[${this.config.id}] versions response too large, package skipped: ${entry.namespace}-${entry.name}`);
          if (!coldStart) newCursor = maxIso(newCursor, entry.updated);
          continue;
        }
        if (coldStart) throw err;
        console.warn(`[${this.config.id}] version lookup deferred: ${describeError(err)}`);
        complete = false;
        break;
      }
      if (release === null) {
        if (coldStart) throw new UnexpectedShapeError('versions cache is stale');
        console.warn(`[${this.config.id}] version lookup deferred: stale versions cache for ${entry.namespace}-${entry.name}`);
        complete = false;
        break;
      }
      packages.push(this.toSnapshot(entry, release.latest.version, release.previous?.version ?? null));
      if (!coldStart) newCursor = maxIso(newCursor, entry.updated);
    }

    return {
      status: 'ok',
      packages,
      cursor: formatCursor(newCursor, window.complete ? null : window.resume),
      etag: complete ? first.etag : (ctx.state?.etag ?? null),
      complete,
    };
  }

  /** Newest and second-newest release, or null when the versions endpoint looks older than the listing. */
  private async latestVersion(ctx: PollContext, entry: Entry): Promise<{ latest: Release; previous: Release | null } | null> {
    const url = `${THUNDERSTORE_ORIGIN}/api/cyberstorm/package/${encodeURIComponent(entry.namespace)}/${encodeURIComponent(entry.name)}/versions/`;
    const res = await conditionalGet(ctx, url, { validator: null, maxBytes: VERSIONS_MAX_BYTES });
    if (res.status !== 'ok') throw new UnexpectedShapeError('versions endpoint returned no body');
    const body = parseJson(res.text);
    if (!Array.isArray(body)) throw new UnexpectedShapeError('versions is not an array');

    let latest: Release | null = null;
    let previous: Release | null = null;
    for (const v of body) {
      if (!isRecord(v)) continue;
      const version = str(v.version_number);
      const created = typeof v.datetime_created === 'string' ? normalizeIso(v.datetime_created) : null;
      if (!version || !created) continue;
      const release = { version, created };
      if (latest === null || created > latest.created) {
        previous = latest;
        latest = release;
      } else if (previous === null || created > previous.created) {
        previous = release;
      }
    }
    if (latest === null) throw new UnexpectedShapeError('versions[] has no usable entry');

    const updatedMs = Date.parse(entry.updated.slice(0, 19) + 'Z');
    const createdMs = Date.parse(latest.created.slice(0, 19) + 'Z');
    const looksStale = createdMs < updatedMs - 30_000 && ctx.now.getTime() - updatedMs < STALE_CACHE_WINDOW_MS;
    return looksStale ? null : { latest, previous };
  }

  private toSnapshot(entry: Entry, version: string, previousVersion: string | null): PackageSnapshot {
    const r = entry.raw;
    return {
      source: this.config.id,
      store: 'thunderstore',
      packageId: `${entry.namespace}-${entry.name}`,
      owner: entry.namespace,
      name: entry.name,
      version,
      previousVersion,
      url: packageUrl(this.config.community, entry.namespace, entry.name),
      iconUrl: str(r.icon_url),
      description: str(r.description),
      categories: categoryNames(r.categories),
      isNsfw: r.is_nsfw !== false,
      isDeprecated: r.is_deprecated === true,
      updatedAt: entry.updated,
      sizeBytes: num(r.size),
    };
  }

  async fetchChangelog(
    ctx: PollContext,
    pkg: PackageSnapshot,
    version: string,
  ): Promise<{ excerpt: string | null; url: string | null }> {
    const fullUrl = `${pkg.url}changelog/`;
    try {
      const api = `${THUNDERSTORE_ORIGIN}/api/experimental/package/${encodeURIComponent(pkg.owner)}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(version)}/changelog/`;
      const res = await conditionalGet(ctx, api, { validator: null, maxBytes: CHANGELOG_MAX_BYTES });
      if (res.status !== 'ok') return { excerpt: null, url: null };
      const body = parseJson(res.text);
      const markdown = isRecord(body) && typeof body.markdown === 'string' ? body.markdown : null;
      return { excerpt: extractChangelog(markdown, version, { fullUrl }), url: fullUrl };
    } catch (err) {
      console.warn(`[${this.config.id}] changelog fetch failed: ${describeError(err)}`);
      return { excerpt: null, url: null };
    }
  }
}
