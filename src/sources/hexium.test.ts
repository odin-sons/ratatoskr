// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PollContext, PollResult } from '../core/ports.ts';
import type { SourceConfig } from '../core/types.ts';
import { createFakeFetch, fixture, json, makeCtx, makeState, text, type FakeFetch } from './__fixtures__/fake-fetch.ts';
import { HexiumAdapter, parseCursor } from './hexium.ts';

const config: SourceConfig = { id: 'hexium:valheim', store: 'hexium', community: 'valheim', enabled: true };
const ORIGIN = 'https://valheim.hexium.gg';
const LISTING = `${ORIGIN}/api/experimental/frontend/packages/?page=1`;
const DUMP = `${ORIGIN}/api/v1/package/`;
const dumpFixture = fixture('hexium-v1-package.json');
const listingFixture = fixture('hexium-listing.json');

interface Truth {
  full_name: string;
  uuid4: string;
  date_updated: string;
  has_nsfw_content: boolean;
  is_deprecated: boolean;
}
const truth = JSON.parse(dumpFixture) as Truth[];
const seq = (t: Truth): number => Number.parseInt(t.uuid4.slice(0, 8), 16);
const ids = (r: { packageId: string }[]): string[] => r.map((p) => p.packageId).sort();
const MAX_UPDATED = truth.map((t) => t.date_updated).sort().at(-1)!;

function adapterWith(known: Record<string, string> = {}): HexiumAdapter {
  return new HexiumAdapter(config, { getAllKnownVersions: async () => new Map(Object.entries(known)) });
}

function ok(r: PollResult): Extract<PollResult, { status: 'ok' }> {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  return r;
}

function routes(dump = dumpFixture): FakeFetch {
  return createFakeFetch([
    [LISTING, () => text(listingFixture)],
    [DUMP, () => text(dump)],
  ]);
}

function nextCtx(fake: FakeFetch, prev: Extract<PollResult, { status: 'ok' }>, over: Partial<PollContext> = {}): PollContext {
  return makeCtx(fake, { state: makeState({ cursor: prev.cursor, bootstrapped: true }), ...over });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('parseCursor', () => {
  it('distinguishes seed progress, timestamps and junk', () => {
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor('')).toBeNull();
    expect(parseCursor('garbage')).toBeNull();
    expect(parseCursor('2026-09-20T05:18:45Z')).toEqual({ kind: 'time', iso: '2026-09-20T05:18:45.000000Z' });
    expect(parseCursor('seed:2:2026-09-20T05:18:45.000000Z')).toEqual({ kind: 'seed', next: 2, mark: '2026-09-20T05:18:45.000000Z' });
    expect(parseCursor('seed:x:1')).toBeNull();
  });
});

describe('HexiumAdapter.poll — initial seed', () => {
  it('seeds one slice per poll from the dump, carrying real flags, and never touches the listing', async () => {
    const fake = routes();
    const first = ok(await adapterWith().poll(makeCtx(fake, { state: null })));

    expect(ids(first.packages)).toEqual(truth.filter((t) => seq(t) % 4 === 0).map((t) => t.full_name).sort());
    expect(first.cursor).toBe(`seed:1:${MAX_UPDATED}`);
    expect(first.complete).toBe(false);
    expect(first.etag).toBeNull();
    expect(fake.callsTo('frontend/packages')).toHaveLength(0);
    for (const p of first.packages) {
      const t = truth.find((x) => x.full_name === p.packageId)!;
      expect(p).toMatchObject({ store: 'hexium', source: 'hexium:valheim', isNsfw: t.has_nsfw_content, isDeprecated: t.is_deprecated, updatedAt: t.date_updated });
      expect(p.url).toBe(`${ORIGIN}/mods/${p.owner}/${p.name}`);
    }
  });

  it('walks every slice, then hands over a plain timestamp cursor equal to the first slice mark', async () => {
    const fake = routes();
    const seen: string[] = [];
    let prev = ok(await adapterWith().poll(makeCtx(fake, { state: null })));
    seen.push(...ids(prev.packages));
    for (let slice = 1; slice < 4; slice += 1) {
      expect(prev.complete).toBe(false);
      prev = ok(await adapterWith().poll(nextCtx(fake, prev, { state: makeState({ cursor: prev.cursor, bootstrapped: slice === 1 }) })));
      seen.push(...ids(prev.packages));
    }
    expect(prev.complete).toBe(true);
    expect(prev.cursor).toBe(MAX_UPDATED);
    expect(seen.sort()).toEqual(truth.map((t) => t.full_name).sort());
  });

  it('keeps the first slice mark even when the dump moves on between slices', async () => {
    const first = ok(await adapterWith().poll(makeCtx(routes(), { state: null })));
    const bumped = dumpFixture.replace(truth[0]!.date_updated, '2030-01-01T00:00:00.000000Z');
    const next = ok(await adapterWith().poll(nextCtx(routes(bumped), first)));
    expect(next.cursor).toBe(`seed:2:${MAX_UPDATED}`);
  });

  it('flags NSFW packages in the seed', async () => {
    const marker = '"has_nsfw_content":false';
    const at = dumpFixture.indexOf(marker);
    const flipped = dumpFixture.slice(0, at) + '"has_nsfw_content":true' + dumpFixture.slice(at + marker.length);
    const target = truth[0]!;
    const index = seq(target) % 4;
    let res = ok(await adapterWith().poll(makeCtx(routes(flipped), { state: null })));
    for (let i = 1; i <= index; i += 1) res = ok(await adapterWith().poll(nextCtx(routes(flipped), res)));
    expect(res.packages.find((p) => p.packageId === target.full_name)?.isNsfw).toBe(true);
  });

  it('is skipped, not thrown, on an unusable dump or upstream errors', async () => {
    for (const responder of [
      () => text('<html>maintenance</html>'),
      () => text(JSON.stringify(truth, null, 2)),
      () => new Response('', { status: 502 }),
      () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
      () => Promise.reject(new TypeError('down')),
      () => text(dumpFixture.replace(/,"has_nsfw_content":/g, ',"nsfw":')),
    ]) {
      const fake = createFakeFetch([[DUMP, responder]]);
      await expect(adapterWith().poll(makeCtx(fake, { state: null }))).resolves.toEqual({ status: 'skipped' });
    }
  });

  it('seeds when a bootstrapped source has no cursor', async () => {
    const res = ok(await adapterWith().poll(makeCtx(routes(), { state: makeState({ cursor: null }) })));
    expect(res.cursor?.startsWith('seed:1:')).toBe(true);
  });
});

describe('HexiumAdapter.poll — steady state', () => {
  const cursor = '2026-09-20T02:00:00.000000Z';
  const state = makeState({ cursor, etag: '"h1"' });

  it('scans the dump on ticks 0, 3 and 6 and returns only records at or after the cursor, with full detail', async () => {
    for (const tickIndex of [0, 3, 6]) {
      const fake = routes();
      const res = ok(await adapterWith().poll(makeCtx(fake, { tickIndex, state })));
      const expected = truth.filter((t) => t.date_updated >= cursor).map((t) => t.full_name).sort();
      expect(ids(res.packages)).toEqual(expected);
      expect(res.cursor).toBe(MAX_UPDATED);
      expect(res.complete).toBe(true);
      expect(res.etag).toBe('"h1"');
      expect(fake.callsTo('frontend/packages')).toHaveLength(0);
      expect(fake.callsTo('/api/v1/package/')).toHaveLength(1);
      expect(res.packages.every((p) => p.description !== null && p.iconUrl !== null && p.sizeBytes !== null)).toBe(true);
    }
  });

  it('polls only the listing on the other ticks and leaves the cursor untouched', async () => {
    for (const tickIndex of [1, 2, 4, 5]) {
      const fake = routes();
      const res = ok(await adapterWith().poll(makeCtx(fake, { tickIndex, state })));
      expect(fake.callsTo('/api/v1/package/')).toHaveLength(0);
      expect(fake.callsTo('frontend/packages')).toHaveLength(1);
      expect(res.packages).toHaveLength(4);
      expect(res.cursor).toBe(cursor);
    }
  });

  it('maps listing NSFW and deprecated flags', async () => {
    const body = JSON.parse(listingFixture) as { packages: Record<string, unknown>[] };
    body.packages[0]!.has_nsfw_content = true;
    body.packages[1]!.is_deprecated = true;
    const fake = createFakeFetch([[LISTING, () => json(body)]]);
    const res = ok(await adapterWith().poll(makeCtx(fake, { tickIndex: 1, state })));
    expect(res.packages[0]).toMatchObject({ packageId: 'GenesisMods-zzzGenesisItemStacks', isNsfw: true, url: 'https://valheim.hexium.gg/mods/GenesisMods/zzzGenesisItemStacks' });
    expect(res.packages[1]?.isDeprecated).toBe(true);
    expect(res.packages[2]?.isNsfw).toBe(false);
  });

  it('honours a 304 on listing ticks and stores a returned ETag', async () => {
    const notModified = createFakeFetch([[LISTING, () => new Response(null, { status: 304 })]]);
    await expect(adapterWith().poll(makeCtx(notModified, { tickIndex: 1, state }))).resolves.toEqual({ status: 'not-modified', etag: '"h1"' });
    expect(notModified.calls[0]?.headers['if-none-match']).toBe('"h1"');

    const fresh = createFakeFetch([[LISTING, () => text(listingFixture, { etag: '"h2"' })]]);
    expect(ok(await adapterWith().poll(makeCtx(fresh, { tickIndex: 1, state }))).etag).toBe('"h2"');
  });

  it('never sends a conditional request for the dump', async () => {
    const fake = routes();
    await adapterWith().poll(makeCtx(fake, { tickIndex: 0, state }));
    expect(fake.callsTo('/api/v1/package/')[0]?.headers['if-none-match']).toBeUndefined();
  });

  it('falls back to the listing when the dump fails or changes shape', async () => {
    for (const responder of [() => new Response('', { status: 500 }), () => text(JSON.stringify(truth, null, 2))]) {
      const fake = createFakeFetch([
        [LISTING, () => text(listingFixture)],
        [DUMP, responder],
      ]);
      const res = ok(await adapterWith().poll(makeCtx(fake, { tickIndex: 0, state })));
      expect(res.packages).toHaveLength(4);
      expect(res.cursor).toBe(cursor);
    }
  });

  it('holds the cursor back and reports incomplete when a matched record is unreadable', async () => {
    const broken = dumpFixture.replace(',"has_nsfw_content":', ',"nsfw":');
    const res = ok(await adapterWith().poll(makeCtx(routes(broken), { tickIndex: 0, state: makeState({ cursor: '2020-01-01T00:00:00.000000Z' }) })));
    expect(res.complete).toBe(false);
    expect(res.cursor).toBe('2020-01-01T00:00:00.000000Z');
    expect(res.packages).toHaveLength(truth.length - 1);
  });

  it('returns skipped on a listing failure when no dump scan is due', async () => {
    const fake = createFakeFetch([[LISTING, () => json({ items: [] })]]);
    await expect(adapterWith().poll(makeCtx(fake, { tickIndex: 1, state }))).resolves.toEqual({ status: 'skipped' });
  });

  it('always sends a User-Agent and never credentials', async () => {
    const fake = routes();
    const ctx = makeCtx(fake, { tickIndex: 3, state, secrets: { NEXUS_API_KEY: 'SECRET' } });
    await adapterWith().poll(ctx);
    await adapterWith().poll({ ...ctx, tickIndex: 1 });
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call.headers['user-agent']).toBe(ctx.userAgent);
      expect(call.headers.apikey).toBeUndefined();
      expect(call.headers.authorization).toBeUndefined();
      expect(new URL(call.url).hostname).toBe('valheim.hexium.gg');
    }
  });

  it('rejects a hostile community slug without touching the network', async () => {
    const evil = new HexiumAdapter({ ...config, community: 'x.evil.test/' }, { getAllKnownVersions: async () => new Map() });
    const fake = routes();
    await expect(evil.poll(makeCtx(fake, { state }))).resolves.toEqual({ status: 'skipped' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('HexiumAdapter.reconcile', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  const day = Math.floor(now.getTime() / 86_400_000);
  const slice = day % 4;
  const inSlice = truth.filter((t) => seq(t) % 4 === slice);

  it('returns the day’s slice with full detail for changed or unknown packages and lean records otherwise', async () => {
    const [changed, same, ...rest] = inSlice;
    expect(rest.length + 2).toBe(inSlice.length);
    const known: Record<string, string> = {};
    const leanVersion = (name: string): string => {
      const at = dumpFixture.indexOf(`"full_name":"${name}"`);
      const vAt = dumpFixture.indexOf('"version_number":"', at);
      return dumpFixture.slice(vAt + 18, dumpFixture.indexOf('"', vAt + 18));
    };
    known[same!.full_name] = leanVersion(same!.full_name);
    known[changed!.full_name] = '0.0.0';

    const fake = routes();
    const out = await adapterWith(known).reconcile!(makeCtx(fake, { now }));
    expect(ids(out)).toEqual(inSlice.map((t) => t.full_name).sort());
    expect(out.find((p) => p.packageId === same!.full_name)?.description).toBeNull();
    expect(out.find((p) => p.packageId === changed!.full_name)?.description).not.toBeNull();
    for (const p of out) {
      const t = truth.find((x) => x.full_name === p.packageId)!;
      expect(p.isNsfw).toBe(t.has_nsfw_content);
      expect(p.isDeprecated).toBe(t.is_deprecated);
    }
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe(DUMP);
  });

  it('rotates through all slices on consecutive days', async () => {
    const seen = new Set<string>();
    for (let d = 0; d < 4; d += 1) {
      const out = await adapterWith().reconcile!(makeCtx(routes(), { now: new Date(now.getTime() + d * 86_400_000) }));
      out.forEach((p) => seen.add(p.packageId));
    }
    expect([...seen].sort()).toEqual(truth.map((t) => t.full_name).sort());
  });

  it('throws on upstream failure or an unusable body rather than returning an empty sweep', async () => {
    for (const responder of [() => new Response('', { status: 503 }), () => text('<html>maintenance</html>')]) {
      const fake = createFakeFetch([[DUMP, responder]]);
      await expect(adapterWith().reconcile!(makeCtx(fake, { now }))).rejects.toThrow();
    }
  });
});

describe('HexiumAdapter.fetchChangelog', () => {
  const pkg = {
    source: 'hexium:valheim',
    store: 'hexium' as const,
    packageId: 'denikson-BepInExPack_Valheim',
    owner: 'denikson',
    name: 'BepInExPack_Valheim',
    version: '5.4.2350',
    url: 'https://valheim.hexium.gg/mods/denikson/BepInExPack_Valheim',
    iconUrl: null,
    description: null,
    categories: [],
    isNsfw: false,
    isDeprecated: false,
    updatedAt: '2026-09-09T12:30:12.000000Z',
    sizeBytes: null,
  };

  it('reads the changelog from the game host and links back to the package page', async () => {
    const fake = createFakeFetch([
      [`${ORIGIN}/api/experimental/package/denikson/BepInExPack_Valheim/5.4.2350/changelog/`, () => json({ markdown: '## Changelog\n\n### 5.4.2350\n\nUpdated to BepInEx 5.4.23.5.\n' })],
    ]);
    const out = await adapterWith().fetchChangelog(makeCtx(fake), pkg, '5.4.2350');
    expect(out.url).toBe(pkg.url);
    expect(out.excerpt).toContain('Updated to BepInEx');
    expect(fake.calls[0]?.headers['user-agent']).toBeTruthy();
  });

  it('returns nulls on failure', async () => {
    const fake = createFakeFetch([['/changelog/', () => new Response('', { status: 500 })]]);
    expect(await adapterWith().fetchChangelog(makeCtx(fake), pkg, '5.4.2350')).toEqual({ excerpt: null, url: null });
  });
});
