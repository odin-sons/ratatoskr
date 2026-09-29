// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CADENCE, CLOUDFLARE } from '../core/constants.ts';
import { diffSnapshots } from '../core/diff.ts';
import type { PollContext, PollResult } from '../core/ports.ts';
import type { SourceConfig } from '../core/types.ts';
import { indexLine, syntheticIndex } from './__fixtures__/index-gen.ts';
import { createFakeFetch, fixture, json, makeCtx as baseCtx, makeState, text, type FakeFetch, type RecordedCall } from './__fixtures__/fake-fetch.ts';
import { HEXIUM_INDEX_MAX_BYTES, HEXIUM_INDEX_MAX_LINES, HEXIUM_LOOKUP_MAX_BYTES, SOURCE_BUDGET } from './budget.ts';
import { HexiumAdapter } from './hexium.ts';
import { scanPackageIndex, seedSliceOf } from './hexium-index.ts';

const config: SourceConfig = { id: 'hexium:valheim', store: 'hexium', community: 'valheim', enabled: true };
const ORIGIN = 'https://valheim.hexium.gg';
const LISTING = `${ORIGIN}/api/experimental/frontend/packages/?page=1`;
const INDEX = `${ORIGIN}/api/experimental/package-index/`;
const LOOKUP_PREFIX = `${ORIGIN}/api/experimental/package/`;
const listingFixture = fixture('hexium-listing.json');
const realIndex = fixture('hexium-package-index.ndjson');
const lookupFixtures = {
  muji: fixture('hexium-package-muji-dynamicstorageforge.json'),
  bepinex: fixture('hexium-package-denikson-bepinexpack.json'),
  building: fixture('hexium-package-smoothbrain-building.json'),
};

const FIXTURE_NOW = new Date('2026-09-27T12:00:00Z');
const EVERY = CADENCE.hexiumIndexEveryNthTick;
const LISTING_TICK = 1;
const indexTick = (scan = 0): number => scan * EVERY;

interface Lookup {
  namespace: string;
  owner: string;
  name: string;
  full_name: string;
  package_url: string;
  date_updated: string;
  is_deprecated: unknown;
  latest: { version_number: string; description: unknown; icon: unknown };
  community_listings: Record<string, unknown>[];
  [key: string]: unknown;
}

function lookupBody(namespace: string, name: string, version: string, mutate: (body: Lookup) => void = () => {}): Lookup {
  const body = JSON.parse(lookupFixtures.muji) as Lookup;
  body.namespace = namespace;
  body.owner = namespace;
  body.name = name;
  body.full_name = `${namespace}-${name}`;
  body.package_url = `${ORIGIN}/mods/${namespace}/${name}`;
  body.latest.version_number = version;
  mutate(body);
  return body;
}

type LookupResponder = (namespace: string, name: string, call: RecordedCall) => Response | Promise<Response>;

function routes(over: { index?: string | (() => Response | Promise<Response>); listing?: string; lookup?: LookupResponder } = {}): FakeFetch {
  const index = over.index ?? realIndex;
  return createFakeFetch([
    [LISTING, () => text(over.listing ?? listingFixture)],
    [INDEX, typeof index === 'string' ? () => text(index) : index],
    [
      LOOKUP_PREFIX,
      (call) => {
        const [namespace = '', name = ''] = new URL(call.url).pathname.split('/').slice(4).map(decodeURIComponent);
        return over.lookup ? over.lookup(namespace, name, call) : new Response('{"detail":"Not found."}', { status: 404 });
      },
    ],
  ]);
}

/** Answers every lookup with a full snapshot at `version` (default: the version the index lists). */
const answerAll =
  (version = '2.0.0', mutate: (body: Lookup) => void = () => {}): LookupResponder =>
  (namespace, name) =>
    json(lookupBody(namespace, name, version, mutate));

function makeCtx(fake: FakeFetch, over: Partial<PollContext> = {}): PollContext {
  return baseCtx(fake, { now: FIXTURE_NOW, ...over });
}

function adapterWith(known: Record<string, string> | Map<string, string> = {}): HexiumAdapter {
  const map = known instanceof Map ? known : new Map(Object.entries(known));
  return new HexiumAdapter(config, { getAllKnownVersions: async () => map });
}

function ok(r: PollResult): Extract<PollResult, { status: 'ok' }> {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  return r;
}

const ids = (packages: { packageId: string }[]): string[] => packages.map((p) => p.packageId).sort();
const ownerIds = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `Owner${from + i}-Package${from + i}`).sort();
const allVersions = (count: number, version = '1.0.0'): Record<string, string> => Object.fromEntries(ownerIds(1, count).map((id) => [id, version]));
const warnings = (): string[] => vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
const lookupCalls = (fake: FakeFetch): RecordedCall[] => fake.callsTo(LOOKUP_PREFIX);

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('HexiumAdapter.poll — listing (every tick)', () => {
  const state = makeState({ cursor: null, etag: '"h1"' });

  it('polls only the listing on ticks that are not index ticks and returns its packages', async () => {
    for (const tickIndex of [1, 2, 4, 5]) {
      const fake = routes();
      const res = ok(await adapterWith().poll(makeCtx(fake, { tickIndex, state })));
      expect(fake.calls.map((c) => c.url)).toEqual([LISTING]);
      expect(res.packages).toHaveLength(4);
      expect(res.complete).toBe(true);
    }
  });

  it('leaves the stored cursor untouched', async () => {
    const stateWithCursor = makeState({ cursor: '2026-09-20T05:18:45.000000Z' });
    const res = ok(await adapterWith().poll(makeCtx(routes(), { tickIndex: LISTING_TICK, state: stateWithCursor })));
    expect(res.cursor).toBe('2026-09-20T05:18:45.000000Z');
  });

  it('maps listing NSFW and deprecated flags', async () => {
    const body = JSON.parse(listingFixture) as { packages: Record<string, unknown>[] };
    body.packages[0]!.has_nsfw_content = true;
    body.packages[1]!.is_deprecated = true;
    const res = ok(await adapterWith().poll(makeCtx(routes({ listing: JSON.stringify(body) }), { tickIndex: LISTING_TICK, state })));
    expect(res.packages[0]).toMatchObject({ packageId: 'GenesisMods-zzzGenesisItemStacks', isNsfw: true, url: 'https://valheim.hexium.gg/mods/GenesisMods/zzzGenesisItemStacks' });
    expect(res.packages[1]?.isDeprecated).toBe(true);
    expect(res.packages[2]?.isNsfw).toBe(false);
  });

  it('honours a 304 on listing ticks and stores a returned ETag', async () => {
    const notModified = createFakeFetch([[LISTING, () => new Response(null, { status: 304 })]]);
    await expect(adapterWith().poll(makeCtx(notModified, { tickIndex: LISTING_TICK, state }))).resolves.toEqual({ status: 'not-modified', etag: '"h1"' });
    expect(notModified.calls[0]?.headers['if-none-match']).toBe('"h1"');

    const fresh = createFakeFetch([[LISTING, () => text(listingFixture, { etag: '"h2"' })]]);
    expect(ok(await adapterWith().poll(makeCtx(fresh, { tickIndex: LISTING_TICK, state }))).etag).toBe('"h2"');
  });

  it('is skipped, not thrown, on a listing failure', async () => {
    for (const responder of [() => json({ items: [] }), () => new Response('', { status: 502 }), () => Promise.reject(new TypeError('down'))]) {
      const fake = createFakeFetch([[LISTING, responder]]);
      await expect(adapterWith().poll(makeCtx(fake, { tickIndex: LISTING_TICK, state }))).resolves.toEqual({ status: 'skipped' });
    }
  });

  it('always sends a User-Agent, never credentials, and only talks to the game host', async () => {
    const fake = routes({ index: syntheticIndex(6, () => '2.0.0'), lookup: answerAll() });
    const ctx = makeCtx(fake, { tickIndex: indexTick(1), state, secrets: { NEXUS_API_KEY: 'SECRET' } });
    await adapterWith(allVersions(6)).poll(ctx);
    await adapterWith().poll({ ...ctx, tickIndex: LISTING_TICK });
    expect(fake.calls.length).toBeGreaterThan(2);
    for (const call of fake.calls) {
      expect(call.headers['user-agent']).toBe(ctx.userAgent);
      expect(call.headers.apikey).toBeUndefined();
      expect(call.headers.authorization).toBeUndefined();
      expect(new URL(call.url).hostname).toBe('valheim.hexium.gg');
    }
  });

  it('rejects a hostile community slug without touching the network', async () => {
    const evil = new HexiumAdapter({ ...config, community: 'x.evil.test/' }, { getAllKnownVersions: async () => new Map() });
    for (const s of [state, null]) {
      const fake = routes();
      await expect(evil.poll(makeCtx(fake, { state: s }))).resolves.toEqual({ status: 'skipped' });
      expect(fake.calls).toHaveLength(0);
    }
    await expect(evil.reconcile!(makeCtx(routes()))).rejects.toThrow();
  });
});

describe('HexiumAdapter.poll — listing item flags fail closed', () => {
  const state = makeState({ cursor: null });

  async function listing(mutate: (item: Record<string, unknown>) => void) {
    const body = JSON.parse(listingFixture) as { packages: Record<string, unknown>[] };
    mutate(body.packages[0]!);
    return ok(await adapterWith().poll(makeCtx(routes({ listing: JSON.stringify(body) }), { tickIndex: LISTING_TICK, state })));
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

  it('quarantines an item whose deprecated flag is not a boolean and counts it in one warning', async () => {
    for (const bad of ['yes', 'false', null, 0, undefined]) {
      vi.mocked(console.warn).mockClear();
      const res = await listing((item) => void (item.is_deprecated = bad));
      expect(res.packages.map((p) => p.packageId), String(bad)).not.toContain('GenesisMods-zzzGenesisItemStacks');
      expect(res.packages, String(bad)).toHaveLength(3);
      const lines = warnings().filter((l) => l.includes('skipped: index lines'));
      expect(lines, String(bad)).toHaveLength(1);
      expect(lines[0]).toMatch(/listing items 1/);
      expect(lines[0]).not.toContain('GenesisMods');
      expect(res.warnings?.some((w) => /listing items 1/.test(w))).toBe(true);
    }
  });

  it('keeps an item with a boolean deprecated flag and warns about nothing', async () => {
    const res = await listing((item) => void (item.is_deprecated = true));
    expect(res.packages[0]).toMatchObject({ packageId: 'GenesisMods-zzzGenesisItemStacks', isDeprecated: true });
    expect(warnings()).toEqual([]);
    expect(res.warnings).toBeUndefined();
  });

  it('leaves previousVersion unknown for listing items', async () => {
    expect((await listing(() => {})).packages.every((p) => p.previousVersion === undefined)).toBe(true);
  });
});

describe('HexiumAdapter.poll — index scan finds version changes', () => {
  const state = makeState({ cursor: null, etag: '"h1"' });

  it('scans the index on ticks 0, N and 2N: one listing read, one index read, one lookup per changed package', async () => {
    for (const tickIndex of [indexTick(0), indexTick(1), indexTick(2)]) {
      const changed = new Set(['Owner3-Package3', 'Owner7-Package7']);
      const index = syntheticIndex(10, (n) => (changed.has(`Owner${n}-Package${n}`) ? '2.0.0' : '1.0.0'));
      const fake = routes({ index, lookup: answerAll('2.0.0') });
      const res = ok(await adapterWith(allVersions(10)).poll(makeCtx(fake, { tickIndex, state })));

      expect(fake.callsTo('frontend/packages')).toHaveLength(1);
      expect(fake.callsTo('package-index')).toHaveLength(1);
      expect(lookupCalls(fake).map((c) => new URL(c.url).pathname)).toEqual([
        '/api/experimental/package/Owner3/Package3/',
        '/api/experimental/package/Owner7/Package7/',
      ]);
      const fromLookups = res.packages.filter((p) => p.packageId.startsWith('Owner'));
      expect(ids(fromLookups)).toEqual(['Owner3-Package3', 'Owner7-Package7']);
      expect(res.packages).toHaveLength(4 + 2);
      expect(res.complete).toBe(true);
      expect(res.etag).toBeNull();
    }
  });

  it('makes no lookup and emits only listing packages when every indexed version matches the store', async () => {
    const fake = routes({ index: syntheticIndex(50), lookup: answerAll() });
    const res = ok(await adapterWith(allVersions(50)).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    expect(lookupCalls(fake)).toHaveLength(0);
    expect(res.packages).toHaveLength(4);
    expect(res.complete).toBe(true);
  });

  it('emits a full snapshot from the lookup, not from the lean index line', async () => {
    const fake = routes({ index: realIndex, lookup: (_ns, _name) => json(JSON.parse(lookupFixtures.muji)) });
    const res = ok(await adapterWith({ 'Muji-DynamicStorageForge': '1.0.0' }).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    const snapshot = res.packages.find((p) => p.packageId === 'Muji-DynamicStorageForge');
    expect(snapshot).toEqual({
      source: 'hexium:valheim',
      store: 'hexium',
      packageId: 'Muji-DynamicStorageForge',
      owner: 'Muji',
      name: 'DynamicStorageForge',
      version: '1.0.1',
      url: 'https://valheim.hexium.gg/mods/Muji/DynamicStorageForge',
      iconUrl: 'https://cdn.hexium.gg/upload/1686/icon.png?6470',
      description: expect.stringContaining('Dynamic forge storage'),
      categories: ['Client & Server'],
      isNsfw: false,
      isDeprecated: false,
      updatedAt: '2026-09-26T22:42:31.000000Z',
      sizeBytes: 216262,
      downloadUrl: 'https://cdn.hexium.gg/upload/1686/1.0.1.zip',
      downloads: 109,
      likes: 0,
      websiteUrl: 'https://discord.gg/THGNhtAYC8',
    });
    expect('previousVersion' in snapshot!).toBe(false);
  });

  it('reads the live lookup shapes, including multi-category packages, for the configured community', async () => {
    const bodies: Record<string, string> = { 'denikson/BepInExPack_Valheim': lookupFixtures.bepinex, 'Smoothbrain/Building': lookupFixtures.building };
    const fake = routes({ lookup: (ns, name) => json(bodies[`${ns}/${name}`] ?? '{}') });
    const known = { 'denikson-BepInExPack_Valheim': '5.4.2350', 'Smoothbrain-Building': '1.2.6' };
    const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    const byId = new Map(res.packages.map((p) => [p.packageId, p]));
    expect(byId.get('denikson-BepInExPack_Valheim')).toMatchObject({ version: '5.4.2351', categories: ['Valheim 1.0', 'Client & Server'], sizeBytes: 702924 });
    expect(byId.get('Smoothbrain-Building')).toMatchObject({ version: '1.2.7', categories: ['Quality of Life', 'Skill', 'Tools', 'Valheim 1.0', 'Client (& Server)'], sizeBytes: 107075 });
  });

  it('takes the lookup version as the truth when it differs from the index line', async () => {
    const fake = routes({ index: syntheticIndex(3, () => '2.0.0'), lookup: answerAll('2.0.1') });
    const res = ok(await adapterWith(allVersions(3)).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    expect(res.packages.filter((p) => p.packageId.startsWith('Owner')).every((p) => p.version === '2.0.1')).toBe(true);
  });

  it('never sends a conditional request for the index or a lookup', async () => {
    const fake = routes({ index: syntheticIndex(3, () => '2.0.0'), lookup: answerAll() });
    await adapterWith(allVersions(3)).poll(makeCtx(fake, { tickIndex: indexTick(1), state }));
    for (const call of [...fake.callsTo('package-index'), ...lookupCalls(fake)]) {
      expect(call.headers['if-none-match']).toBeUndefined();
      expect(call.headers['if-modified-since']).toBeUndefined();
    }
  });

  it('keeps the stored ETag and still scans the index when the listing answers 304 on an index tick', async () => {
    const fake = createFakeFetch([[LISTING, () => new Response(null, { status: 304 })], [INDEX, () => text(syntheticIndex(3, () => '2.0.0'))], [LOOKUP_PREFIX, () => json(lookupBody('Owner1', 'Package1', '2.0.0'))]]);
    const scanned = ok(await adapterWith(allVersions(3)).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    expect(scanned.packages.length).toBeGreaterThan(0);
    expect(scanned.etag).toBe('"h1"');
  });

  it('skips a genuinely new package the listing already delivered at the same version', async () => {
    const line = '{"namespace":"GenesisMods","name":"zzzGenesisItemStacks","version_number":"2.1.0","file_format":"zip","file_size":10,"dependencies":[],"suggestions":[]}';
    const fake = routes({ index: line, lookup: answerAll() });
    const res = ok(await adapterWith({}).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    expect(lookupCalls(fake)).toHaveLength(0);
    const pkg = res.packages.find((p) => p.packageId === 'GenesisMods-zzzGenesisItemStacks');
    expect(pkg?.version).toBe('2.1.0');
    expect(pkg?.downloadUrl).toBeNull();
  });

  it('still looks up a known package whose new version the listing already delivered this tick', async () => {
    // Regression: a package still on page 1 of the listing used to have its update
    // short-circuited by the delivered-dedup, committing a null downloadUrl forever.
    const line = '{"namespace":"GenesisMods","name":"zzzGenesisItemStacks","version_number":"2.1.0","file_format":"zip","file_size":10,"dependencies":[],"suggestions":[]}';
    const fake = routes({ index: line, lookup: answerAll('2.1.0') });
    const res = ok(await adapterWith({ 'GenesisMods-zzzGenesisItemStacks': '2.0.0' }).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    expect(lookupCalls(fake)).toHaveLength(1);
    const withLink = res.packages.find((p) => p.packageId === 'GenesisMods-zzzGenesisItemStacks' && p.downloadUrl !== null);
    expect(withLink).toMatchObject({ version: '2.1.0', downloadUrl: expect.stringContaining('hexium.gg') });
  });

  it('still looks a candidate up when the listing has it at another version', async () => {
    const line = '{"namespace":"GenesisMods","name":"zzzGenesisItemStacks","version_number":"2.2.0","file_format":"zip","file_size":10,"dependencies":[],"suggestions":[]}';
    const fake = routes({ index: line, lookup: answerAll('2.2.0') });
    await adapterWith({ 'GenesisMods-zzzGenesisItemStacks': '2.0.0' }).poll(makeCtx(fake, { tickIndex: indexTick(1), state }));
    expect(lookupCalls(fake)).toHaveLength(1);
  });
});

describe('HexiumAdapter.poll — packages the store has never seen', () => {
  const state = makeState({ cursor: null });

  it('looks up packages missing from the store after bootstrap and emits them', async () => {
    const fake = routes({ index: syntheticIndex(12, () => '1.0.0'), lookup: answerAll('1.0.0') });
    const known = allVersions(12);
    delete known['Owner4-Package4'];
    delete known['Owner9-Package9'];
    const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    expect(ids(res.packages.filter((p) => p.packageId.startsWith('Owner')))).toEqual(['Owner4-Package4', 'Owner9-Package9']);
  });

  it('turns them into new events and version changes of known packages into updates in the core diff', async () => {
    const index = syntheticIndex(6, (n) => (n === 2 ? '1.1.0' : '1.0.0'));
    const known = new Map(Object.entries(allVersions(6)));
    known.delete('Owner5-Package5');
    const fake = routes({ index, lookup: (ns, name) => json(lookupBody(ns, name, ns === 'Owner2' ? '1.1.0' : '1.0.0')) });
    const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    const { events } = diffSnapshots(known, res.packages.filter((p) => p.packageId.startsWith('Owner')), FIXTURE_NOW);
    expect(events.map((e) => [e.pkg.packageId, e.kind, e.versionFrom, e.versionTo]).sort()).toEqual([
      ['Owner2-Package2', 'update', '1.0.0', '1.1.0'],
      ['Owner5-Package5', 'new', null, '1.0.0'],
    ]);
  });
});

describe('HexiumAdapter.poll — lookup snapshots fail closed', () => {
  const state = makeState({ cursor: null });
  const known = { 'Owner1-Package1': '1.0.0' };

  async function withLookup(mutate: (body: Lookup) => void, version = '2.0.0') {
    const fake = routes({ index: syntheticIndex(1, () => version), lookup: answerAll(version, mutate) });
    const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    return { res, snapshot: res.packages.find((p) => p.packageId === 'Owner1-Package1') };
  }

  it('marks a package NSFW when its community entry is missing or belongs to another community', async () => {
    expect((await withLookup((b) => void (b.community_listings = []))).snapshot?.isNsfw).toBe(true);
    expect((await withLookup((b) => void (b.community_listings = [{ community: 'riskofrain2', categories: ['Tools'], has_nsfw_content: false }]))).snapshot?.isNsfw).toBe(true);
    expect((await withLookup((b) => void delete (b as Partial<Lookup>).community_listings)).snapshot?.isNsfw).toBe(true);
    expect((await withLookup((b) => void (b.community_listings = 'valheim' as unknown as Record<string, unknown>[]))).snapshot?.isNsfw).toBe(true);
  });

  it.each([
    ['missing', (entry: Record<string, unknown>) => void delete entry.has_nsfw_content],
    ['null', (entry: Record<string, unknown>) => void (entry.has_nsfw_content = null)],
    ['the string false', (entry: Record<string, unknown>) => void (entry.has_nsfw_content = 'false')],
    ['zero', (entry: Record<string, unknown>) => void (entry.has_nsfw_content = 0)],
    ['true', (entry: Record<string, unknown>) => void (entry.has_nsfw_content = true)],
  ])('marks a package NSFW when has_nsfw_content is %s', async (_label, mutate) => {
    expect((await withLookup((b) => mutate(b.community_listings[0]!))).snapshot?.isNsfw).toBe(true);
  });

  it('marks a package NSFW when any entry of the community is not exactly false', async () => {
    const entry = { community: 'valheim', categories: ['Tools'], has_nsfw_content: false };
    const { snapshot } = await withLookup((b) => void (b.community_listings = [entry, { ...entry, has_nsfw_content: true }]));
    expect(snapshot?.isNsfw).toBe(true);
  });

  it('reads categories only from the configured community entry and keeps only strings', async () => {
    const { snapshot } = await withLookup((b) => {
      b.community_listings = [
        { community: 'riskofrain2', categories: ['Other'], has_nsfw_content: false },
        { community: 'valheim', categories: ['Tools', 7, null, 'Client'], has_nsfw_content: false },
      ];
    });
    expect(snapshot).toMatchObject({ categories: ['Tools', 'Client'], isNsfw: false });
  });

  it('flags deprecation from the boolean and quarantines a non-boolean value', async () => {
    expect((await withLookup((b) => void (b.is_deprecated = true))).snapshot?.isDeprecated).toBe(true);
    for (const bad of [null, 'false', 0, undefined]) {
      const { snapshot } = await withLookup((b) => void (b.is_deprecated = bad));
      expect(snapshot, String(bad)).toBeUndefined();
    }
  });

  it('counts unreadable lookups in one line without naming packages', async () => {
    const fake = routes({ index: syntheticIndex(3, () => '2.0.0'), lookup: answerAll('2.0.0', (b) => void (b.is_deprecated = 'maybe')) });
    const res = ok(await adapterWith(allVersions(3)).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    expect(res.packages.filter((p) => p.packageId.startsWith('Owner'))).toEqual([]);
    expect(res.complete).toBe(false);
    const lines = warnings().filter((l) => l.includes('skipped: index lines'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/lookups unreadable 3/);
    expect(lines[0]).not.toContain('Owner');
  });

  it.each([
    ['owner', (b: Lookup) => void (b.owner = 'Someone')],
    ['name', (b: Lookup) => void (b.name = 'Other')],
    ['latest', (b: Lookup) => void (b.latest = null as unknown as Lookup['latest'])],
    ['version', (b: Lookup) => void (b.latest.version_number = '')],
    ['date_updated', (b: Lookup) => void (b.date_updated = 'yesterday')],
  ])('does not emit from a lookup with a wrong or unreadable %s', async (_label, mutate) => {
    expect((await withLookup(mutate)).snapshot).toBeUndefined();
  });

  it('maps missing description and icon to null and ignores non-string values', async () => {
    const { snapshot } = await withLookup((b) => {
      b.latest.description = 42;
      b.latest.icon = null;
    });
    expect(snapshot).toMatchObject({ description: null, iconUrl: null });
  });

  it('builds the package URL itself when package_url is not on the game host', async () => {
    for (const url of ['https://evil.example/mods/Owner1/Package1', 'javascript:alert(1)', 42, undefined]) {
      const { snapshot } = await withLookup((b) => void (b.package_url = url as string));
      expect(snapshot?.url, String(url)).toBe(`${ORIGIN}/mods/Owner1/Package1`);
    }
  });

  it('normalises date_updated to the canonical stamp', async () => {
    const { snapshot } = await withLookup((b) => void (b.date_updated = '2026-09-26T22:42:31Z'));
    expect(snapshot?.updatedAt).toBe('2026-09-26T22:42:31.000000Z');
  });
});

describe('HexiumAdapter.poll — lookup failures defer without loss', () => {
  const state = makeState({ cursor: null });
  const index = syntheticIndex(8, () => '2.0.0');
  const known = allVersions(8);

  async function pollWith(lookup: LookupResponder, tickIndex = indexTick(1)) {
    const fake = routes({ index, lookup });
    const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex, state })));
    return { fake, res, emitted: ids(res.packages.filter((p) => p.packageId.startsWith('Owner'))) };
  }

  it.each([
    ['a 404', () => new Response('{"detail":"Not found."}', { status: 404 })],
    ['a 500', () => new Response('', { status: 500 })],
    ['a network error', () => Promise.reject(new TypeError('down'))],
    ['a body that is not JSON', () => text('<html>maintenance</html>')],
    ['a JSON array', () => json([])],
    ['an oversized body', () => text(`{"pad":"${'x'.repeat(HEXIUM_LOOKUP_MAX_BYTES)}"}`)],
  ])('emits nothing for a candidate whose lookup is %s and still emits the others', async (_label, failure) => {
    const { res, emitted } = await pollWith((ns, name) => (ns === 'Owner3' ? failure() : json(lookupBody(ns, name, '2.0.0'))));
    expect(emitted).toEqual(ownerIds(1, 8).filter((id) => id !== 'Owner3-Package3'));
    expect(res.complete).toBe(false);
    expect(warnings().filter((l) => l.includes('skipped: index lines'))).toHaveLength(1);
  });

  it('emits the deferred candidate on a later scan once its lookup works', async () => {
    let healthy = false;
    const lookup: LookupResponder = (ns, name) => (ns === 'Owner3' && !healthy ? new Response('', { status: 500 }) : json(lookupBody(ns, name, '2.0.0')));
    const fake = routes({ index, lookup });
    const first = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    expect(ids(first.packages)).not.toContain('Owner3-Package3');
    healthy = true;
    const second = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(2), state })));
    expect(ids(second.packages)).toContain('Owner3-Package3');
  });

  it('stops looking up further packages after a 429', async () => {
    const many = syntheticIndex(40, () => '2.0.0');
    const fake = routes({ index: many, lookup: () => new Response('', { status: 429, headers: { 'retry-after': '60' } }) });
    const res = ok(await adapterWith(allVersions(40)).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    expect(lookupCalls(fake).length).toBeLessThanOrEqual(CLOUDFLARE.simultaneousConnections);
    expect(res.complete).toBe(false);
    expect(res.packages.filter((p) => p.packageId.startsWith('Owner'))).toEqual([]);
  });

  it('never has more lookups in flight than the connection limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const many = syntheticIndex(40, () => '2.0.0');
    const fake = routes({
      index: many,
      lookup: async (ns, name) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return json(lookupBody(ns, name, '2.0.0'));
      },
    });
    await adapterWith(allVersions(40)).poll(makeCtx(fake, { tickIndex: indexTick(1), state }));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(CLOUDFLARE.simultaneousConnections);
  });
});

describe('HexiumAdapter.poll — candidate cap', () => {
  const state = makeState({ cursor: null });
  const cap = SOURCE_BUDGET.hexiumLookupsPerPoll;
  const total = cap * 2 + 7;

  it('looks up at most the cap per poll and reports the poll incomplete', async () => {
    const fake = routes({ index: syntheticIndex(total, () => '2.0.0'), lookup: answerAll() });
    const res = ok(await adapterWith(allVersions(total)).poll(makeCtx(fake, { tickIndex: indexTick(0), state })));
    expect(lookupCalls(fake)).toHaveLength(cap);
    expect(res.packages.filter((p) => p.packageId.startsWith('Owner'))).toHaveLength(cap);
    expect(res.complete).toBe(false);
    expect(fake.calls.length).toBeLessThanOrEqual(2 + cap);
  });

  it('loses nothing across consecutive scans: every changed package is emitted exactly once', async () => {
    const known = new Map(Object.entries(allVersions(total)));
    const emitted: string[] = [];
    const fake = routes({ index: syntheticIndex(total, () => '2.0.0'), lookup: answerAll() });
    let complete = false;
    for (let scan = 0; scan < 10 && !complete; scan += 1) {
      const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(scan), state })));
      for (const p of res.packages.filter((s) => s.packageId.startsWith('Owner'))) {
        emitted.push(p.packageId);
        known.set(p.packageId, p.version);
      }
      complete = res.complete;
    }
    expect(complete).toBe(true);
    expect(emitted.sort()).toEqual(ownerIds(1, total));
    expect(lookupCalls(fake)).toHaveLength(total);
  });

  it('does not let as many always-failing packages as the cap starve the rest', async () => {
    const stuck = new Set(ownerIds(1, cap).map((id) => id.split('-')[0]));
    const known = new Map(Object.entries(allVersions(total)));
    const fake = routes({
      index: syntheticIndex(total, () => '2.0.0'),
      lookup: (ns, name) => (stuck.has(ns) ? new Response('', { status: 404 }) : json(lookupBody(ns, name, '2.0.0'))),
    });
    for (let scan = 0; scan < 8; scan += 1) {
      const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(scan), state })));
      for (const p of res.packages.filter((s) => s.packageId.startsWith('Owner'))) known.set(p.packageId, p.version);
    }
    expect([...known].filter(([, version]) => version === '2.0.0')).toHaveLength(total - cap);
  });
});

describe('HexiumAdapter.poll — hostile or reformatted index', () => {
  const state = makeState({ cursor: null });
  const changedIndex = syntheticIndex(6, (n) => (n === 2 || n === 4 ? '2.0.0' : '1.0.0'));
  const known = allVersions(6);

  async function candidates(index: string): Promise<string[]> {
    const fake = routes({ index, lookup: answerAll() });
    await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(1), state }));
    return lookupCalls(fake).map((c) => new URL(c.url).pathname.split('/')[5]!).sort();
  }

  it('finds the same candidates with CRLF endings, blank lines and no trailing newline', async () => {
    const lines = changedIndex.split('\n');
    const expected = ['Package2', 'Package4'];
    expect(await candidates(lines.join('\r\n') + '\r\n')).toEqual(expected);
    expect(await candidates(`\n\n${lines.join('\n\n')}\n\n`)).toEqual(expected);
    expect(await candidates(changedIndex)).toEqual(expected);
  });

  it('skips malformed, mistyped and unsafe lines and counts them in one warning', async () => {
    const bad = ['not json', '{"namespace":"Owner2","name":"Package2"', '{"namespace":"..","name":"x","version_number":"9.9.9"}', '{"namespace":"a/b","name":"x","version_number":"9.9.9"}'];
    const index = [changedIndex, ...bad].join('\n');
    expect(await candidates(index)).toEqual(['Package2', 'Package4']);
    const lines = warnings().filter((l) => l.includes('skipped: index lines'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/index lines 4/);
  });

  it('looks a package that appears twice up once', async () => {
    const line = indexLine(2, '2.0.0');
    expect(await candidates([changedIndex, line, line].join('\n'))).toEqual(['Package2', 'Package4']);
  });

  it('never builds a lookup URL from an unsafe name', async () => {
    const evil = ['{"namespace":"Owner1","name":"../../v1/package","version_number":"9.9.9"}', '{"namespace":"Owner1","name":"x?y=1","version_number":"9.9.9"}', '{"namespace":"a b","name":"c","version_number":"9.9.9"}'];
    const fake = routes({ index: evil.join('\n'), lookup: answerAll() });
    await adapterWith().poll(makeCtx(fake, { tickIndex: indexTick(1), state }));
    expect(lookupCalls(fake)).toHaveLength(0);
  });

  it('falls back to the listing packages when the index is unusable or too large', async () => {
    const unusable: [string, string | (() => Response)][] = [
      ['an html page', '<html>maintenance</html>'],
      ['a JSON array', JSON.stringify([{ namespace: 'a', name: 'b', version_number: '1.0.0' }])],
      ['a 500', () => new Response('', { status: 500 })],
      ['a huge line', `{"namespace":"a","name":"b","version_number":"1.0.0","d":"${'x'.repeat(200_000)}"}`],
      ['too many lines', syntheticIndex(HEXIUM_INDEX_MAX_LINES + 5)],
      ['an oversized body', `${changedIndex}\n${' '.repeat(HEXIUM_INDEX_MAX_BYTES)}`],
    ];
    for (const [label, body] of unusable) {
      const fake = routes({ index: body, lookup: answerAll() });
      const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
      expect(res.packages, label).toHaveLength(4);
      expect(lookupCalls(fake), label).toHaveLength(0);
    }
  });

  it('never reads the index more than once per poll', async () => {
    const fake = routes({ index: changedIndex, lookup: answerAll() });
    await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(1), state }));
    expect(fake.callsTo('package-index')).toHaveLength(1);
  });
});

describe('HexiumAdapter.poll — degradation is reported', () => {
  const state = makeState({ cursor: null });
  const OVER_CAP = 'package-index above cap: updates of existing packages are not detected';
  const UNAVAILABLE = 'package-index unavailable or unreadable: updates of existing packages are not detected';
  const known = allVersions(6);

  async function pollIndex(index: string | (() => Response), over: Partial<PollContext> = {}) {
    return ok(await adapterWith(known).poll(makeCtx(routes({ index, lookup: answerAll() }), { tickIndex: indexTick(1), state, ...over })));
  }

  it('has no warnings on a healthy scan or on a listing-only tick', async () => {
    expect((await pollIndex(syntheticIndex(6))).warnings).toBeUndefined();
    const listingOnly = ok(await adapterWith(known).poll(makeCtx(routes(), { tickIndex: LISTING_TICK, state })));
    expect(listingOnly.warnings).toBeUndefined();
  });

  it('warns when the index has more lines than the cap, and still returns the listing', async () => {
    const res = await pollIndex(syntheticIndex(HEXIUM_INDEX_MAX_LINES + 5));
    expect(res.warnings).toEqual([OVER_CAP]);
    expect(res.packages).toHaveLength(4);
    expect(res.complete).toBe(false);
  });

  it('warns when the index body is above the byte cap', async () => {
    expect((await pollIndex(`${syntheticIndex(6)}\n${' '.repeat(HEXIUM_INDEX_MAX_BYTES)}`)).warnings).toEqual([OVER_CAP]);
  });

  it.each([
    ['whitespace only', '\n'.repeat(HEXIUM_INDEX_MAX_BYTES - 10)],
    ['CRLF only', '\r\n'.repeat(HEXIUM_INDEX_MAX_BYTES / 4)],
  ])('warns about the cap for a body of %s', async (_label, body) => {
    expect((await pollIndex(body)).warnings).toEqual([OVER_CAP]);
  });

  it.each([
    ['an html page', '<html>maintenance</html>'],
    ['a JSON array', JSON.stringify([{ namespace: 'a', name: 'b', version_number: '1.0.0' }])],
    ['a 500', () => new Response('', { status: 500 })],
    ['a network error', () => Promise.reject(new TypeError('down')) as unknown as Response],
  ])('warns that updates are not detected when the index is %s', async (_label, body) => {
    const res = await pollIndex(body);
    expect(res.warnings).toEqual([UNAVAILABLE]);
    expect(res.packages).toHaveLength(4);
  });

  it('warns on an index tick whose listing answered 304', async () => {
    const fake = createFakeFetch([[LISTING, () => new Response(null, { status: 304 })], [INDEX, () => text('<html>maintenance</html>')]]);
    const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(1), state: makeState({ cursor: null, etag: '"h1"' }) })));
    expect(res.warnings).toEqual([UNAVAILABLE]);
  });

  it('warns about failed and unreadable lookups without naming packages or hosts', async () => {
    const lookup: LookupResponder = (ns, name) =>
      ns === 'Owner1' ? new Response('', { status: 500 }) : ns === 'Owner2' ? json({}) : json(lookupBody(ns, name, '2.0.0'));
    const fake = routes({ index: syntheticIndex(6, () => '2.0.0'), lookup });
    const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings![0]).toMatch(/lookups failed 1/);
    expect(res.warnings![0]).toMatch(/lookups unreadable 1/);
    expect(res.warnings![0]).not.toMatch(/Owner|Package|https?:/);
  });

  it('warns when more candidates changed than the per-poll lookup cap', async () => {
    const total = SOURCE_BUDGET.hexiumLookupsPerPoll + 7;
    const fake = routes({ index: syntheticIndex(total, () => '2.0.0'), lookup: answerAll() });
    const res = ok(await adapterWith(allVersions(total)).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    expect(res.warnings).toEqual([`lookups capped: ${SOURCE_BUDGET.hexiumLookupsPerPoll} of ${total} candidates`]);
  });

  it('reads a full-size index at the live line size without any warning', async () => {
    const line = (n: number, version: string): string => `${indexLine(n, version).slice(0, -1)},"pad":"${'x'.repeat(130)}"}`;
    const lines = Array.from({ length: HEXIUM_INDEX_MAX_LINES }, (_, i) => line(i + 1, i === 1 || i === 2 ? '2.0.0' : '1.0.0'));
    const body = lines.join('\n');
    expect(body.length / HEXIUM_INDEX_MAX_LINES).toBeGreaterThan(380);
    const fake = routes({ index: body, lookup: answerAll() });
    const res = ok(await adapterWith(allVersions(HEXIUM_INDEX_MAX_LINES)).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    expect(lookupCalls(fake)).toHaveLength(2);
    expect(res.warnings).toBeUndefined();
  });
});

describe('HexiumAdapter.poll — subrequest budget', () => {
  const state = makeState({ cursor: null });

  it('stays within listing + index + the per-poll lookup cap even when every package changed', async () => {
    const fake = routes({ index: syntheticIndex(500, () => '2.0.0'), lookup: answerAll() });
    await adapterWith(allVersions(500)).poll(makeCtx(fake, { tickIndex: indexTick(1), state }));
    expect(fake.calls.length).toBe(2 + SOURCE_BUDGET.hexiumLookupsPerPoll);
  });

  it('stays within the cold-start budget: one index read per seed poll and nothing else', async () => {
    const fake = routes({ index: syntheticIndex(500) });
    await adapterWith().poll(makeCtx(fake, { state: null }));
    expect(fake.calls.map((c) => c.url)).toEqual([INDEX]);
  });
});

describe('HexiumAdapter.poll — cold start seeding', () => {
  const count = SOURCE_BUDGET.hexiumSeedSlices;
  const index = syntheticIndex(400);
  const everyId = ownerIds(1, 400);
  const sliceIds = (slice: number, source = index): string[] => {
    const out: string[] = [];
    scanPackageIndex(source, (e) => {
      if (seedSliceOf(e.namespace, e.name, count) === slice) out.push(`${e.namespace}-${e.name}`);
    });
    return out.sort();
  };

  it('seeds slice 0 first from the index alone: lean snapshots, no listing, no lookups, no events', async () => {
    const fake = routes({ index, lookup: answerAll() });
    const res = ok(await adapterWith().poll(makeCtx(fake, { state: null })));
    expect(fake.calls.map((c) => c.url)).toEqual([INDEX]);
    expect(ids(res.packages)).toEqual(sliceIds(0));
    expect(res.cursor).toBe('seed:1');
    expect(res.complete).toBe(false);
    expect(res.etag).toBeNull();
    for (const p of res.packages) {
      expect(p).toMatchObject({
        source: 'hexium:valheim',
        store: 'hexium',
        version: '1.0.0',
        url: `${ORIGIN}/mods/${p.owner}/${p.name}`,
        iconUrl: null,
        description: null,
        categories: [],
        isNsfw: false,
        isDeprecated: false,
        updatedAt: '2026-09-27T12:00:00.000000Z',
      });
      expect(p.sizeBytes).toBe(100_000 + Number(p.owner.slice(5)));
      expect(p.previousVersion).toBeUndefined();
    }
  });

  it('walks every slice, covers each package exactly once, and ends with a complete poll and no cursor', async () => {
    const fake = routes({ index });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let slice = 0; slice < count; slice += 1) {
      const res = ok(await adapterWith().poll(makeCtx(fake, { state: cursor === null ? null : makeState({ cursor, bootstrapped: false }) })));
      seen.push(...ids(res.packages));
      expect(res.complete).toBe(slice === count - 1);
      cursor = res.cursor;
    }
    expect(cursor).toBeNull();
    expect(seen.sort()).toEqual(everyId);
    expect(fake.callsTo('frontend/packages')).toHaveLength(0);
    expect(lookupCalls(fake)).toHaveLength(0);
  });

  it('keeps every package in its own slice when the index changes between polls', async () => {
    const before = ok(await adapterWith().poll(makeCtx(routes({ index }), { state: null })));
    const changed = syntheticIndex(420, (n) => (n % 2 === 0 ? '3.0.0' : '1.0.0')).split('\n').filter((line) => !line.includes('"Owner10"')).join('\n');
    const after = ok(await adapterWith().poll(makeCtx(routes({ index: changed }), { state: makeState({ cursor: before.cursor, bootstrapped: false }) })));
    expect(ids(after.packages)).toEqual(sliceIds(1, changed));
    expect(after.packages.every((p) => seedSliceOf(p.owner, p.name, count) === 1)).toBe(true);
    expect(after.cursor).toBe('seed:2');
  });

  it('restarts from the first slice for a legacy, out-of-range or garbage seed cursor', async () => {
    for (const cursor of ['seed:2:2026-09-20T05:18:45.000000Z', `seed:${count}`, 'seed:99', 'seed:-1', 'seed:x', 'seed:', 'garbage', '2026-09-20T05:18:45.000000Z', null]) {
      const res = ok(await adapterWith().poll(makeCtx(routes({ index }), { state: makeState({ cursor, bootstrapped: false }) })));
      expect(ids(res.packages), String(cursor)).toEqual(sliceIds(0));
      expect(res.cursor, String(cursor)).toBe('seed:1');
    }
  });

  it('resumes at the stored slice', async () => {
    const res = ok(await adapterWith().poll(makeCtx(routes({ index }), { state: makeState({ cursor: 'seed:3', bootstrapped: false }) })));
    expect(ids(res.packages)).toEqual(sliceIds(3));
    expect(res.cursor).toBe('seed:4');
  });

  it('does not seed a bootstrapped source, even without a cursor', async () => {
    const fake = routes({ index });
    const res = ok(await adapterWith(allVersions(400)).poll(makeCtx(fake, { tickIndex: LISTING_TICK, state: makeState({ cursor: null, bootstrapped: true }) })));
    expect(fake.callsTo('package-index')).toHaveLength(0);
    expect(res.packages).toHaveLength(4);
  });

  it('seeds silently: a seeded package later updates through a lookup and is not new', async () => {
    const seeded = new Map<string, string>();
    let cursor: string | null = null;
    for (let slice = 0; slice < count; slice += 1) {
      const res = ok(await adapterWith().poll(makeCtx(routes({ index }), { state: cursor === null ? null : makeState({ cursor, bootstrapped: false }) })));
      for (const p of res.packages) seeded.set(p.packageId, p.version);
      cursor = res.cursor;
    }
    const later = syntheticIndex(401, (n) => (n === 7 || n === 401 ? '2.0.0' : '1.0.0'));
    const fake = routes({ index: later, lookup: (ns, name) => json(lookupBody(ns, name, '2.0.0')) });
    const res = ok(await adapterWith(seeded).poll(makeCtx(fake, { tickIndex: indexTick(1), state: makeState({ cursor: null }) })));
    const { events } = diffSnapshots(seeded, res.packages.filter((p) => p.packageId.startsWith('Owner')), FIXTURE_NOW);
    expect(events.map((e) => [e.pkg.packageId, e.kind, e.versionFrom]).sort()).toEqual([
      ['Owner401-Package401', 'new', null],
      ['Owner7-Package7', 'update', '1.0.0'],
    ]);
    expect(events.every((e) => e.pkg.isNsfw === false && e.pkg.description !== null)).toBe(true);
  });

  it('seeds an empty index to completion', async () => {
    const res = ok(await adapterWith().poll(makeCtx(routes({ index: '' }), { state: makeState({ cursor: `seed:${count - 1}`, bootstrapped: false }) })));
    expect(res).toMatchObject({ packages: [], cursor: null, complete: true });
  });

  it('is skipped, not thrown, on an unusable index or upstream errors', async () => {
    for (const responder of [
      () => text('<html>maintenance</html>'),
      () => text(JSON.stringify([{ namespace: 'a', name: 'b', version_number: '1.0.0' }])),
      () => new Response('', { status: 502 }),
      () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
      () => Promise.reject(new TypeError('down')),
      () => text(syntheticIndex(HEXIUM_INDEX_MAX_LINES + 5)),
    ]) {
      const fake = routes({ index: responder });
      await expect(adapterWith().poll(makeCtx(fake, { state: null }))).resolves.toEqual({ status: 'skipped' });
    }
  });

  it('keeps a slice small on the largest index it accepts', async () => {
    const big = syntheticIndex(HEXIUM_INDEX_MAX_LINES);
    const res = ok(await adapterWith().poll(makeCtx(routes({ index: big }), { state: null })));
    expect(res.packages.length).toBeLessThanOrEqual(Math.ceil((HEXIUM_INDEX_MAX_LINES / count) * 1.3));
  });

  it('counts unreadable index lines in one warning while seeding', async () => {
    const res = ok(await adapterWith().poll(makeCtx(routes({ index: [index, 'garbage', 'more garbage'].join('\n') }), { state: null })));
    expect(res.packages.length).toBeGreaterThan(0);
    expect(warnings().filter((l) => l.includes('skipped: index lines 2'))).toHaveLength(1);
    expect(res.warnings?.some((w) => w.includes('index lines 2'))).toBe(true);
  });

  describe('a glitchy index does not leave holes', () => {
    const garbage = (n: number): string[] => Array.from({ length: n }, (_, i) => `garbage ${i}`);
    const seedWith = async (source: string, bad: number, cursor: string | null) =>
      ok(await adapterWith().poll(makeCtx(routes({ index: [source, ...garbage(bad)].join('\n') }), { state: cursor === null ? null : makeState({ cursor, bootstrapped: false }) })));
    const small = syntheticIndex(20);

    it('seeds the slice while the unreadable lines stay at the small-index threshold of 3', async () => {
      const res = await seedWith(small, 3, 'seed:3');
      expect(ids(res.packages)).toEqual(sliceIds(3, small));
      expect(res.packages.length).toBeGreaterThan(0);
      expect(res.cursor).toBe('seed:4');
    });

    it('skips the poll above the threshold: nothing committed, cursor unchanged, warning raised', async () => {
      for (const cursor of ['seed:3', 'seed:7', null]) {
        const res = await seedWith(small, 4, cursor);
        expect(res.packages, String(cursor)).toEqual([]);
        expect(res.cursor, String(cursor)).toBe(cursor);
        expect(res.complete, String(cursor)).toBe(false);
        expect(res.warnings?.join(' '), String(cursor)).toMatch(/seeding paused/);
      }
    });

    it('scales the threshold to 1% of a large index', async () => {
      const large = syntheticIndex(1000);
      expect(ids((await seedWith(large, 10, 'seed:1')).packages)).toEqual(sliceIds(1, large));
      const paused = await seedWith(large, 11, 'seed:1');
      expect(paused.packages).toEqual([]);
      expect(paused.cursor).toBe('seed:1');
    });

    it('resumes at the same slice once the index is clean again', async () => {
      const paused = await seedWith(small, 10, 'seed:3');
      const resumed = ok(await adapterWith().poll(makeCtx(routes({ index: small }), { state: makeState({ cursor: paused.cursor, bootstrapped: false }) })));
      expect(ids(resumed.packages)).toEqual(sliceIds(3, small));
      expect(resumed.packages.length).toBeGreaterThan(0);
      expect(resumed.cursor).toBe('seed:4');
    });

    it('never completes seeding on a glitchy index', async () => {
      const res = await seedWith(small, 10, `seed:${count - 1}`);
      expect(res.complete).toBe(false);
      expect(res.cursor).toBe(`seed:${count - 1}`);
    });
  });
});

describe('HexiumAdapter.reconcile', () => {
  const cap = SOURCE_BUDGET.hexiumLookupsPerReconcile;

  it('makes one index read, looks up only changed and unseen packages, and returns full snapshots', async () => {
    const index = syntheticIndex(30, (n) => (n === 3 ? '2.0.0' : '1.0.0'));
    const known = allVersions(30);
    delete known['Owner9-Package9'];
    const fake = routes({ index, lookup: (ns, name) => json(lookupBody(ns, name, ns === 'Owner3' ? '2.0.0' : '1.0.0')) });
    const out = await adapterWith(known).reconcile!(makeCtx(fake));
    expect(ids(out)).toEqual(['Owner3-Package3', 'Owner9-Package9']);
    expect(out.every((p) => p.description !== null && p.updatedAt !== '')).toBe(true);
    expect(fake.callsTo('package-index')).toHaveLength(1);
    expect(fake.callsTo('frontend/packages')).toHaveLength(0);
    expect(lookupCalls(fake)).toHaveLength(2);
  });

  it('returns nothing and makes no lookup when the store is up to date', async () => {
    const fake = routes({ index: syntheticIndex(30), lookup: answerAll() });
    expect(await adapterWith(allVersions(30)).reconcile!(makeCtx(fake))).toEqual([]);
    expect(fake.calls.map((c) => c.url)).toEqual([INDEX]);
  });

  it('caps the lookups per run and covers every changed package over consecutive slice hints', async () => {
    const total = cap * 2 + 5;
    const known = new Map(Object.entries(allVersions(total)));
    const fake = routes({ index: syntheticIndex(total, () => '2.0.0'), lookup: answerAll() });
    const first = await adapterWith(known).reconcile!(makeCtx(fake, { sliceHint: 0 }));
    expect(first).toHaveLength(cap);
    expect(fake.calls.length).toBe(1 + cap);

    const seen = new Set<string>();
    for (let hint = 0; hint < 10 && seen.size < total; hint += 1) {
      const out = await adapterWith(known).reconcile!(makeCtx(fake, { sliceHint: hint }));
      out.forEach((p) => seen.add(p.packageId));
      out.forEach((p) => known.set(p.packageId, p.version));
    }
    expect([...seen].sort()).toEqual(ownerIds(1, total));
  });

  it('works without a slice hint', async () => {
    const fake = routes({ index: syntheticIndex(5, () => '2.0.0'), lookup: answerAll() });
    expect(await adapterWith(allVersions(5)).reconcile!(makeCtx(fake))).toHaveLength(5);
  });

  it('throws on an upstream failure or an unusable index rather than returning an empty sweep', async () => {
    for (const index of [() => new Response('', { status: 503 }), () => text('<html>maintenance</html>'), () => text(syntheticIndex(HEXIUM_INDEX_MAX_LINES + 5))]) {
      await expect(adapterWith().reconcile!(makeCtx(routes({ index })))).rejects.toThrow();
    }
  });

  it('throws when the index needs lookups and none of them works', async () => {
    const fake = routes({ index: syntheticIndex(5, () => '2.0.0'), lookup: () => new Response('', { status: 500 }) });
    await expect(adapterWith(allVersions(5)).reconcile!(makeCtx(fake))).rejects.toThrow();
  });

  it('returns what it could look up when only some lookups fail', async () => {
    const fake = routes({ index: syntheticIndex(5, () => '2.0.0'), lookup: (ns, name) => (ns === 'Owner2' ? new Response('', { status: 404 }) : json(lookupBody(ns, name, '2.0.0'))) });
    const out = await adapterWith(allVersions(5)).reconcile!(makeCtx(fake));
    expect(ids(out)).toEqual(ownerIds(1, 5).filter((id) => id !== 'Owner2-Package2'));
  });

  it('marks packages NSFW when their community entry is missing, like a poll', async () => {
    const fake = routes({ index: syntheticIndex(2, () => '2.0.0'), lookup: answerAll('2.0.0', (b) => void (b.community_listings = [])) });
    const out = await adapterWith(allVersions(2)).reconcile!(makeCtx(fake));
    expect(out.every((p) => p.isNsfw)).toBe(true);
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

  it('returns no link when the package ships no changelog', async () => {
    const fake = createFakeFetch([['/changelog/', () => json({ markdown: null })]]);
    expect(await adapterWith().fetchChangelog(makeCtx(fake), pkg, '5.4.2350')).toEqual({ excerpt: null, url: null });
  });

  it('refuses a changelog body above the changelog cap without parsing it', async () => {
    const huge = JSON.stringify({ markdown: `## 5.4.2350\n${'- entry\n'.repeat(60_000)}` });
    expect(huge.length).toBeGreaterThan(300_000);
    const fake = createFakeFetch([['/changelog/', () => text(huge)]]);
    const spy = vi.spyOn(JSON, 'parse');
    expect(await adapterWith().fetchChangelog(makeCtx(fake), pkg, '5.4.2350')).toEqual({ excerpt: null, url: null });
    expect(spy).not.toHaveBeenCalled();
  });

  it('still reads a changelog just below the cap', async () => {
    const body = JSON.stringify({ markdown: `## 5.4.2350\n- fixed a thing\n${'x'.repeat(100_000)}` });
    const fake = createFakeFetch([['/changelog/', () => text(body)]]);
    expect((await adapterWith().fetchChangelog(makeCtx(fake), pkg, '5.4.2350')).excerpt).toContain('fixed a thing');
  });
});

describe('HexiumAdapter — download url and download count', () => {
  const state = makeState({ cursor: null, etag: null });

  async function lookedUp(mutate: (body: Lookup) => void): Promise<import('../core/types.ts').PackageSnapshot> {
    const fake = routes({ index: syntheticIndex(1), lookup: answerAll('2.0.0', mutate) });
    const res = ok(await adapterWith(allVersions(1, '0.9.0')).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    return res.packages.find((p) => p.packageId === 'Owner1-Package1')!;
  }
  const withUrl = (value: unknown) => (body: Lookup) => void ((body.latest as Record<string, unknown>).download_url = value);
  const withTotal = (value: unknown) => (body: Lookup) => void (body.total_downloads = value);

  it('takes the download url from latest.download_url and the count from total_downloads of a lookup', async () => {
    const snapshot = await lookedUp((body) => {
      withUrl('https://cdn.hexium.gg/upload/9/2.0.0.zip')(body);
      withTotal(4242)(body);
    });
    expect(snapshot).toMatchObject({ downloadUrl: 'https://cdn.hexium.gg/upload/9/2.0.0.zip', downloads: 4242 });
  });

  it.each([
    ['the bare host', 'https://hexium.gg/dl/a.zip', 'https://hexium.gg/dl/a.zip'],
    ['a subdomain', 'https://valheim.hexium.gg/dl/a.zip', 'https://valheim.hexium.gg/dl/a.zip'],
    ['upper case', 'HTTPS://CDN.HEXIUM.GG/A.zip', 'https://cdn.hexium.gg/A.zip'],
    ['a query string', 'https://cdn.hexium.gg/a.zip?x=1', 'https://cdn.hexium.gg/a.zip?x=1'],
  ])('accepts a download url on %s', async (_label, raw, expected) => {
    expect((await lookedUp(withUrl(raw))).downloadUrl).toBe(expected);
  });

  it.each([
    ['plain http', 'http://cdn.hexium.gg/a.zip'],
    ['another host', 'https://evil.example/a.zip'],
    ['a look-alike suffix', 'https://evilhexium.gg/a.zip'],
    ['a host that only starts with hexium.gg', 'https://hexium.gg.evil.example/a.zip'],
    ['credentials before the host', 'https://user:pw@cdn.hexium.gg/a.zip'],
    ['a user that names the host', 'https://cdn.hexium.gg@evil.example/a.zip'],
    ['a trailing dot host', 'https://cdn.hexium.gg./a.zip'],
    ['a script url', 'javascript:alert(1)'],
    ['a protocol-relative url', '//cdn.hexium.gg/a.zip'],
    ['a relative path', '/upload/1/a.zip'],
    ['garbage', 'not a url'],
    ['an empty string', ''],
    ['a number', 42],
    ['null', null],
    ['an object', { url: 'https://cdn.hexium.gg/a.zip' }],
    ['over 512 characters', `https://cdn.hexium.gg/${'a'.repeat(600)}`],
  ])('drops a download url that is %s', async (_label, raw) => {
    expect((await lookedUp(withUrl(raw))).downloadUrl).toBeNull();
  });

  it('has no download url when the lookup omits it', async () => {
    expect((await lookedUp((body) => void delete (body.latest as Record<string, unknown>).download_url)).downloadUrl).toBeNull();
  });

  it('accepts zero downloads and drops counts that are not non-negative integers', async () => {
    expect((await lookedUp(withTotal(0))).downloads).toBe(0);
    for (const bad of ['5', -3, 2.5, 1e30, null, true, [], {}, undefined]) {
      expect((await lookedUp(withTotal(bad))).downloads, String(bad)).toBeNull();
    }
  });

  it('maps the listing download_count and leaves the download url empty', async () => {
    const res = ok(await adapterWith().poll(makeCtx(routes(), { tickIndex: LISTING_TICK, state })));
    expect(res.packages.map((p) => p.downloads)).toEqual([3, 3, 1, 1]);
    for (const p of res.packages) expect(p.downloadUrl).toBeNull();
  });

  it('drops a listing download_count that is not a non-negative integer', async () => {
    const body = JSON.parse(listingFixture) as { packages: Record<string, unknown>[] };
    const bad: unknown[] = ['3', -1, 1.5, 1e30];
    body.packages.forEach((item, i) => void (item.download_count = bad[i]));
    delete body.packages[3]!.download_count;
    const res = ok(await adapterWith().poll(makeCtx(routes({ listing: JSON.stringify(body) }), { tickIndex: LISTING_TICK, state })));
    expect(res.packages.map((p) => p.downloads)).toEqual([null, null, null, null]);
  });

  it('gives lean seed rows neither a download url nor a count', async () => {
    const res = ok(await adapterWith().poll(makeCtx(routes({ index: syntheticIndex(40) }), { state: null })));
    expect(res.packages.length).toBeGreaterThan(0);
    for (const p of res.packages) {
      expect(p.downloadUrl).toBeNull();
      expect(p.downloads).toBeNull();
    }
  });
});

describe('HexiumAdapter — likes and website', () => {
  const state = makeState({ cursor: null, etag: null });

  async function lookedUp(mutate: (body: Lookup) => void): Promise<import('../core/types.ts').PackageSnapshot> {
    const fake = routes({ index: syntheticIndex(1), lookup: answerAll('2.0.0', mutate) });
    const res = ok(await adapterWith(allVersions(1, '0.9.0')).poll(makeCtx(fake, { tickIndex: indexTick(1), state })));
    return res.packages.find((p) => p.packageId === 'Owner1-Package1')!;
  }
  const withWebsite = (value: unknown) => (body: Lookup) => void ((body.latest as Record<string, unknown>).website_url = value);
  const withRating = (value: unknown) => (body: Lookup) => void (body.rating_score = value);

  it('takes likes from rating_score and the website from latest.website_url of a lookup', async () => {
    const snapshot = await lookedUp((body) => {
      withRating(11)(body);
      withWebsite('https://github.com/blaxxun-boop/Building')(body);
    });
    expect(snapshot).toMatchObject({ likes: 11, websiteUrl: 'https://github.com/blaxxun-boop/Building' });
  });

  it('accepts zero likes and drops rating scores that are not non-negative integers', async () => {
    expect((await lookedUp(withRating(0))).likes).toBe(0);
    for (const bad of ['5', -3, 2.5, 1e30, null, true, [], {}, undefined]) {
      expect((await lookedUp(withRating(bad))).likes, String(bad)).toBeNull();
    }
  });

  it.each([
    ['an https site', 'https://github.com/o/m', 'https://github.com/o/m'],
    ['plain http', 'http://example.org/mod', 'http://example.org/mod'],
    ['a discord invite', 'https://discord.gg/THGNhtAYC8', 'https://discord.gg/THGNhtAYC8'],
    ['upper case', 'HTTPS://GitHub.com/O/M', 'https://github.com/O/M'],
    ['a host that only starts with hexium.gg', 'https://hexium.gg.evil.example/x', 'https://hexium.gg.evil.example/x'],
  ])('accepts a website that is %s', async (_label, raw, expected) => {
    expect((await lookedUp(withWebsite(raw))).websiteUrl).toBe(expected);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a script url', 'javascript:alert(1)'],
    ['a data url', 'data:text/html;base64,PHNjcmlwdD4='],
    ['a file url', 'file:///etc/passwd'],
    ['credentials before the host', 'https://user:pw@example.com/'],
    ['a protocol-relative url', '//example.com/x'],
    ['a relative path', '/x'],
    ['garbage', 'not a url'],
    ['a number', 42],
    ['null', null],
    ['an object', { url: 'https://example.com/' }],
    ['over 512 characters', `https://example.com/${'a'.repeat(600)}`],
  ])('drops a website that is %s', async (_label, raw) => {
    expect((await lookedUp(withWebsite(raw))).websiteUrl).toBeNull();
  });

  it('has no website when the lookup omits it', async () => {
    expect((await lookedUp((body) => void delete (body.latest as Record<string, unknown>).website_url)).websiteUrl).toBeNull();
  });

  it('maps the listing rating_score to likes and leaves the website empty', async () => {
    const body = JSON.parse(listingFixture) as { packages: Record<string, unknown>[] };
    const scores: unknown[] = [7, 0, 3, 12];
    body.packages.forEach((item, i) => void (item.rating_score = scores[i]));
    const res = ok(await adapterWith().poll(makeCtx(routes({ listing: JSON.stringify(body) }), { tickIndex: LISTING_TICK, state })));
    expect(res.packages.map((p) => p.likes)).toEqual([7, 0, 3, 12]);
    for (const p of res.packages) expect(p.websiteUrl).toBeNull();
  });

  it('drops a listing rating_score that is not a non-negative integer', async () => {
    const body = JSON.parse(listingFixture) as { packages: Record<string, unknown>[] };
    const bad: unknown[] = ['3', -1, 1.5, 1e30];
    body.packages.forEach((item, i) => void (item.rating_score = bad[i]));
    const res = ok(await adapterWith().poll(makeCtx(routes({ listing: JSON.stringify(body) }), { tickIndex: LISTING_TICK, state })));
    expect(res.packages.map((p) => p.likes)).toEqual([null, null, null, null]);
    delete body.packages[0]!.rating_score;
    const missing = ok(await adapterWith().poll(makeCtx(routes({ listing: JSON.stringify(body) }), { tickIndex: LISTING_TICK, state })));
    expect(missing.packages[0]!.likes).toBeNull();
  });

  it('gives lean seed rows neither likes nor a website', async () => {
    const res = ok(await adapterWith().poll(makeCtx(routes({ index: syntheticIndex(40) }), { state: null })));
    expect(res.packages.length).toBeGreaterThan(0);
    for (const p of res.packages) {
      expect(p.likes).toBeNull();
      expect(p.websiteUrl).toBeNull();
    }
  });

  it('fetchChangelog spends one request and returns no website', async () => {
    const fake = createFakeFetch([['/changelog/', () => json({ markdown: null })]]);
    const pkg = ok(await adapterWith().poll(makeCtx(routes(), { tickIndex: LISTING_TICK, state }))).packages[0]!;
    const out = await adapterWith().fetchChangelog(makeCtx(fake), pkg, '1.0.0');
    expect(fake.calls).toHaveLength(1);
    expect('websiteUrl' in out).toBe(false);
  });
});
