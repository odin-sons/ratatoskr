// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PollContext, PollResult } from '../core/ports.ts';
import type { SourceConfig } from '../core/types.ts';
import { dump, stampFor } from './__fixtures__/dump-gen.ts';
import { createFakeFetch, fixture, json, makeCtx as baseCtx, makeState, text, type FakeFetch } from './__fixtures__/fake-fetch.ts';
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

const FIXTURE_NOW = new Date('2026-09-20T12:00:00Z');

function makeCtx(fake: FakeFetch, over: Partial<PollContext> = {}): PollContext {
  return baseCtx(fake, { now: FIXTURE_NOW, ...over });
}

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
    expect(parseCursor('seed:1:junk')).toEqual({ kind: 'seed', next: 1, mark: null });
    expect(parseCursor('seed:1:')).toEqual({ kind: 'seed', next: 1, mark: null });
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

  it('skips an unreadable matched record and still advances the cursor', async () => {
    const broken = dumpFixture.replace(',"has_nsfw_content":', ',"nsfw":');
    const res = ok(await adapterWith().poll(makeCtx(routes(broken), { tickIndex: 0, state: makeState({ cursor: '2020-01-01T00:00:00.000000Z' }) })));
    expect(res.complete).toBe(true);
    expect(res.cursor).toBe(MAX_UPDATED);
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

describe('HexiumAdapter — unreadable records are quarantined', () => {
  const warnings = (): string[] => vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
  const names = (from: number, to: number, skip: number[] = []): string[] =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)
      .filter((n) => !skip.includes(n))
      .map((n) => `Owner${n}-P${n}`)
      .sort();

  it('seeds through an unreadable record, reaches a plain cursor, and logs one count-only line per affected poll', async () => {
    const fake = routes(dump(20, (n) => (n === 5 ? { versions: 0 } : {})));
    let res = ok(await adapterWith().poll(makeCtx(fake, { state: null })));
    const seen = ids(res.packages);
    for (let slice = 1; slice < 4; slice += 1) {
      expect(res.complete).toBe(false);
      res = ok(await adapterWith().poll(nextCtx(fake, res, { state: makeState({ cursor: res.cursor, bootstrapped: slice === 1 }) })));
      seen.push(...ids(res.packages));
    }
    expect(res.complete).toBe(true);
    expect(res.cursor).toBe(stampFor(20));
    expect(seen.sort()).toEqual(names(1, 20, [5]));
    const lines = warnings().filter((line) => line.includes('unreadable'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/unreadable dump records skipped: 1$/);
    expect(lines[0]).not.toContain('Owner5');
  });

  it('advances the cursor past an unreadable record in steady state and stops re-reading the records behind it', async () => {
    const fake = routes(dump(10, (n) => (n === 5 ? { versions: 0 } : {})));
    const first = ok(await adapterWith().poll(makeCtx(fake, { tickIndex: 0, state: makeState({ cursor: stampFor(0) }) })));
    expect(first.complete).toBe(true);
    expect(first.cursor).toBe(stampFor(10));
    expect(ids(first.packages)).toEqual(names(1, 10, [5]));
    expect(warnings().filter((line) => line.includes('unreadable'))).toHaveLength(1);

    const second = ok(await adapterWith().poll(nextCtx(fake, first, { tickIndex: 0 })));
    expect(ids(second.packages)).toEqual(names(10, 10));
    expect(second.cursor).toBe(stampFor(10));
  });

  it('holds the cursor and falls back to the listing when no matched record is readable', async () => {
    const fake = routes(dump(10, () => ({ versions: 0 })));
    const res = ok(await adapterWith().poll(makeCtx(fake, { tickIndex: 0, state: makeState({ cursor: stampFor(0) }) })));
    expect(res.cursor).toBe(stampFor(0));
    expect(res.packages).toHaveLength(4);
    expect(fake.callsTo('frontend/packages')).toHaveLength(1);
  });
});

describe('HexiumAdapter — cursor validation', () => {
  const state = (cursor: string) => makeState({ cursor });

  it('never moves the cursor backwards', async () => {
    const cursor = '2026-06-01T00:00:00.000000Z';
    const res = ok(await adapterWith().poll(makeCtx(routes(dump(10)), { tickIndex: 0, state: state(cursor) })));
    expect(res.cursor).toBe(cursor);
    expect(res.packages).toEqual([]);
  });

  it('keeps a far-future record out of the cursor but still reports it', async () => {
    const text = dump(5, (n) => (n === 3 ? { updated: '2999-01-01T00:00:00.000000Z' } : {}));
    const res = ok(await adapterWith().poll(makeCtx(routes(text), { tickIndex: 0, state: state(stampFor(0)) })));
    expect(res.cursor).toBe(stampFor(5));
    expect(ids(res.packages)).toContain('Owner3-P3');
  });

  it('accepts a stamp up to an hour ahead of now and rejects one beyond', async () => {
    const at = (iso: string) => routes(dump(3, (n) => (n === 2 ? { updated: iso } : {})));
    const now = new Date('2026-09-19T00:05:00Z');
    const within = ok(await adapterWith().poll(makeCtx(at('2026-09-19T01:00:00.000000Z'), { tickIndex: 0, now, state: state(stampFor(0)) })));
    expect(within.cursor).toBe('2026-09-19T01:00:00.000000Z');
    const beyond = ok(await adapterWith().poll(makeCtx(at('2026-09-19T01:20:00.000000Z'), { tickIndex: 0, now, state: state(stampFor(0)) })));
    expect(beyond.cursor).toBe(stampFor(3));
  });

  it('skips a record with a garbage stamp without poisoning the cursor', async () => {
    const text = dump(5, (n) => (n === 3 ? { updatedField: '"zzzzzzzzzzTzzzzzzzzzzzzzzzZ"' } : {}));
    const res = ok(await adapterWith().poll(makeCtx(routes(text), { tickIndex: 0, state: state(stampFor(0)) })));
    expect(res.cursor).toBe(stampFor(5));
    expect(ids(res.packages)).toEqual(['Owner1-P1', 'Owner2-P2', 'Owner4-P4', 'Owner5-P5']);
  });

  it('keeps a far-future record out of the seed mark', async () => {
    const text = dump(20, (n) => (n === 3 ? { updated: '2999-01-01T00:00:00.000000Z' } : {}));
    const res = ok(await adapterWith().poll(makeCtx(routes(text), { state: null })));
    expect(res.cursor).toBe(`seed:1:${stampFor(20)}`);
  });

  it('clamps a stored cursor from the future to now, so newer records are not skipped forever', async () => {
    const text = dump(5, (n) => (n === 3 ? { updated: '2026-09-20T12:30:00.000000Z' } : {}));
    const res = ok(await adapterWith().poll(makeCtx(routes(text), { tickIndex: 0, state: state('2099-01-01T00:00:00.000000Z') })));
    expect(ids(res.packages)).toEqual(['Owner3-P3']);
    expect(res.cursor).toBe('2026-09-20T12:30:00.000000Z');
  });

  it('holds a clamped cursor at now when nothing newer exists', async () => {
    const res = ok(await adapterWith().poll(makeCtx(routes(dump(5)), { tickIndex: 0, state: state('2099-01-01T00:00:00.000000Z') })));
    expect(res.packages).toEqual([]);
    expect(res.cursor).toBe('2026-09-20T12:00:00.000000Z');
  });

  it('leaves a cursor within the future slack untouched', async () => {
    const cursor = '2026-09-20T12:30:00.000000Z';
    const res = ok(await adapterWith().poll(makeCtx(routes(dump(5)), { tickIndex: 0, state: state(cursor) })));
    expect(res.cursor).toBe(cursor);
  });

  it('clamps a seed mark from the future while seeding', async () => {
    const res = ok(await adapterWith().poll(makeCtx(routes(dump(20)), { state: makeState({ cursor: 'seed:1:2099-01-01T00:00:00.000000Z', bootstrapped: false }) })));
    expect(res.cursor).toBe('seed:2:2026-09-20T12:00:00.000000Z');
  });

  it('ends the seed on a clamped mark', async () => {
    const res = ok(await adapterWith().poll(makeCtx(routes(dump(20)), { state: makeState({ cursor: 'seed:3:2099-01-01T00:00:00.000000Z', bootstrapped: false }) })));
    expect(res.cursor).toBe('2026-09-20T12:00:00.000000Z');
    expect(res.complete).toBe(true);
  });

  it('ignores a garbage seed mark and recomputes it', async () => {
    const res = ok(await adapterWith().poll(makeCtx(routes(dump(20)), { state: makeState({ cursor: 'seed:1:zzzz', bootstrapped: false }) })));
    expect(res.cursor).toBe(`seed:2:${stampFor(20)}`);
  });
});

describe('HexiumAdapter — listing flags fail closed', () => {
  const state = makeState({ cursor: '2026-09-20T02:00:00.000000Z' });

  async function listing(mutate: (item: Record<string, unknown>) => void) {
    const body = JSON.parse(listingFixture) as { packages: Record<string, unknown>[] };
    mutate(body.packages[0]!);
    const fake = createFakeFetch([[LISTING, () => json(body)]]);
    return ok(await adapterWith().poll(makeCtx(fake, { tickIndex: 1, state })));
  }

  it.each([
    ['missing', (item: Record<string, unknown>) => void delete item.has_nsfw_content],
    ['null', (item: Record<string, unknown>) => void (item.has_nsfw_content = null)],
    ['a string', (item: Record<string, unknown>) => void (item.has_nsfw_content = 'false')],
    ['a number', (item: Record<string, unknown>) => void (item.has_nsfw_content = 0)],
  ])('marks an item NSFW when its flag is %s', async (_label, mutate) => {
    const res = await listing(mutate);
    expect(res.packages[0]?.isNsfw).toBe(true);
    expect(res.packages[1]?.isNsfw).toBe(false);
  });

  it('treats a non-boolean deprecated flag as not deprecated', async () => {
    const res = await listing((item) => void (item.is_deprecated = 'yes'));
    expect(res.packages[0]?.isDeprecated).toBe(false);
  });

  it('leaves previousVersion unknown for listing items', async () => {
    const res = await listing(() => {});
    expect(res.packages.every((p) => p.previousVersion === undefined)).toBe(true);
  });
});

describe('HexiumAdapter — previousVersion', () => {
  it('is carried from the dump history into steady-state snapshots and unknown for lean seeds', async () => {
    const fake = routes(dump(12));
    const steady = ok(await adapterWith().poll(makeCtx(fake, { tickIndex: 0, state: makeState({ cursor: stampFor(0) }) })));
    const byId = new Map(steady.packages.map((p) => [p.packageId, p]));
    expect(byId.get('Owner3-P3')).toMatchObject({ version: '1.0.3', previousVersion: '1.0.2' });
    expect(byId.get('Owner6-P6')).toMatchObject({ version: '1.0.0', previousVersion: null });

    const seed = ok(await adapterWith().poll(makeCtx(fake, { state: null })));
    expect(seed.packages.length).toBeGreaterThan(0);
    expect(seed.packages.every((p) => p.previousVersion === undefined)).toBe(true);
  });
});

describe('HexiumAdapter.reconcile — slice hint', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  const sliceOf = (index: number) => truth.filter((t) => seq(t) % 4 === index).map((t) => t.full_name).sort();

  it('uses sliceHint modulo the slice count instead of the day', async () => {
    for (const [hint, index] of [[0, 0], [1, 1], [2, 2], [3, 3], [6, 2], [7, 3]] as const) {
      const out = await adapterWith().reconcile!(makeCtx(routes(), { now, sliceHint: hint }));
      expect(ids(out), `hint ${hint}`).toEqual(sliceOf(index));
    }
  });

  it('covers every slice when the same day runs with consecutive hints', async () => {
    const seen = new Set<string>();
    for (let hint = 10; hint < 14; hint += 1) {
      (await adapterWith().reconcile!(makeCtx(routes(), { now, sliceHint: hint }))).forEach((p) => seen.add(p.packageId));
    }
    expect([...seen].sort()).toEqual(truth.map((t) => t.full_name).sort());
  });

  it('falls back to the day-based slice without a hint', async () => {
    const out = await adapterWith().reconcile!(makeCtx(routes(), { now }));
    expect(ids(out)).toEqual(sliceOf(Math.floor(now.getTime() / 86_400_000) % 4));
  });
});

describe('HexiumAdapter.fetchChangelog — size cap', () => {
  const pkg = {
    source: 'hexium:valheim',
    store: 'hexium' as const,
    packageId: 'a-b',
    owner: 'a',
    name: 'b',
    version: '1.0.0',
    url: `${ORIGIN}/mods/a/b`,
    iconUrl: null,
    description: null,
    categories: [],
    isNsfw: false,
    isDeprecated: false,
    updatedAt: '2026-09-09T12:30:12.000000Z',
    sizeBytes: null,
  };

  it('refuses a changelog body above the changelog cap without parsing it', async () => {
    const huge = JSON.stringify({ markdown: `## 1.0.0\n${'- entry\n'.repeat(60_000)}` });
    expect(huge.length).toBeGreaterThan(300_000);
    const fake = createFakeFetch([['/changelog/', () => text(huge)]]);
    const spy = vi.spyOn(JSON, 'parse');
    expect(await adapterWith().fetchChangelog(makeCtx(fake), pkg, '1.0.0')).toEqual({ excerpt: null, url: null });
    expect(spy).not.toHaveBeenCalled();
  });

  it('still reads a changelog just below the cap', async () => {
    const body = JSON.stringify({ markdown: `## 1.0.0\n- fixed a thing\n${'x'.repeat(100_000)}` });
    const fake = createFakeFetch([['/changelog/', () => text(body)]]);
    expect((await adapterWith().fetchChangelog(makeCtx(fake), pkg, '1.0.0')).excerpt).toContain('fixed a thing');
  });
});
