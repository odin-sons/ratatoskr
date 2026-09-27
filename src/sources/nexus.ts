// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PackageSnapshot, SourceConfig } from '../core/types.ts';
import type { PollContext, PollResult, SourceAdapter } from '../core/ports.ts';
import { extractNexusChangelog } from '../changelog/nexus.ts';
import { NEXUS_RATE_LIMIT, PROJECT } from '../core/constants.ts';
import { CHANGELOG_MAX_BYTES, NEXUS_THROTTLE_RESERVE, SOURCE_BUDGET } from './budget.ts';
import { UnexpectedShapeError, isRecord, num, parseJson, safeSlug, str, type Json } from './guards.ts';
import { UpstreamError, conditionalGet, describeError, skipOnError, type GetOptions } from './http.ts';
import { clampToNow, epochSecondsToIso, maxIso, normalizeIso } from './iso.ts';

export const NEXUS_HOST = 'api.nexusmods.com';
const NEXUS_API = `https://${NEXUS_HOST}/v1/games`;
const NEXUS_SITE = 'https://www.nexusmods.com';

interface Candidate {
  modId: number;
  ts: string;
  meta: Json | null;
}

/** First value that is a finite number within the representable range, as a canonical timestamp. */
function firstIso(...values: unknown[]): string | null {
  for (const value of values) {
    const seconds = num(value);
    const iso = seconds === null ? null : epochSecondsToIso(seconds);
    if (iso !== null) return iso;
  }
  return null;
}

/** True when either rate-limit window has less than the reserve fraction left. */
export function quotaLow(headers: Headers): boolean {
  const hourly = Number(headers.get('x-rl-hourly-remaining'));
  const daily = Number(headers.get('x-rl-daily-remaining'));
  const hourlyLow = headers.has('x-rl-hourly-remaining') && Number.isFinite(hourly) && hourly < NEXUS_RATE_LIMIT.perHour * NEXUS_THROTTLE_RESERVE;
  const dailyLow = headers.has('x-rl-daily-remaining') && Number.isFinite(daily) && daily < NEXUS_RATE_LIMIT.perDay * NEXUS_THROTTLE_RESERVE;
  return hourlyLow || dailyLow;
}

export class NexusAdapter implements SourceAdapter {
  readonly config: SourceConfig;

  constructor(config: SourceConfig) {
    this.config = config;
  }

  private apiKey(ctx: PollContext): string | null {
    if (!this.config.enabled) return null;
    const key = ctx.secrets.NEXUS_API_KEY;
    return key ? key : null;
  }

  private request(ctx: PollContext, key: string, path: string, maxBytes?: number): Promise<Awaited<ReturnType<typeof conditionalGet>>> {
    const opts: GetOptions = {
      validator: null,
      maxBytes,
      headers: { 'Application-Name': PROJECT.name, 'Application-Version': PROJECT.version },
      credentials: { header: 'apikey', value: key, host: NEXUS_HOST },
    };
    return conditionalGet(ctx, `${NEXUS_API}/${encodeURIComponent(this.config.community)}/${path}`, opts);
  }

  async poll(ctx: PollContext): Promise<PollResult> {
    const key = this.apiKey(ctx);
    if (key === null) {
      if (this.config.enabled) console.warn(`[${this.config.id}] poll skipped: NEXUS_API_KEY is not set`);
      return { status: 'skipped' };
    }
    try {
      return await this.pollInner(ctx, key);
    } catch (err) {
      return skipOnError(this.config.id, err);
    }
  }

  private async pollInner(ctx: PollContext, key: string): Promise<PollResult> {
    if (!safeSlug(this.config.community)) throw new Error('invalid game domain');
    const stored = ctx.state?.cursor ? normalizeIso(ctx.state.cursor) : null;
    const cursor = stored === null ? null : clampToNow(stored, ctx.now);
    const coldStart = cursor === null;

    const updated = await this.request(ctx, key, 'mods/updated.json?period=1d');
    if (updated.status !== 'ok') throw new UnexpectedShapeError('updated.json returned no body');
    if (quotaLow(updated.headers)) throw new Error('rate limit reserve reached, backing off');

    const added = await this.request(ctx, key, 'mods/latest_added.json');
    if (added.status !== 'ok') throw new UnexpectedShapeError('latest_added.json returned no body');
    let lowQuota = quotaLow(added.headers);

    const updatedBody = parseJson(updated.text);
    const addedBody = parseJson(added.text);
    if (!Array.isArray(updatedBody) || !Array.isArray(addedBody)) throw new UnexpectedShapeError('mod lists are not arrays');

    const byId = new Map<number, Candidate>();
    for (const row of updatedBody) {
      if (!isRecord(row)) continue;
      const modId = num(row.mod_id);
      const ts = firstIso(row.latest_file_update);
      if (modId === null || ts === null) continue;
      byId.set(modId, { modId, ts, meta: null });
    }
    for (const mod of addedBody) {
      if (!isRecord(mod)) continue;
      const modId = num(mod.mod_id);
      const ts = firstIso(mod.updated_timestamp, mod.created_timestamp);
      if (modId === null || ts === null) continue;
      const existing = byId.get(modId);
      byId.set(modId, { modId, ts: maxIso(existing?.ts ?? null, ts) ?? ts, meta: mod });
    }

    const overall = [...byId.values()].reduce<string | null>((acc, c) => maxIso(acc, c.ts), null);
    let candidates = [...byId.values()].filter((c) => cursor === null || c.ts > cursor);
    candidates.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    let complete = true;
    if (coldStart) {
      const withMeta = candidates.filter((c) => c.meta !== null);
      const bare = candidates.filter((c) => c.meta === null).slice(-SOURCE_BUDGET.nexusMetadataLookups);
      if (bare.length < candidates.length - withMeta.length) complete = false;
      candidates = [...withMeta, ...bare].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    }

    const packages: PackageSnapshot[] = [];
    let newCursor: string | null = coldStart ? overall : cursor;
    let lookups = 0;
    for (const candidate of candidates) {
      let meta = candidate.meta;
      if (meta === null) {
        if (lookups >= SOURCE_BUDGET.nexusMetadataLookups || lowQuota) {
          complete = false;
          break;
        }
        lookups += 1;
        try {
          const res = await this.request(ctx, key, `mods/${candidate.modId}.json`);
          if (res.status !== 'ok') throw new UnexpectedShapeError('mod metadata returned no body');
          lowQuota = quotaLow(res.headers);
          const body = parseJson(res.text);
          if (!isRecord(body)) throw new UnexpectedShapeError('mod metadata is not an object');
          meta = body;
        } catch (err) {
          if (err instanceof UpstreamError && (err.status === 404 || err.status === 403)) {
            if (!coldStart) newCursor = maxIso(newCursor, candidate.ts);
            continue;
          }
          if (coldStart) throw err;
          console.warn(`[${this.config.id}] metadata lookup deferred: ${describeError(err)}`);
          complete = false;
          break;
        }
      }
      const snapshot = this.toSnapshot(meta, candidate.ts);
      if (snapshot) packages.push(snapshot);
      if (!coldStart) newCursor = maxIso(newCursor, candidate.ts);
    }

    return { status: 'ok', packages, cursor: newCursor, etag: null, complete };
  }

  private toSnapshot(mod: Json, ts: string): PackageSnapshot | null {
    const modId = num(mod.mod_id);
    const name = str(mod.name);
    const version = str(mod.version);
    if (modId === null || !name || !version) return null;
    if (mod.available === false) return null;
    if (typeof mod.status === 'string' && mod.status !== 'published') return null;
    return {
      source: this.config.id,
      store: 'nexus',
      packageId: String(modId),
      owner: str(mod.author) ?? str(mod.uploaded_by) ?? 'unknown',
      name,
      version,
      url: `${NEXUS_SITE}/${encodeURIComponent(this.config.community)}/mods/${modId}`,
      iconUrl: str(mod.picture_url),
      description: str(mod.summary),
      categories: [],
      isNsfw: mod.contains_adult_content !== false,
      isDeprecated: false,
      updatedAt: firstIso(mod.updated_timestamp) ?? ts,
      sizeBytes: null,
    };
  }

  async fetchChangelog(
    ctx: PollContext,
    pkg: PackageSnapshot,
    version: string,
  ): Promise<{ excerpt: string | null; url: string | null }> {
    const key = this.apiKey(ctx);
    if (key === null) return { excerpt: null, url: null };
    const fullUrl = `${pkg.url}?tab=logs`;
    try {
      const res = await this.request(ctx, key, `mods/${encodeURIComponent(pkg.packageId)}/changelogs.json`, CHANGELOG_MAX_BYTES);
      if (res.status !== 'ok' || quotaLow(res.headers)) return { excerpt: null, url: null };
      const body = parseJson(res.text);
      if (!isRecord(body)) return { excerpt: null, url: null };
      const excerpt = extractNexusChangelog(body, version, { fullUrl });
      return excerpt === null ? { excerpt: null, url: null } : { excerpt, url: fullUrl };
    } catch (err) {
      console.warn(`[${this.config.id}] changelog fetch failed: ${describeError(err)}`);
      return { excerpt: null, url: null };
    }
  }
}
