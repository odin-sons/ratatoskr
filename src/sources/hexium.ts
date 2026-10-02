// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PackageSnapshot, SourceConfig } from '../core/types.ts';
import type { PollContext, PollResult, SourceAdapter, Store } from '../core/ports.ts';
import { extractChangelog } from '../changelog/extract.ts';
import { CADENCE, CLOUDFLARE } from '../core/constants.ts';
import {
  CHANGELOG_MAX_BYTES,
  HEXIUM_INDEX_MAX_BYTES,
  HEXIUM_LOOKUP_MAX_BYTES,
  SOURCE_BUDGET,
  SOURCE_URL_MAX_CHARS,
} from './budget.ts';
import { UnexpectedShapeError, count, isRecord, parseJson, safeSlug, str, websiteUrl, type Json } from './guards.ts';
import { ResponseTooLargeError, UpstreamError, conditionalGet, describeError, skipOnError } from './http.ts';
import { scanPackageIndex, seedSliceOf, type IndexEntry, type IndexScan } from './hexium-index.ts';
import { normalizeIso } from './iso.ts';

const SEED_PREFIX = 'seed:';
const TOO_MANY_REQUESTS = 429;
const SEED_UNREADABLE_LINES_FLOOR = 3;
const SEED_UNREADABLE_LINES_SHARE = 0.01;

const HEXIUM_HOST = 'hexium.gg';

/** An https URL on hexium.gg or a subdomain, without credentials, at most 512 characters; anything else is null. */
function hexiumDownloadUrl(raw: unknown): string | null {
  const text = str(raw);
  if (text === null || text.length > SOURCE_URL_MAX_CHARS) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const onHexium = url.hostname === HEXIUM_HOST || url.hostname.endsWith(`.${HEXIUM_HOST}`);
  const plain = url.protocol === 'https:' && url.username === '' && url.password === '';
  return onHexium && plain && url.href.length <= SOURCE_URL_MAX_CHARS ? url.href : null;
}

const WARN_INDEX_OVER_CAP = 'package-index above cap: updates of existing packages are not detected';
const WARN_INDEX_UNAVAILABLE = 'package-index unavailable or unreadable: updates of existing packages are not detected';

class IndexOverCapError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'IndexOverCapError';
  }
}

type LookupOutcome = { snapshot: PackageSnapshot } | { failure: 'failed' | 'unreadable'; rateLimited: boolean };

interface Skipped {
  indexLines: number;
  lookupsFailed: number;
  lookupsUnreadable: number;
  listingItems: number;
}

const noSkipped = (): Skipped => ({ indexLines: 0, lookupsFailed: 0, lookupsUnreadable: 0, listingItems: 0 });
const withWarnings = (warnings: string[]): { warnings?: string[] } => (warnings.length === 0 ? {} : { warnings });

interface LookupPass {
  packages: PackageSnapshot[];
  /** Every candidate was looked up and read. */
  complete: boolean;
  requested: number;
  candidates: number;
  picked: number;
  skipped: Skipped;
  warnings: string[];
}

/** Slice to seed next: `seed:<n>` resumes at n; anything else (legacy marks, out of range, junk) starts over. */
function seedIndex(cursor: string | null | undefined, count: number): number {
  if (!cursor?.startsWith(SEED_PREFIX)) return 0;
  const rest = cursor.slice(SEED_PREFIX.length);
  const next = /^\d{1,6}$/.test(rest) ? Number(rest) : -1;
  return next >= 0 && next < count ? next : 0;
}

/** `cap` items starting at a window that advances by `cap` per rotation step and wraps. */
function pickWindow<T>(items: T[], cap: number, rotation: number): T[] {
  if (items.length <= cap) return items;
  const start = (((rotation * cap) % items.length) + items.length) % items.length;
  const head = items.slice(start, start + cap);
  return head.length === cap ? head : head.concat(items.slice(0, cap - head.length));
}

export class HexiumAdapter implements SourceAdapter {
  readonly config: SourceConfig;
  private readonly store: Pick<Store, 'getAllKnownVersions' | 'getKnownVersions'>;

  constructor(config: SourceConfig, store: Pick<Store, 'getAllKnownVersions' | 'getKnownVersions'>) {
    this.config = config;
    this.store = store;
  }

  private get origin(): string {
    return `https://${this.config.community}.hexium.gg`;
  }

  private packageUrl(namespace: string, name: string): string {
    return `${this.origin}/mods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
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
    const state = ctx.state;
    if (state === null || !state.bootstrapped) return this.seedSlice(ctx, seedIndex(state?.cursor, SOURCE_BUDGET.hexiumSeedSlices));

    const listing = await this.readListing(ctx);
    const scanDue = ctx.tickIndex % CADENCE.hexiumIndexEveryNthTick === 0;
    const listingSkipped = listing === 'not-modified' ? 0 : listing.skipped;
    if (!scanDue) {
      if (listing === 'not-modified') return { status: 'not-modified', etag: state.etag };
      const warnings = this.reportSkipped({ ...noSkipped(), listingItems: listingSkipped });
      const lookedUp = await this.lookUpListedUpdates(ctx, listing.packages);
      return { status: 'ok', packages: listing.packages.concat(lookedUp), cursor: state.cursor, etag: listing.etag, complete: true, ...withWarnings(warnings) };
    }

    const delivered = listing === 'not-modified' ? [] : listing.packages;
    let packages: PackageSnapshot[] = [];
    let complete = false;
    let warnings: string[];
    try {
      const lookups = await this.scanForChanges(ctx, delivered, listingSkipped);
      packages = lookups.packages;
      complete = lookups.complete;
      warnings = lookups.warnings;
    } catch (err) {
      console.warn(`[${this.config.id}] index scan failed, listing only: ${describeError(err)}`);
      warnings = [
        ...this.reportSkipped({ ...noSkipped(), listingItems: listingSkipped }),
        err instanceof IndexOverCapError ? WARN_INDEX_OVER_CAP : WARN_INDEX_UNAVAILABLE,
      ];
    }
    return {
      status: 'ok',
      packages: delivered.concat(packages),
      cursor: state.cursor,
      etag: listing === 'not-modified' ? state.etag : listing.etag,
      complete,
      ...withWarnings(warnings),
    };
  }

  /**
   * Full lookups for known packages whose version the listing changed, so the update carries its download
   * link (the listing item has none). At most `hexiumListingLookupsPerTick`; the rest and any failed lookup
   * keep the listing snapshot. Never throws: a store or upstream failure leaves the listing as it is.
   */
  private async lookUpListedUpdates(ctx: PollContext, listed: PackageSnapshot[]): Promise<PackageSnapshot[]> {
    if (listed.length === 0) return [];
    try {
      const known = await this.store.getKnownVersions(this.config.id, listed.map((p) => p.packageId));
      const changed: IndexEntry[] = [];
      for (const p of listed) {
        const stored = known.get(p.packageId);
        if (stored !== undefined && stored !== p.version) changed.push({ namespace: p.owner, name: p.name, version: p.version, sizeBytes: null });
      }
      if (changed.length === 0) return [];
      return (await this.lookUp(ctx, changed, SOURCE_BUDGET.hexiumListingLookupsPerTick, 0)).packages;
    } catch (err) {
      console.warn(`[${this.config.id}] listing update lookups failed, listing only: ${describeError(err)}`);
      return [];
    }
  }

  private async fetchIndex(ctx: PollContext): Promise<string> {
    try {
      const res = await conditionalGet(ctx, `${this.origin}/api/experimental/package-index/`, { validator: null, maxBytes: HEXIUM_INDEX_MAX_BYTES });
      if (res.status !== 'ok') throw new UnexpectedShapeError('package index returned no body');
      return res.text;
    } catch (err) {
      if (err instanceof ResponseTooLargeError) throw new IndexOverCapError('package index body is too large');
      throw err;
    }
  }

  private assertUsable(scan: IndexScan, bytes: number): void {
    if (scan.truncated) throw new IndexOverCapError('package index has too many lines');
    if (scan.lines === 0 && bytes > 2) throw new UnexpectedShapeError('package index has no lines');
    if (scan.lines > 0 && scan.failed === scan.lines) throw new UnexpectedShapeError('no package index line is readable');
  }

  /** Logs the counts in one line and returns that line as a run-log warning; nothing when nothing was skipped. */
  private reportSkipped(skipped: Skipped): string[] {
    if (skipped.indexLines + skipped.lookupsFailed + skipped.lookupsUnreadable + skipped.listingItems === 0) return [];
    const line = `skipped: index lines ${skipped.indexLines}, lookups failed ${skipped.lookupsFailed}, lookups unreadable ${skipped.lookupsUnreadable}, listing items ${skipped.listingItems}`;
    console.warn(`[${this.config.id}] ${line}`);
    return [line];
  }

  /** One slice of the index as lean snapshots; the source is bootstrapped after the last slice. */
  private async seedSlice(ctx: PollContext, index: number): Promise<PollResult> {
    const count = SOURCE_BUDGET.hexiumSeedSlices;
    const text = await this.fetchIndex(ctx);
    const seededAt = normalizeIso(ctx.now.toISOString()) ?? ctx.now.toISOString();

    const packages: PackageSnapshot[] = [];
    const scan = scanPackageIndex(text, (entry) => {
      if (seedSliceOf(entry.namespace, entry.name, count) === index) packages.push(this.leanSnapshot(entry, seededAt));
    });
    this.assertUsable(scan, text.length);
    const warnings = this.reportSkipped({ ...noSkipped(), indexLines: scan.failed });

    if (scan.failed > Math.max(SEED_UNREADABLE_LINES_FLOOR, Math.floor(scan.lines * SEED_UNREADABLE_LINES_SHARE))) {
      const paused = `seeding paused: ${scan.failed} unreadable index lines, will retry`;
      console.warn(`[${this.config.id}] ${paused}`);
      return { status: 'ok', packages: [], cursor: ctx.state?.cursor ?? null, etag: null, complete: false, warnings: [...warnings, paused] };
    }

    const last = index >= count - 1;
    return { status: 'ok', packages, cursor: last ? null : `${SEED_PREFIX}${index + 1}`, etag: null, complete: last, ...withWarnings(warnings) };
  }

  /** Packages whose indexed version differs from the store's, or that the store lacks; each gets a lookup. */
  private async scanForChanges(ctx: PollContext, delivered: PackageSnapshot[], listingSkipped: number): Promise<LookupPass> {
    const [text, known] = await Promise.all([this.fetchIndex(ctx), this.store.getAllKnownVersions(this.config.id)]);
    const deliveredVersions = new Map(delivered.map((p) => [p.packageId, p.version]));
    const { candidates, scan } = this.candidates(text, known, deliveredVersions);
    const rotation = Math.floor(ctx.tickIndex / CADENCE.hexiumIndexEveryNthTick);
    const pass = await this.lookUp(ctx, candidates, SOURCE_BUDGET.hexiumLookupsPerPoll, rotation);
    pass.skipped.indexLines = scan.failed;
    pass.skipped.listingItems = listingSkipped;
    pass.warnings = this.reportSkipped(pass.skipped);
    if (pass.picked < pass.candidates) pass.warnings.push(`lookups capped: ${pass.picked} of ${pass.candidates} candidates`);
    return pass;
  }

  /**
   * A listing-delivered version only excuses the lookup for a package the store has never
   * seen (kind `new`, no download link needed urgently in the initial announcement per
   * spec). A known package whose version changed always gets a full lookup, even when the
   * listing happens to carry that same new version this tick — the listing snapshot never
   * carries `download_url`, so skipping here would commit an `update` event with a null
   * download link (and, since the package upsert replaces `download_url` wholesale on a
   * version change, clobber any previously-good link too).
   */
  private candidates(
    text: string,
    known: Map<string, string>,
    delivered: Map<string, string>,
  ): { candidates: IndexEntry[]; scan: IndexScan } {
    const candidates: IndexEntry[] = [];
    const seen = new Set<string>();
    const scan = scanPackageIndex(text, (entry) => {
      const id = `${entry.namespace}-${entry.name}`;
      const knownVersion = known.get(id);
      if (knownVersion === entry.version || seen.has(id)) return;
      if (knownVersion === undefined && delivered.get(id) === entry.version) return;
      seen.add(id);
      candidates.push(entry);
    });
    this.assertUsable(scan, text.length);
    return { candidates, scan };
  }

  /** Looks up at most `cap` candidates, `simultaneousConnections` at a time; the rest wait for a later scan. */
  private async lookUp(ctx: PollContext, candidates: IndexEntry[], cap: number, rotation: number): Promise<LookupPass> {
    const picked = pickWindow(candidates, cap, rotation);
    const packages: PackageSnapshot[] = [];
    const skipped = noSkipped();
    let requested = 0;
    let rateLimited = false;

    for (let i = 0; i < picked.length && !rateLimited; i += CLOUDFLARE.simultaneousConnections) {
      const batch = picked.slice(i, i + CLOUDFLARE.simultaneousConnections);
      requested += batch.length;
      for (const outcome of await Promise.all(batch.map((entry) => this.lookUpOne(ctx, entry)))) {
        if ('snapshot' in outcome) {
          packages.push(outcome.snapshot);
          continue;
        }
        if (outcome.failure === 'failed') skipped.lookupsFailed += 1;
        else skipped.lookupsUnreadable += 1;
        rateLimited ||= outcome.rateLimited;
      }
    }
    const complete = picked.length === candidates.length && packages.length === candidates.length;
    return { packages, complete, requested, candidates: candidates.length, picked: picked.length, skipped, warnings: [] };
  }

  private async lookUpOne(ctx: PollContext, entry: IndexEntry): Promise<LookupOutcome> {
    const url = `${this.origin}/api/experimental/package/${encodeURIComponent(entry.namespace)}/${encodeURIComponent(entry.name)}/`;
    try {
      const res = await conditionalGet(ctx, url, { validator: null, maxBytes: HEXIUM_LOOKUP_MAX_BYTES });
      if (res.status !== 'ok') return { failure: 'failed', rateLimited: false };
      const snapshot = this.lookupSnapshot(entry, parseJson(res.text));
      return snapshot === null ? { failure: 'unreadable', rateLimited: false } : { snapshot };
    } catch (err) {
      if (err instanceof UnexpectedShapeError || err instanceof ResponseTooLargeError) return { failure: 'unreadable', rateLimited: false };
      return { failure: 'failed', rateLimited: err instanceof UpstreamError && err.status === TOO_MANY_REQUESTS };
    }
  }

  /** Full snapshot from a per-package lookup. Unknown safety flags resolve to the safe side; unreadable data yields null. */
  private lookupSnapshot(entry: IndexEntry, body: unknown): PackageSnapshot | null {
    if (!isRecord(body) || str(body.owner) !== entry.namespace || str(body.name) !== entry.name) return null;
    if (typeof body.is_deprecated !== 'boolean' || !isRecord(body.latest)) return null;
    const version = str(body.latest.version_number);
    const updatedAt = typeof body.date_updated === 'string' ? normalizeIso(body.date_updated) : null;
    if (version === null || updatedAt === null) return null;

    const own = Array.isArray(body.community_listings)
      ? body.community_listings.filter((l): l is Json => isRecord(l) && l.community === this.config.community)
      : [];
    const categories = Array.isArray(own[0]?.categories) ? own[0].categories.filter((c): c is string => typeof c === 'string') : [];
    const isNsfw = own.length === 0 || own.some((l) => l.has_nsfw_content !== false);

    const builtUrl = this.packageUrl(entry.namespace, entry.name);
    const url = str(body.package_url);
    return {
      source: this.config.id,
      store: 'hexium',
      packageId: `${entry.namespace}-${entry.name}`,
      owner: entry.namespace,
      name: entry.name,
      version,
      url: url !== null && url.startsWith(`${this.origin}/mods/`) ? url : builtUrl,
      iconUrl: str(body.latest.icon),
      description: str(body.latest.description),
      categories,
      isNsfw,
      isDeprecated: body.is_deprecated,
      updatedAt,
      sizeBytes: entry.sizeBytes,
      downloadUrl: hexiumDownloadUrl(body.latest.download_url),
      downloads: count(body.total_downloads),
      likes: count(body.rating_score),
      websiteUrl: websiteUrl(body.latest.website_url),
    };
  }

  /** Seed rows carry no metadata and default flags; they are never emitted, later events come from a lookup. */
  private leanSnapshot(entry: IndexEntry, seededAt: string): PackageSnapshot {
    return {
      source: this.config.id,
      store: 'hexium',
      packageId: `${entry.namespace}-${entry.name}`,
      owner: entry.namespace,
      name: entry.name,
      version: entry.version,
      url: this.packageUrl(entry.namespace, entry.name),
      iconUrl: null,
      description: null,
      categories: [],
      isNsfw: false,
      isDeprecated: false,
      updatedAt: seededAt,
      sizeBytes: entry.sizeBytes,
      downloadUrl: null,
      downloads: null,
      likes: null,
      websiteUrl: null,
    };
  }

  /** Creation-ordered page 1: new packages, with flags. */
  private async readListing(ctx: PollContext): Promise<'not-modified' | { packages: PackageSnapshot[]; etag: string | null; skipped: number }> {
    const listing = await conditionalGet(ctx, `${this.origin}/api/experimental/frontend/packages/?page=1`);
    if (listing.status === 'not-modified') return 'not-modified';
    const { packages, skipped } = this.parseListing(listing.text);
    return { packages, etag: listing.etag, skipped };
  }

  private parseListing(text: string): { packages: PackageSnapshot[]; skipped: number } {
    const body = parseJson(text);
    if (!isRecord(body) || !Array.isArray(body.packages)) throw new UnexpectedShapeError('listing has no packages[]');
    const out: PackageSnapshot[] = [];
    for (const item of body.packages) {
      const snapshot = this.listingItem(item);
      if (snapshot) out.push(snapshot);
    }
    if (body.packages.length > 0 && out.length === 0) throw new UnexpectedShapeError('no listing item is usable');
    return { packages: out, skipped: body.packages.length - out.length };
  }

  private listingItem(item: unknown): PackageSnapshot | null {
    if (!isRecord(item)) return null;
    const namespace = str(item.owner);
    const name = str(item.name);
    const version = str(item.version_number);
    const updatedAt = typeof item.date_updated === 'string' ? normalizeIso(item.date_updated) : null;
    if (!namespace || !name || !version || !updatedAt || typeof item.is_deprecated !== 'boolean') return null;
    return {
      source: this.config.id,
      store: 'hexium',
      packageId: `${namespace}-${name}`,
      owner: namespace,
      name,
      version,
      url: str(item.package_url) ?? this.packageUrl(namespace, name),
      iconUrl: str(item.icon_url),
      description: str(item.description),
      categories: Array.isArray(item.categories) ? item.categories.filter((c): c is string => typeof c === 'string') : [],
      isNsfw: item.has_nsfw_content !== false,
      isDeprecated: item.is_deprecated,
      updatedAt,
      sizeBytes: null,
      downloadUrl: null,
      downloads: count(item.download_count),
      likes: count(item.rating_score),
      websiteUrl: null,
    };
  }

  /**
   * The same index comparison as an index tick, over the whole index, with a larger lookup cap; `sliceHint`
   * rotates which candidates come first when more than the cap are pending. Throws on upstream failure.
   */
  async reconcile(ctx: PollContext): Promise<PackageSnapshot[]> {
    if (!safeSlug(this.config.community)) throw new Error('invalid community slug');
    const [text, known] = await Promise.all([this.fetchIndex(ctx), this.store.getAllKnownVersions(this.config.id)]);
    const { candidates, scan } = this.candidates(text, known, new Map());
    const pass = await this.lookUp(ctx, candidates, SOURCE_BUDGET.hexiumLookupsPerReconcile, ctx.sliceHint ?? 0);
    pass.skipped.indexLines = scan.failed;
    this.reportSkipped(pass.skipped);
    if (pass.requested > 0 && pass.packages.length === 0) throw new UnexpectedShapeError('no package lookup succeeded');
    return pass.packages;
  }

  async fetchChangelog(
    ctx: PollContext,
    pkg: PackageSnapshot,
    version: string,
  ): Promise<{ excerpt: string | null; url: string | null }> {
    try {
      const api = `${this.origin}/api/experimental/package/${encodeURIComponent(pkg.owner)}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(version)}/changelog/`;
      const res = await conditionalGet(ctx, api, { validator: null, maxBytes: CHANGELOG_MAX_BYTES });
      if (res.status !== 'ok') return { excerpt: null, url: null };
      const body = parseJson(res.text);
      const markdown = isRecord(body) && typeof body.markdown === 'string' ? body.markdown : null;
      const excerpt = extractChangelog(markdown, version, { fullUrl: pkg.url });
      return excerpt === null ? { excerpt: null, url: null } : { excerpt, url: pkg.url };
    } catch (err) {
      console.warn(`[${this.config.id}] changelog fetch failed: ${describeError(err)}`);
      return { excerpt: null, url: null };
    }
  }
}
