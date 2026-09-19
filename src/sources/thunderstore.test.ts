// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceConfig } from '../core/types.ts';
import type { PollResult, SourceAdapter } from '../core/ports.ts';
import { createFakeFetch, fixture, json, makeCtx, makeState, text } from './__fixtures__/fake-fetch.ts';
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
