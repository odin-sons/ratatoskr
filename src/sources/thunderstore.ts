// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PackageSnapshot, SourceConfig } from '../core/types.ts';
import type { PollContext, PollResult, SourceAdapter } from '../core/ports.ts';
import { extractChangelog } from '../changelog/extract.ts';
import { SOURCE_BUDGET, STALE_CACHE_WINDOW_MS } from './budget.ts';
import { UnexpectedShapeError, isRecord, num, parseJson, safeSlug, str, type Json } from './guards.ts';
import { UpstreamError, conditionalGet, describeError, skipOnError } from './http.ts';
import { maxIso, normalizeIso } from './iso.ts';

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

export class ThunderstoreAdapter implements SourceAdapter {
  readonly config: SourceConfig;

  constructor(config: SourceConfig) {
    this.config = config;
  }

  private listingUrl(page: number): string {
    return `${THUNDERSTORE_ORIGIN}/api/cyberstorm/listing/${encodeURIComponent(this.config.community)}/?ordering=last-updated&page=${page}`;
  }

  async poll(ctx: PollContext): Promise<PollResult> {
    try {
      return await this.pollInner(ctx);
    } catch (err) {
      return skipOnError(this.config.id, err);
    }
  }

  private async pollInner(ctx: PollContext): Promise<PollResult> {
    if (!safeSlug(this.config.community)) throw new Error('invalid community slug');
    const cursor = ctx.state?.cursor ? normalizeIso(ctx.state.cursor) : null;

    const first = await conditionalGet(ctx, this.listingUrl(1));
    if (first.status === 'not-modified') return { status: 'not-modified', etag: ctx.state?.etag ?? null };

    let { entries, hasNext } = parseListingPage(first.text);
    let pages = 1;
    let pageCapHit = false;
    while (cursor !== null && hasNext && this.allFresh(entries, cursor)) {
      if (pages >= SOURCE_BUDGET.thunderstoreListingPages) {
        pageCapHit = true;
        break;
      }
      pages += 1;
      const next = await conditionalGet(ctx, this.listingUrl(pages), { validator: null });
      if (next.status !== 'ok') break;
      const parsed = parseListingPage(next.text);
      entries = entries.concat(parsed.entries);
      hasNext = parsed.hasNext;
    }

    const seen = new Set<string>();
    const unique = entries.filter((e) => {
      const key = `${e.namespace}-${e.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const pageMax = unique.reduce<string | null>((acc, e) => maxIso(acc, e.updated), null);
    let candidates = unique.filter((e) => cursor === null || e.updated > cursor);
    const coldStart = cursor === null;
    candidates.sort((a, b) => (a.updated < b.updated ? -1 : a.updated > b.updated ? 1 : 0));

    let complete = !pageCapHit;
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
      let version: string | null;
      try {
        version = await this.latestVersion(ctx, entry);
      } catch (err) {
        if (err instanceof UpstreamError && err.status === 404) {
          if (!coldStart) newCursor = maxIso(newCursor, entry.updated);
          continue;
        }
        if (coldStart) throw err;
        console.warn(`[${this.config.id}] version lookup deferred: ${describeError(err)}`);
        complete = false;
        break;
      }
      if (version === null) {
        if (coldStart) throw new UnexpectedShapeError('versions cache is stale');
        console.warn(`[${this.config.id}] version lookup deferred: stale versions cache for ${entry.namespace}-${entry.name}`);
        complete = false;
        break;
      }
      packages.push(this.toSnapshot(entry, version));
      if (!coldStart) newCursor = maxIso(newCursor, entry.updated);
    }

    return {
      status: 'ok',
      packages,
      cursor: newCursor,
      etag: complete ? first.etag : (ctx.state?.etag ?? null),
      complete,
    };
  }

  private allFresh(entries: Entry[], cursor: string): boolean {
    const unpinned = entries.filter((e) => e.raw.is_pinned !== true);
    return unpinned.length > 0 && unpinned.every((e) => e.updated > cursor);
  }

  /** Newest published version, or null when the versions endpoint looks older than the listing. */
  private async latestVersion(ctx: PollContext, entry: Entry): Promise<string | null> {
    const url = `${THUNDERSTORE_ORIGIN}/api/cyberstorm/package/${encodeURIComponent(entry.namespace)}/${encodeURIComponent(entry.name)}/versions/`;
    const res = await conditionalGet(ctx, url, { validator: null });
    if (res.status !== 'ok') throw new UnexpectedShapeError('versions endpoint returned no body');
    const body = parseJson(res.text);
    if (!Array.isArray(body)) throw new UnexpectedShapeError('versions is not an array');

    let best: { version: string; created: string } | null = null;
    for (const v of body) {
      if (!isRecord(v)) continue;
      const version = str(v.version_number);
      const created = typeof v.datetime_created === 'string' ? normalizeIso(v.datetime_created) : null;
      if (!version || !created) continue;
      if (best === null || created > best.created) best = { version, created };
    }
    if (best === null) throw new UnexpectedShapeError('versions[] has no usable entry');

    const updatedMs = Date.parse(entry.updated.slice(0, 19) + 'Z');
    const createdMs = Date.parse(best.created.slice(0, 19) + 'Z');
    const looksStale = createdMs < updatedMs - 30_000 && ctx.now.getTime() - updatedMs < STALE_CACHE_WINDOW_MS;
    return looksStale ? null : best.version;
  }

  private toSnapshot(entry: Entry, version: string): PackageSnapshot {
    const r = entry.raw;
    return {
      source: this.config.id,
      store: 'thunderstore',
      packageId: `${entry.namespace}-${entry.name}`,
      owner: entry.namespace,
      name: entry.name,
      version,
      url: packageUrl(this.config.community, entry.namespace, entry.name),
      iconUrl: str(r.icon_url),
      description: str(r.description),
      categories: categoryNames(r.categories),
      isNsfw: r.is_nsfw === true,
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
      const res = await conditionalGet(ctx, api, { validator: null });
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
