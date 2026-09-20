// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceConfig } from '../core/types.ts';
import type { PollResult, SourceAdapter } from '../core/ports.ts';
import { createFakeFetch, fixture, json, makeCtx, makeState, text } from './__fixtures__/fake-fetch.ts';
import { VERSIONS_MAX_BYTES } from './budget.ts';
import { ThunderstoreAdapter } from './thunderstore.ts';

const config: SourceConfig = { id: 'thunderstore:valheim', store: 'thunderstore', community: 'valheim', enabled: true };
const adapter = new ThunderstoreAdapter(config);
const asAdapter: SourceAdapter = adapter;

const LISTING = 'api/cyberstorm/listing/valheim/';
const listingFixture = fixture('thunderstore-listing.json');
const versionsFixture = fixture('thunderstore-versions.json');

function versionsBody(version: string, created: string): unknown[] {
  return [
    { version_number: '0.0.1', datetime_created: '2020-01-01T00:00:00.000000Z' },
    { version_number: version, datetime_created: created },
  ];
}

interface Item {
  ns: string;
  name: string;
  updated: string;
  pinned?: boolean;
  nsfw?: boolean;
}

function listingBody(items: Item[], next = false): unknown {
  return {
    count: items.length,
    next: next ? 'https://thunderstore.io/next' : null,
    previous: null,
    results: items.map((i) => ({
      namespace: i.ns,
      name: i.name,
      last_updated: i.updated,
      is_pinned: i.pinned ?? false,
      is_nsfw: i.nsfw ?? false,
      is_deprecated: false,
      categories: [{ id: '1', name: 'Tools', slug: 'tools' }],
      description: 'd',
      icon_url: `https://cdn.test/${i.name}.png`,
      size: 1234,
    })),
  };
}

function stamp(minutesAgo: number): string {
  return new Date(Date.parse('2026-09-19T00:00:00Z') - minutesAgo * 60_000).toISOString().replace('Z', '000Z');
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function okResult(r: PollResult): Extract<PollResult, { status: 'ok' }> {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  return r;
}

describe('ThunderstoreAdapter.poll', () => {
  it('returns only items newer than the cursor, oldest first, resolving versions from the versions endpoint', async () => {
    const fake = createFakeFetch([
      [LISTING, () => text(listingFixture, { 'last-modified': 'Sat, 19 Sep 2026 00:01:03 GMT' })],
      ['Carturs_Compass_and_Clock/versions/', () => json(versionsBody('2.0.0', '2026-09-19T00:00:10.000000Z'))],
      ['Carturs_Map_Pins/versions/', () => text(versionsFixture)],
      ['TeamVibes/QuickPing/versions/', () => json(versionsBody('1.4.0', '2026-09-18T23:58:21.000000Z'))],
    ]);
    const ctx = makeCtx(fake, { state: makeState({ cursor: '2026-09-18T23:56:00.000000Z' }) });
    const res = okResult(await adapter.poll(ctx));

    expect(res.packages.map((p) => `${p.packageId}@${p.version}`)).toEqual([
      'TeamVibes-QuickPing@1.4.0',
      'Cartur-Carturs_Map_Pins@1.3.6',
      'Cartur-Carturs_Compass_and_Clock@2.0.0',
    ]);
    expect(res.cursor).toBe('2026-09-19T00:00:10.838261Z');
    expect(res.complete).toBe(true);
    expect(res.etag).toBe('lm:Sat, 19 Sep 2026 00:01:03 GMT');
  });

  it('maps listing fields to a PackageSnapshot', async () => {
    const fake = createFakeFetch([
      [LISTING, () => text(listingFixture)],
      ['Carturs_Map_Pins/versions/', () => text(versionsFixture)],
    ]);
    const ctx = makeCtx(fake, { state: makeState({ cursor: '2026-09-18T23:58:30.000000Z' }) });
    const res = okResult(await adapter.poll(ctx));
    const pin = res.packages.find((p) => p.name === 'Carturs_Map_Pins');
    expect(pin).toMatchObject({
      source: 'thunderstore:valheim',
      store: 'thunderstore',
      packageId: 'Cartur-Carturs_Map_Pins',
      owner: 'Cartur',
      name: 'Carturs_Map_Pins',
      version: '1.3.6',
      url: 'https://thunderstore.io/c/valheim/p/Cartur/Carturs_Map_Pins/',
      isNsfw: false,
      isDeprecated: false,
      updatedAt: '2026-09-18T23:58:52.651200Z',
      sizeBytes: 788022,
    });
    expect(pin?.categories.every((c) => typeof c === 'string')).toBe(true);
  });

  it('picks the newest version by creation time, not by array position', async () => {
    const fake = createFakeFetch([
      [LISTING, () => json(listingBody([{ ns: 'A', name: 'B', updated: stamp(10) }]))],
      [
        '/versions/',
        () =>
          json([
            { version_number: '1.0.0', datetime_created: '2026-01-01T00:00:00.000000Z' },
            { version_number: '1.0.2', datetime_created: stamp(10) },
            { version_number: '1.0.1', datetime_created: '2026-03-01T00:00:00.000000Z' },
          ]),
      ],
    ]);
    const res = okResult(await adapter.poll(makeCtx(fake, { state: makeState({ cursor: stamp(60) }) })));
    expect(res.packages[0]?.version).toBe('1.0.2');
  });

  it('maps is_nsfw to isNsfw', async () => {
    const fake = createFakeFetch([
      [LISTING, () => json(listingBody([{ ns: 'A', name: 'Spicy', updated: stamp(10), nsfw: true }]))],
      ['/versions/', () => json(versionsBody('1.0.0', stamp(10)))],
    ]);
    const res = okResult(await adapter.poll(makeCtx(fake, { state: makeState({ cursor: stamp(60) }) })));
    expect(res.packages[0]?.isNsfw).toBe(true);
  });

  it('round-trips Last-Modified and reports not-modified on 304', async () => {
    const first = createFakeFetch([[LISTING, () => text(listingFixture, { 'last-modified': 'Sat, 19 Sep 2026 00:01:03 GMT' })]]);
    const r1 = okResult(await adapter.poll(makeCtx(first, { state: makeState({ cursor: '2026-09-19T00:00:10.838261Z' }) })));
    expect(r1.packages).toEqual([]);
    expect(r1.etag).toBe('lm:Sat, 19 Sep 2026 00:01:03 GMT');

    const second = createFakeFetch([[LISTING, () => new Response(null, { status: 304 })]]);
    const r2 = await adapter.poll(makeCtx(second, { state: makeState({ etag: r1.etag }) }));
    expect(r2).toEqual({ status: 'not-modified', etag: r1.etag });
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.headers['if-modified-since']).toBe('Sat, 19 Sep 2026 00:01:03 GMT');
  });

  it('sends If-None-Match when the stored validator is a real ETag', async () => {
    const fake = createFakeFetch([[LISTING, () => new Response(null, { status: 304 })]]);
    await adapter.poll(makeCtx(fake, { state: makeState({ etag: '"v1"' }) }));
    expect(fake.calls[0]?.headers['if-none-match']).toBe('"v1"');
  });

  it('cold start resolves only the newest N items, sets the cursor to the page maximum and reports incomplete', async () => {
    const items: Item[] = Array.from({ length: 14 }, (_, i) => ({ ns: 'N', name: `M${i}`, updated: stamp(100 - i) }));
    const fake = createFakeFetch([
      [LISTING, () => json(listingBody(items), { headers: { etag: '"new"' } })],
      ['/versions/', () => json(versionsBody('1.0.0', '2026-09-18T00:00:00.000000Z'))],
    ]);
    const res = okResult(await adapter.poll(makeCtx(fake, { state: null })));
    expect(res.packages).toHaveLength(10);
    expect(res.packages.map((p) => p.name)).toEqual(['M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13']);
    expect(res.cursor).toBe(stamp(100 - 13));
    expect(res.complete).toBe(false);
    expect(res.etag).toBeNull();
    expect(fake.callsTo('/versions/')).toHaveLength(10);
  });

  it('caps version lookups in steady state, processes oldest first and keeps the old etag so the rest is refetched', async () => {
    const items: Item[] = Array.from({ length: 13 }, (_, i) => ({ ns: 'N', name: `M${i}`, updated: stamp(50 - i) }));
    const fake = createFakeFetch([
      [LISTING, () => json(listingBody(items), { headers: { etag: '"new"' } })],
      ['/versions/', () => json(versionsBody('1.0.0', '2026-09-18T00:00:00.000000Z'))],
    ]);
    const ctx = makeCtx(fake, { state: makeState({ cursor: stamp(120), etag: '"old"' }) });
    const res = okResult(await adapter.poll(ctx));
    expect(res.packages).toHaveLength(10);
    expect(res.cursor).toBe(stamp(50 - 9));
    expect(res.complete).toBe(false);
    expect(res.etag).toBe('"old"');
  });

  it('skips an item whose versions endpoint returns 404 and moves the cursor past it', async () => {
    const fake = createFakeFetch([
      [LISTING, () => json(listingBody([{ ns: 'A', name: 'Gone', updated: stamp(20) }, { ns: 'A', name: 'Ok', updated: stamp(10) }]))],
      ['A/Ok/versions/', () => json(versionsBody('2.0.0', stamp(10)))],
    ]);
    const res = okResult(await adapter.poll(makeCtx(fake, { state: makeState({ cursor: stamp(60) }) })));
    expect(res.packages.map((p) => p.name)).toEqual(['Ok']);
    expect(res.cursor).toBe(stamp(10));
    expect(res.complete).toBe(true);
  });

  it('defers on a transient versions failure without advancing the cursor past the failing item', async () => {
    const fake = createFakeFetch([
      [LISTING, () => json(listingBody([{ ns: 'A', name: 'First', updated: stamp(20) }, { ns: 'A', name: 'Second', updated: stamp(10) }]), { headers: { etag: '"new"' } })],
      ['A/First/versions/', () => json(versionsBody('1.0.0', stamp(20)))],
      ['A/Second/versions/', () => new Response('boom', { status: 500 })],
    ]);
    const ctx = makeCtx(fake, { state: makeState({ cursor: stamp(60), etag: '"old"' }) });
    const res = okResult(await adapter.poll(ctx));
    expect(res.packages.map((p) => p.name)).toEqual(['First']);
    expect(res.cursor).toBe(stamp(20));
    expect(res.complete).toBe(false);
    expect(res.etag).toBe('"old"');
  });

  it('defers a very recent item whose versions endpoint still shows an older release', async () => {
    const recent = new Date('2026-09-19T00:04:30Z');
    const updated = recent.toISOString().replace('Z', '000Z');
    const fake = createFakeFetch([
      [LISTING, () => json(listingBody([{ ns: 'A', name: 'Fresh', updated }]))],
      ['/versions/', () => json(versionsBody('1.0.0', '2026-09-10T00:00:00.000000Z'))],
    ]);
    const ctx = makeCtx(fake, { state: makeState({ cursor: stamp(60) }) });
    const res = okResult(await adapter.poll(ctx));
    expect(res.packages).toEqual([]);
    expect(res.cursor).toBe(stamp(60));
    expect(res.complete).toBe(false);
  });

  it('accepts a version older than last_updated once the update is no longer recent', async () => {
    const fake = createFakeFetch([
      [LISTING, () => json(listingBody([{ ns: 'A', name: 'Edited', updated: stamp(10) }]))],
      ['/versions/', () => json(versionsBody('1.0.0', '2026-09-10T00:00:00.000000Z'))],
    ]);
    const res = okResult(await adapter.poll(makeCtx(fake, { state: makeState({ cursor: stamp(60) }) })));
    expect(res.packages.map((p) => p.version)).toEqual(['1.0.0']);
  });

  it('fetches further listing pages while every unpinned item is newer than the cursor', async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => ({ ns: 'N', name: `P1_${i}`, updated: stamp(30 - i) }));
    const page2 = [{ ns: 'N', name: 'P2_0', updated: stamp(40) }, { ns: 'N', name: 'P2_old', updated: stamp(500) }];
    const fake = createFakeFetch([
      ['page=2', () => json(listingBody(page2, false))],
      [LISTING, () => json(listingBody(page1, true))],
      ['/versions/', () => json(versionsBody('1.0.0', '2026-09-01T00:00:00.000000Z'))],
    ]);
    const res = okResult(await adapter.poll(makeCtx(fake, { state: makeState({ cursor: stamp(100) }) })));
    expect(res.packages.map((p) => p.name)).toEqual(['P2_0', 'P1_0', 'P1_1', 'P1_2']);
    expect(fake.callsTo('page=')).toHaveLength(2);
  });

  it('caps listing pages and reports incomplete', async () => {
    const page = Array.from({ length: 2 }, (_, i) => ({ ns: 'N', name: `X${i}`, updated: stamp(30 - i) }));
    const fake = createFakeFetch([
      [LISTING, () => json(listingBody(page, true))],
      ['/versions/', () => json(versionsBody('1.0.0', '2026-09-01T00:00:00.000000Z'))],
    ]);
    const res = okResult(await adapter.poll(makeCtx(fake, { state: makeState({ cursor: stamp(100) }) })));
    expect(fake.callsTo('page=')).toHaveLength(3);
    expect(res.complete).toBe(false);
  });

  it('returns skipped instead of throwing on a changed payload', async () => {
    const fake = createFakeFetch([[LISTING, () => json({ detail: 'moved' })]]);
    await expect(adapter.poll(makeCtx(fake))).resolves.toEqual({ status: 'skipped' });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain('thunderstore:valheim');
  });

  it('returns skipped on non-JSON, 429 and network errors', async () => {
    const responders: Array<() => Response | Promise<Response>> = [
      () => text('<html>'),
      () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
      () => Promise.reject(new TypeError('network down')),
    ];
    for (const responder of responders) {
      const fake = createFakeFetch([[LISTING, responder]]);
      await expect(adapter.poll(makeCtx(fake))).resolves.toEqual({ status: 'skipped' });
    }
  });

  it('returns skipped when the cold-start version lookup fails', async () => {
    const fake = createFakeFetch([
      [LISTING, () => json(listingBody([{ ns: 'A', name: 'B', updated: stamp(10) }]))],
      ['/versions/', () => new Response('', { status: 500 })],
    ]);
    await expect(adapter.poll(makeCtx(fake, { state: null }))).resolves.toEqual({ status: 'skipped' });
  });

  it('rejects a hostile community slug without touching the network', async () => {
    const evil = new ThunderstoreAdapter({ ...config, community: '../x?y' });
    const fake = createFakeFetch([]);
    await expect(evil.poll(makeCtx(fake))).resolves.toEqual({ status: 'skipped' });
    expect(fake.calls).toHaveLength(0);
  });

  it('sends the User-Agent on every request and no credentials to anyone', async () => {
    const fake = createFakeFetch([
      [LISTING, () => text(listingFixture)],
      ['/versions/', () => text(versionsFixture)],
    ]);
    const ctx = makeCtx(fake, { state: makeState({ cursor: '2026-09-18T23:56:00.000000Z' }), secrets: { NEXUS_API_KEY: 'SECRET' } });
    await adapter.poll(ctx);
    expect(fake.calls.length).toBeGreaterThan(1);
    for (const call of fake.calls) {
      expect(call.headers['user-agent']).toBe(ctx.userAgent);
      expect(call.headers.apikey).toBeUndefined();
      expect(call.headers.authorization).toBeUndefined();
      expect(new URL(call.url).hostname).toBe('thunderstore.io');
    }
  });

  it('has no reconcile', () => {
    expect(asAdapter.reconcile).toBeUndefined();
  });
});

describe('ThunderstoreAdapter.fetchChangelog', () => {
  const pkg = {
    source: 'thunderstore:valheim',
    store: 'thunderstore' as const,
    packageId: 'Cartur-Carturs_Map_Pins',
    owner: 'Cartur',
    name: 'Carturs_Map_Pins',
    version: '1.3.6',
    url: 'https://thunderstore.io/c/valheim/p/Cartur/Carturs_Map_Pins/',
    iconUrl: null,
    description: null,
    categories: [],
    isNsfw: false,
    isDeprecated: false,
    updatedAt: '2026-09-18T23:58:52.651200Z',
    sizeBytes: null,
  };

  it('extracts the section for the requested version and links to the full changelog', async () => {
    const fake = createFakeFetch([['/api/experimental/package/Cartur/Carturs_Map_Pins/1.3.6/changelog/', () => text(fixture('thunderstore-changelog.json'))]]);
    const out = await adapter.fetchChangelog(makeCtx(fake), pkg, '1.3.6');
    expect(out.url).toBe('https://thunderstore.io/c/valheim/p/Cartur/Carturs_Map_Pins/changelog/');
    expect(out.excerpt).toContain('No more duplicate pins');
    expect(fake.calls[0]?.headers['user-agent']).toBeTruthy();
  });

  it('returns nulls when the endpoint fails or the markdown is null', async () => {
    const failing = createFakeFetch([['/changelog/', () => new Response('', { status: 500 })]]);
    expect(await adapter.fetchChangelog(makeCtx(failing), pkg, '1.3.6')).toEqual({ excerpt: null, url: null });

    const empty = createFakeFetch([['/changelog/', () => json({ markdown: null })]]);
    const out = await adapter.fetchChangelog(makeCtx(empty), pkg, '1.3.6');
    expect(out.excerpt).toBeNull();
  });
});

describe('ThunderstoreAdapter.poll — backlog larger than the page cap', () => {
  interface Row {
    name: string;
    updated: string;
  }

  function server(rows: Row[], pageSize = 20) {
    const state = { rows: [...rows] };
    const sorted = (): Row[] => [...state.rows].sort((a, b) => (a.updated < b.updated ? 1 : -1));
    const responder = (call: { url: string }): Response => {
      const page = Number(new URL(call.url).searchParams.get('page') ?? '1');
      const all = sorted();
      const from = (page - 1) * pageSize;
      if (page > 1 && from >= all.length) return new Response('{"detail":"Invalid page."}', { status: 404 });
      const items = all.slice(from, from + pageSize).map((r) => ({ ns: 'N', name: r.name, updated: r.updated }));
      return json(listingBody(items, from + pageSize < all.length));
    };
    return { state, responder };
  }

  const older = (count: number): Row[] => Array.from({ length: count }, (_, i) => ({ name: `Old${i}`, updated: stamp(5000 + i) }));
  const updates = (count: number, first = 0): Row[] => Array.from({ length: count }, (_, i) => ({ name: `U${first + i}`, updated: stamp(1000 - (first + i)) }));

  async function drain(s: ReturnType<typeof server>, cursor: string, opts: { maxPolls?: number; between?: (poll: number) => void } = {}) {
    const emitted: string[] = [];
    const listingCalls: number[] = [];
    let current = makeState({ cursor });
    for (let poll = 0; poll < (opts.maxPolls ?? 60); poll += 1) {
      opts.between?.(poll);
      const fake = createFakeFetch([
        ['/versions/', () => json(versionsBody('1.0.0', '2026-01-01T00:00:00.000000Z'))],
        [LISTING, s.responder],
      ]);
      const res = okResult(await adapter.poll(makeCtx(fake, { state: current })));
      emitted.push(...res.packages.map((p) => p.name));
      listingCalls.push(fake.callsTo(LISTING).length);
      current = makeState({ cursor: res.cursor, etag: res.etag });
      if (res.complete && res.packages.length === 0) break;
    }
    return { emitted, listingCalls, cursor: current.cursor };
  }

  it('emits every update exactly once when 100 updates sit behind a cap of three 20-item pages', async () => {
    const s = server([...updates(100), ...older(30)]);
    const { emitted, listingCalls } = await drain(s, stamp(2000));
    expect(emitted.slice().sort()).toEqual(updates(100).map((r) => r.name).sort());
    expect(new Set(emitted).size).toBe(100);
    expect(Math.max(...listingCalls)).toBeLessThanOrEqual(3);
  });

  it('drains a 400-update backlog without loss within the per-poll page cap', async () => {
    const s = server([...updates(400), ...older(50)]);
    const { emitted, listingCalls } = await drain(s, stamp(2000), { maxPolls: 200 });
    expect(new Set(emitted).size).toBe(400);
    expect(emitted).toHaveLength(400);
    expect(Math.max(...listingCalls)).toBeLessThanOrEqual(3);
  });

  it('keeps every update while new updates keep arriving on top', async () => {
    const s = server([...updates(100), ...older(30)]);
    let arrived = 0;
    const { emitted } = await drain(s, stamp(2000), {
      between: (poll) => {
        if (poll >= 2 && poll < 6) {
          for (let i = 0; i < 3; i += 1) s.state.rows.push({ name: `Late${arrived}`, updated: stamp(500 - arrived) }), (arrived += 1);
        }
      },
    });
    const expected = [...updates(100).map((r) => r.name), ...Array.from({ length: arrived }, (_, i) => `Late${i}`)];
    expect(emitted.slice().sort()).toEqual(expected.sort());
    expect(new Set(emitted).size).toBe(expected.length);
  });

  it('does not advance the cursor past updates it has not seen', async () => {
    const s = server([...updates(100), ...older(30)]);
    const fake = createFakeFetch([
      ['/versions/', () => json(versionsBody('1.0.0', '2026-01-01T00:00:00.000000Z'))],
      [LISTING, s.responder],
    ]);
    const res = okResult(await adapter.poll(makeCtx(fake, { state: makeState({ cursor: stamp(2000) }) })));
    expect(res.complete).toBe(false);
    for (const p of res.packages) expect(p.updatedAt <= (res.cursor ?? '')).toBe(true);
    const cursorTime = (res.cursor ?? '').split('@')[0]!;
    const unseenOlder = updates(100).filter((r) => r.updated <= cursorTime && !res.packages.some((p) => p.name === r.name));
    expect(unseenOlder).toEqual([]);
  });

  it('recovers from a stale or garbage resume hint', async () => {
    const s = server([...updates(30), ...older(10)]);
    for (const hint of ['@50', '@abc', '@0', '@-3', '@']) {
      const fake = createFakeFetch([
        ['/versions/', () => json(versionsBody('1.0.0', '2026-01-01T00:00:00.000000Z'))],
        [LISTING, s.responder],
      ]);
      const res = okResult(await adapter.poll(makeCtx(fake, { state: makeState({ cursor: `${stamp(2000)}${hint}` }) })));
      expect(res.packages.length, hint).toBeGreaterThan(0);
    }
  });

  it('accepts a plain timestamp cursor written before resume hints existed', async () => {
    const s = server([...updates(5), ...older(5)]);
    const { emitted } = await drain(s, stamp(2000));
    expect(emitted.slice().sort()).toEqual(updates(5).map((r) => r.name).sort());
  });
});

describe('ThunderstoreAdapter.poll — versions size cap', () => {
  const history = (count: number): string =>
    JSON.stringify(
      Array.from({ length: count }, (_, i) => ({
        version_number: `1.0.${i}`,
        datetime_created: new Date(Date.UTC(2020, 0, 1) + i * 3_600_000).toISOString().replace('Z', '000Z'),
        download_url: `https://thunderstore.io/package/download/A/Big/1.0.${i}/`,
        install_url: `ror2mm://v1/install/thunderstore.io/A/Big/1.0.${i}/`,
      })),
    );
  const oversized = history(6000);
  const items: Item[] = [
    { ns: 'A', name: 'Big', updated: stamp(20) },
    { ns: 'A', name: 'Ok', updated: stamp(10) },
  ];
  const routes = (big: () => Response): ReturnType<typeof createFakeFetch> =>
    createFakeFetch([
      [LISTING, () => json(listingBody(items))],
      ['A/Big/versions/', big],
      ['A/Ok/versions/', () => json(versionsBody('2.0.0', stamp(10)))],
    ]);
  const warnings = (): string[] => vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));

  it('has a fixture above the cap and a long history below it', () => {
    expect(oversized.length).toBeGreaterThan(VERSIONS_MAX_BYTES);
    expect(history(1500).length).toBeLessThan(VERSIONS_MAX_BYTES);
  });

  it.each([
    ['streamed', () => text(oversized)],
    ['declared', () => text(oversized, { 'content-length': String(oversized.length) })],
  ])('skips a package whose versions body is oversized (%s), like a 404, and moves the cursor past it', async (_how, big) => {
    const res = okResult(await adapter.poll(makeCtx(routes(big), { state: makeState({ cursor: stamp(60) }) })));
    expect(res.packages.map((p) => p.name)).toEqual(['Ok']);
    expect(res.cursor).toBe(stamp(10));
    expect(res.complete).toBe(true);
    const lines = warnings().filter((line) => line.includes('versions'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('A-Big');
    expect(lines[0]).not.toContain('1.0.5999');
  });

  it('skips an oversized package on a cold start instead of failing the poll', async () => {
    const res = okResult(await adapter.poll(makeCtx(routes(() => text(oversized)), { state: null })));
    expect(res.packages.map((p) => p.name)).toEqual(['Ok']);
  });

  it('still reads a long history under the cap', async () => {
    const res = okResult(await adapter.poll(makeCtx(routes(() => text(history(1500))), { state: makeState({ cursor: stamp(60) }) })));
    expect(res.packages.map((p) => [p.name, p.version, p.previousVersion])).toEqual([
      ['Big', '1.0.1499', '1.0.1498'],
      ['Ok', '2.0.0', '0.0.1'],
    ]);
  });
});

describe('ThunderstoreAdapter.poll — stored cursor in the future', () => {
  const fresh = '2026-09-19T00:20:00.000000Z';
  const items: Item[] = [
    { ns: 'A', name: 'Fresh', updated: fresh },
    { ns: 'A', name: 'Old', updated: stamp(30) },
  ];
  const fake = (): ReturnType<typeof createFakeFetch> =>
    createFakeFetch([
      [LISTING, () => json(listingBody(items))],
      ['/versions/', () => json(versionsBody('1.0.0', fresh))],
    ]);

  it('clamps the cursor to now, so an update newer than now is not skipped forever', async () => {
    const res = okResult(await adapter.poll(makeCtx(fake(), { state: makeState({ cursor: '2099-01-01T00:00:00.000000Z' }) })));
    expect(res.packages.map((p) => p.name)).toEqual(['Fresh']);
    expect(res.cursor).toBe(fresh);
  });

  it('holds the cursor at now when nothing is newer', async () => {
    const quiet = createFakeFetch([[LISTING, () => json(listingBody([items[1]!]))]]);
    const res = okResult(await adapter.poll(makeCtx(quiet, { state: makeState({ cursor: '2099-01-01T00:00:00.000000Z' }) })));
    expect(res.packages).toEqual([]);
    expect(res.cursor).toBe('2026-09-19T00:05:00.000000Z');
  });

  it('keeps the resume page of a clamped cursor', async () => {
    const res = okResult(await adapter.poll(makeCtx(fake(), { state: makeState({ cursor: '2099-01-01T00:00:00.000000Z@3' }) })));
    expect(res.packages.map((p) => p.name)).toEqual(['Fresh']);
  });

  it('leaves a cursor within the future slack untouched', async () => {
    const cursor = '2026-09-19T00:30:00.000000Z';
    const quiet = createFakeFetch([[LISTING, () => json(listingBody([items[1]!]))]]);
    const res = okResult(await adapter.poll(makeCtx(quiet, { state: makeState({ cursor }) })));
    expect(res.cursor).toBe(cursor);
  });
});

describe('ThunderstoreAdapter.poll — previousVersion', () => {
  async function versions(body: unknown[]) {
    const fake = createFakeFetch([
      [LISTING, () => json(listingBody([{ ns: 'A', name: 'B', updated: stamp(10) }]))],
      ['/versions/', () => json(body)],
    ]);
    return okResult(await adapter.poll(makeCtx(fake, { state: makeState({ cursor: stamp(60) }) }))).packages[0];
  }

  it('is null when the package has a single version', async () => {
    expect((await versions([{ version_number: '1.0.0', datetime_created: stamp(10) }]))?.previousVersion).toBeNull();
  });

  it('is the second-newest version by creation time', async () => {
    const pkg = await versions([
      { version_number: '1.0.0', datetime_created: '2026-01-01T00:00:00.000000Z' },
      { version_number: '1.2.0', datetime_created: stamp(10) },
      { version_number: '1.1.0', datetime_created: '2026-03-01T00:00:00.000000Z' },
    ]);
    expect(pkg).toMatchObject({ version: '1.2.0', previousVersion: '1.1.0' });
  });

  it('ignores unusable entries when picking the previous version', async () => {
    const pkg = await versions([
      { version_number: '2.0.0', datetime_created: stamp(10) },
      { version_number: '', datetime_created: '2026-05-01T00:00:00.000000Z' },
      { version_number: '1.9.0', datetime_created: 'not a date' },
      { version_number: '1.8.0', datetime_created: '2026-02-01T00:00:00.000000Z' },
    ]);
    expect(pkg).toMatchObject({ version: '2.0.0', previousVersion: '1.8.0' });
  });

  it('matches the versions fixture ground truth', async () => {
    const fake = createFakeFetch([
      [LISTING, () => text(listingFixture)],
      ['Carturs_Map_Pins/versions/', () => text(versionsFixture)],
    ]);
    const res = okResult(await adapter.poll(makeCtx(fake, { state: makeState({ cursor: '2026-09-18T23:58:30.000000Z' }) })));
    expect(res.packages.find((p) => p.name === 'Carturs_Map_Pins')).toMatchObject({ version: '1.3.6', previousVersion: '1.3.2' });
  });
});

describe('ThunderstoreAdapter — NSFW fails closed', () => {
  async function flagged(mutate: (row: Record<string, unknown>) => void) {
    const body = listingBody([{ ns: 'A', name: 'Spicy', updated: stamp(10) }]) as { results: Record<string, unknown>[] };
    mutate(body.results[0]!);
    const fake = createFakeFetch([
      [LISTING, () => json(body)],
      ['/versions/', () => json(versionsBody('1.0.0', stamp(10)))],
    ]);
    return okResult(await adapter.poll(makeCtx(fake, { state: makeState({ cursor: stamp(60) }) }))).packages[0];
  }

  it.each([
    ['missing', (row: Record<string, unknown>) => void delete row.is_nsfw],
    ['null', (row: Record<string, unknown>) => void (row.is_nsfw = null)],
    ['a string', (row: Record<string, unknown>) => void (row.is_nsfw = 'false')],
    ['a number', (row: Record<string, unknown>) => void (row.is_nsfw = 0)],
  ])('marks a package NSFW when its flag is %s', async (_label, mutate) => {
    expect((await flagged(mutate))?.isNsfw).toBe(true);
  });

  it('keeps an explicit false as safe and treats a non-boolean deprecated flag as not deprecated', async () => {
    const pkg = await flagged((row) => void (row.is_deprecated = 'maybe'));
    expect(pkg).toMatchObject({ isNsfw: false, isDeprecated: false });
  });

  it('asks for non-NSFW, non-deprecated listings explicitly on every page', async () => {
    const page = Array.from({ length: 2 }, (_, i) => ({ ns: 'N', name: `X${i}`, updated: stamp(30 - i) }));
    const fake = createFakeFetch([
      [LISTING, () => json(listingBody(page, true))],
      ['/versions/', () => json(versionsBody('1.0.0', '2026-09-01T00:00:00.000000Z'))],
    ]);
    await adapter.poll(makeCtx(fake, { state: makeState({ cursor: stamp(100) }) }));
    const urls = fake.callsTo(LISTING).map((c) => new URL(c.url));
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) {
      expect(url.searchParams.get('nsfw')).toBe('false');
      expect(url.searchParams.get('deprecated')).toBe('false');
      expect(url.searchParams.get('ordering')).toBe('last-updated');
    }
  });
});

describe('ThunderstoreAdapter.fetchChangelog — size cap', () => {
  const pkg = {
    source: 'thunderstore:valheim',
    store: 'thunderstore' as const,
    packageId: 'A-B',
    owner: 'A',
    name: 'B',
    version: '1.0.0',
    url: 'https://thunderstore.io/c/valheim/p/A/B/',
    iconUrl: null,
    description: null,
    categories: [],
    isNsfw: false,
    isDeprecated: false,
    updatedAt: '2026-09-18T23:58:52.651200Z',
    sizeBytes: null,
  };

  it('refuses a changelog body above the changelog cap without parsing it', async () => {
    const huge = JSON.stringify({ markdown: `## 1.0.0\n${'- entry\n'.repeat(60_000)}` });
    expect(huge.length).toBeGreaterThan(300_000);
    const fake = createFakeFetch([['/changelog/', () => text(huge)]]);
    const parse = vi.spyOn(JSON, 'parse');
    expect(await adapter.fetchChangelog(makeCtx(fake), pkg, '1.0.0')).toEqual({ excerpt: null, url: null });
    expect(parse).not.toHaveBeenCalled();
  });
});
