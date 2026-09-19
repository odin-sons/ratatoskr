// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PackageSnapshot, SourceConfig } from '../core/types.ts';
import type { PollContext, PollResult, SourceAdapter, Store } from '../core/ports.ts';
import { extractChangelog } from '../changelog/extract.ts';
import { CADENCE, CLOUDFLARE } from '../core/constants.ts';
import { SOURCE_BUDGET } from './budget.ts';
import { UnexpectedShapeError, isRecord, parseJson, safeSlug, str, type Json } from './guards.ts';
import { conditionalGet, describeError, skipOnError } from './http.ts';
import { maxIso, normalizeIso } from './iso.ts';
import { forEachLine, readNumberField, readStringField } from './ndjson.ts';

const NAMESPACE_MARKER = '"namespace":"';
const NAME_MARKER = '"name":"';
const VERSION_MARKER = '"version_number":"';
const SIZE_MARKER = '"file_size":';

export interface IndexEntry {
  namespace: string;
  name: string;
  version: string;
  fileSize: number | null;
}

/** Single pass over the raw NDJSON index. JSON.parse runs only for a line the fast field reader cannot handle. */
export function scanPackageIndex(text: string, visit: (entry: IndexEntry) => void): void {
  forEachLine(text, (start, end) => {
    const line = text.slice(start, end);
    let namespace = readStringField(line, NAMESPACE_MARKER);
    let name = readStringField(line, NAME_MARKER);
    let version = readStringField(line, VERSION_MARKER);
    let fileSize = readNumberField(line, SIZE_MARKER);
    if (namespace === null || name === null || version === null) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) return;
        namespace = str(parsed.namespace);
        name = str(parsed.name);
        version = str(parsed.version_number);
        fileSize = typeof parsed.file_size === 'number' ? parsed.file_size : null;
      } catch {
        return;
      }
      if (namespace === null || name === null || version === null) return;
    }
    visit({ namespace, name, version, fileSize });
  });
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
    const indexTick = ctx.tickIndex % CADENCE.hexiumIndexEveryNthTick === 0;

    const listing = await conditionalGet(ctx, `${this.origin}/api/experimental/frontend/packages/?page=1`, {
      validator: indexTick ? null : undefined,
    });
    if (listing.status === 'not-modified') return { status: 'not-modified', etag: ctx.state?.etag ?? null };

    const byId = new Map<string, PackageSnapshot>();
    let cursor = ctx.state?.cursor ? normalizeIso(ctx.state.cursor) : null;
    for (const snapshot of this.parseListing(listing.text)) {
      byId.set(snapshot.packageId, snapshot);
      cursor = maxIso(cursor, snapshot.updatedAt);
    }

    if (indexTick && ctx.state?.bootstrapped) {
      try {
        for (const snapshot of await this.updatedViaIndex(ctx, byId)) byId.set(snapshot.packageId, snapshot);
      } catch (err) {
        console.warn(`[${this.config.id}] index scan failed: ${describeError(err)}`);
      }
    }

    return { status: 'ok', packages: [...byId.values()], cursor, etag: listing.etag, complete: true };
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
      isNsfw: item.has_nsfw_content === true,
      isDeprecated: item.is_deprecated === true,
      updatedAt,
      sizeBytes: null,
    };
  }

  /** Known packages whose index version differs from the stored one, enriched with package detail up to the per-tick cap. */
  private async updatedViaIndex(ctx: PollContext, listed: Map<string, PackageSnapshot>): Promise<PackageSnapshot[]> {
    const res = await conditionalGet(ctx, `${this.origin}/api/experimental/package-index/`, { validator: null });
    if (res.status !== 'ok') return [];
    const known = await this.store.getAllKnownVersions(this.config.id);

    const changed: IndexEntry[] = [];
    scanPackageIndex(res.text, (entry) => {
      const id = `${entry.namespace}-${entry.name}`;
      const previous = known.get(id);
      if (previous !== undefined && previous !== entry.version && listed.get(id)?.version !== entry.version) {
        changed.push(entry);
      }
    });
    if (changed.length === 0) return [];

    const now = ctx.now.toISOString().slice(0, 19) + '.000000Z';
    const out: PackageSnapshot[] = changed.map((entry) => this.minimalSnapshot(entry, now));
    const lookups = out.slice(0, SOURCE_BUDGET.hexiumDetailLookups);
    for (let i = 0; i < lookups.length; i += CLOUDFLARE.simultaneousConnections) {
      const batch = lookups.slice(i, i + CLOUDFLARE.simultaneousConnections);
      await Promise.all(batch.map((snapshot) => this.enrich(ctx, snapshot)));
    }
    return out;
  }

  private minimalSnapshot(entry: IndexEntry, updatedAt: string): PackageSnapshot {
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
      updatedAt,
      sizeBytes: entry.fileSize,
    };
  }

  /** Fills icon, description, categories and updatedAt in place; leaves the snapshot untouched on any failure. */
  private async enrich(ctx: PollContext, snapshot: PackageSnapshot): Promise<void> {
    try {
      const url = `${this.origin}/api/experimental/frontend/p/${encodeURIComponent(snapshot.owner)}/${encodeURIComponent(snapshot.name)}/`;
      const res = await conditionalGet(ctx, url, { validator: null });
      if (res.status !== 'ok') return;
      const body: unknown = parseJson(res.text);
      if (!isRecord(body)) return;
      const detail: Json = body;
      const updated = typeof detail.last_updated === 'string' ? normalizeIso(detail.last_updated) : null;
      snapshot.iconUrl = str(detail.image_src);
      snapshot.description = str(detail.description);
      snapshot.categories = Array.isArray(detail.categories)
        ? detail.categories.filter((c): c is string => typeof c === 'string')
        : [];
      if (updated) snapshot.updatedAt = updated;
    } catch (err) {
      console.warn(`[${this.config.id}] detail lookup failed: ${describeError(err)}`);
    }
  }

  /** Full index sweep, no cursor filter. Throws on upstream failure so a failed sweep is never mistaken for an empty one. */
  async reconcile(ctx: PollContext): Promise<PackageSnapshot[]> {
    if (!safeSlug(this.config.community)) throw new Error('invalid community slug');
    const res = await conditionalGet(ctx, `${this.origin}/api/experimental/package-index/`, { validator: null });
    if (res.status !== 'ok') return [];
    const now = ctx.now.toISOString().slice(0, 19) + '.000000Z';
    const out: PackageSnapshot[] = [];
    scanPackageIndex(res.text, (entry) => out.push(this.minimalSnapshot(entry, now)));
    if (out.length === 0 && res.text.trim().length > 0) throw new UnexpectedShapeError('package-index has no usable line');
    return out;
  }

  async fetchChangelog(
    ctx: PollContext,
    pkg: PackageSnapshot,
    version: string,
  ): Promise<{ excerpt: string | null; url: string | null }> {
    try {
      const api = `${this.origin}/api/experimental/package/${encodeURIComponent(pkg.owner)}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(version)}/changelog/`;
      const res = await conditionalGet(ctx, api, { validator: null });
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
