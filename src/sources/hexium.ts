// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PackageSnapshot, SourceConfig } from '../core/types.ts';
import type { PollContext, PollResult, SourceAdapter, Store } from '../core/ports.ts';
import { extractChangelog } from '../changelog/extract.ts';
import { CADENCE } from '../core/constants.ts';
import { CHANGELOG_MAX_BYTES, CURSOR_FUTURE_SLACK_MS, SOURCE_BUDGET } from './budget.ts';
import { UnexpectedShapeError, isRecord, parseJson, safeSlug, str } from './guards.ts';
import { conditionalGet, describeError, skipOnError } from './http.ts';
import { clampToNow, maxIso, normalizeIso } from './iso.ts';
import { scanPackageDump, type DumpRecord, type DumpScan } from './hexium-dump.ts';

const SEED_PREFIX = 'seed:';
const MS_PER_DAY = 86_400_000;

type Progress = { kind: 'seed'; next: number; mark: string | null } | { kind: 'time'; iso: string } | null;

/** Cursor is either an ISO timestamp or `seed:<nextSlice>:<iso>` while the initial seed is in progress. */
export function parseCursor(cursor: string | null | undefined): Progress {
  if (!cursor) return null;
  if (cursor.startsWith(SEED_PREFIX)) {
    const rest = cursor.slice(SEED_PREFIX.length);
    const sep = rest.indexOf(':');
    const next = Number(sep === -1 ? rest : rest.slice(0, sep));
    if (!Number.isInteger(next) || next < 0) return null;
    return { kind: 'seed', next, mark: sep === -1 ? null : normalizeIso(rest.slice(sep + 1)) };
  }
  const iso = normalizeIso(cursor);
  return iso === null ? null : { kind: 'time', iso };
}

function clampProgress(progress: Progress, now: Date): Progress {
  if (progress === null) return null;
  if (progress.kind === 'time') return { kind: 'time', iso: clampToNow(progress.iso, now) };
  return { ...progress, mark: progress.mark === null ? null : clampToNow(progress.mark, now) };
}

export class HexiumAdapter implements SourceAdapter {
  readonly config: SourceConfig;
  private readonly store: Pick<Store, 'getAllKnownVersions'>;

  constructor(config: SourceConfig, store: Pick<Store, 'getAllKnownVersions'>) {
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
    const progress = clampProgress(parseCursor(ctx.state?.cursor), ctx.now);
    if (ctx.state === null || !ctx.state.bootstrapped || progress === null || progress.kind === 'seed') {
      return this.seedSlice(ctx, progress?.kind === 'seed' ? progress : null);
    }

    if (ctx.tickIndex % CADENCE.hexiumIndexEveryNthTick === 0) {
      try {
        return await this.scanSince(ctx, progress.iso);
      } catch (err) {
        console.warn(`[${this.config.id}] dump scan failed, falling back to listing: ${describeError(err)}`);
      }
    }
    return this.pollListing(ctx);
  }

  private async fetchDump(ctx: PollContext): Promise<string> {
    const res = await conditionalGet(ctx, `${this.origin}/api/v1/package/`, { validator: null });
    if (res.status !== 'ok') throw new UnexpectedShapeError('package dump returned no body');
    return res.text;
  }

  /** Lean extraction of one slice of the dump; the source flips to a normal cursor after the last slice. */
  private async seedSlice(ctx: PollContext, progress: { next: number; mark: string | null } | null): Promise<PollResult> {
    const index = progress?.next ?? 0;
    const count = SOURCE_BUDGET.hexiumDumpSlices;
    const text = await this.fetchDump(ctx);

    const packages: PackageSnapshot[] = [];
    const scan = scanPackageDump(text, null, (r) => packages.push(this.snapshot(r)), {
      slice: { index: Math.min(index, count - 1), count },
      wantDetail: () => false,
      notAfter: this.cursorCeiling(ctx),
    });
    this.assertUsable(scan, packages.length, text.length);
    this.warnSkipped(scan);

    const mark = progress?.mark ?? scan.maxUpdated;
    const last = index >= count - 1;
    return {
      status: 'ok',
      packages,
      cursor: last ? mark : `${SEED_PREFIX}${index + 1}:${mark ?? ''}`,
      etag: null,
      complete: last,
    };
  }

  /** Records updated at or after the cursor, with full metadata and flags. */
  private async scanSince(ctx: PollContext, cursor: string): Promise<PollResult> {
    const text = await this.fetchDump(ctx);
    const packages: PackageSnapshot[] = [];
    const scan = scanPackageDump(text, cursor, (r) => packages.push(this.snapshot(r)), { notAfter: this.cursorCeiling(ctx) });
    this.assertUsable(scan, packages.length, text.length);
    this.warnSkipped(scan);
    return {
      status: 'ok',
      packages,
      cursor: maxIso(cursor, scan.maxUpdated),
      etag: ctx.state?.etag ?? null,
      complete: true,
    };
  }

  private cursorCeiling(ctx: PollContext): string {
    return new Date(ctx.now.getTime() + CURSOR_FUTURE_SLACK_MS).toISOString();
  }

  private warnSkipped(scan: DumpScan): void {
    if (scan.failed > 0) console.warn(`[${this.config.id}] unreadable dump records skipped: ${scan.failed}`);
  }

  private assertUsable(scan: DumpScan, extracted: number, bytes: number): void {
    if (scan.records === 0 && bytes > 2) throw new UnexpectedShapeError('package dump has no recognisable records');
    if (scan.aborted) throw new UnexpectedShapeError('package dump records are unreadable');
    if (scan.records > 0 && scan.maxUpdated === null) throw new UnexpectedShapeError('package dump timestamps are unreadable');
    if (scan.failed > 0 && extracted === 0) throw new UnexpectedShapeError('no package dump record could be read');
  }

  /** Creation-ordered page 1; catches new packages on ticks that skip the dump. Cursor is left to the dump scan. */
  private async pollListing(ctx: PollContext): Promise<PollResult> {
    const listing = await conditionalGet(ctx, `${this.origin}/api/experimental/frontend/packages/?page=1`);
    if (listing.status === 'not-modified') return { status: 'not-modified', etag: ctx.state?.etag ?? null };
    return {
      status: 'ok',
      packages: this.parseListing(listing.text),
      cursor: ctx.state?.cursor ?? null,
      etag: listing.etag,
      complete: true,
    };
  }

  private parseListing(text: string): PackageSnapshot[] {
    const body = parseJson(text);
    if (!isRecord(body) || !Array.isArray(body.packages)) throw new UnexpectedShapeError('listing has no packages[]');
    const out: PackageSnapshot[] = [];
    for (const item of body.packages) {
      const snapshot = this.listingItem(item);
      if (snapshot) out.push(snapshot);
    }
    if (body.packages.length > 0 && out.length === 0) throw new UnexpectedShapeError('no listing item is usable');
    return out;
  }

  private listingItem(item: unknown): PackageSnapshot | null {
    if (!isRecord(item)) return null;
    const namespace = str(item.owner);
    const name = str(item.name);
    const version = str(item.version_number);
    const updatedAt = typeof item.date_updated === 'string' ? normalizeIso(item.date_updated) : null;
    if (!namespace || !name || !version || !updatedAt) return null;
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
      isDeprecated: item.is_deprecated === true,
      updatedAt,
      sizeBytes: null,
    };
  }

  private snapshot(r: DumpRecord): PackageSnapshot {
    return {
      source: this.config.id,
      store: 'hexium',
      packageId: `${r.owner}-${r.name}`,
      owner: r.owner,
      name: r.name,
      version: r.version,
      previousVersion: r.previousVersion,
      url: this.packageUrl(r.owner, r.name),
      iconUrl: r.iconUrl,
      description: r.description,
      categories: r.categories,
      isNsfw: r.isNsfw,
      isDeprecated: r.isDeprecated,
      updatedAt: r.updatedAt,
      sizeBytes: r.sizeBytes,
    };
  }

  /**
   * One rotating slice of the dump (day number modulo the slice count), so a full sweep takes
   * `hexiumDumpSlices` runs. Full metadata only for packages whose version differs from the store's;
   * the rest are lean (flags and version only). Throws on upstream failure.
   */
  async reconcile(ctx: PollContext): Promise<PackageSnapshot[]> {
    if (!safeSlug(this.config.community)) throw new Error('invalid community slug');
    const count = SOURCE_BUDGET.hexiumDumpSlices;
    const index = (ctx.sliceHint ?? Math.floor(ctx.now.getTime() / MS_PER_DAY)) % count;
    const text = await this.fetchDump(ctx);
    const known = await this.store.getAllKnownVersions(this.config.id);

    const out: PackageSnapshot[] = [];
    const scan = scanPackageDump(text, null, (r) => out.push(this.snapshot(r)), {
      slice: { index, count },
      wantDetail: (owner, name, version) => known.get(`${owner}-${name}`) !== version,
    });
    this.assertUsable(scan, out.length, text.length);
    this.warnSkipped(scan);
    return out;
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
      return { excerpt: extractChangelog(markdown, version, { fullUrl: pkg.url }), url: pkg.url };
    } catch (err) {
      console.warn(`[${this.config.id}] changelog fetch failed: ${describeError(err)}`);
      return { excerpt: null, url: null };
    }
  }
}
