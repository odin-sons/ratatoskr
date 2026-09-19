// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceConfig } from '../core/types.ts';
import type { PollResult } from '../core/ports.ts';
import { createFakeFetch, fixture, json, makeCtx, makeState, text } from './__fixtures__/fake-fetch.ts';
import { HexiumAdapter, scanPackageIndex } from './hexium.ts';

const config: SourceConfig = { id: 'hexium:valheim', store: 'hexium', community: 'valheim', enabled: true };
const ORIGIN = 'https://valheim.hexium.gg';
const LISTING = `${ORIGIN}/api/experimental/frontend/packages/?page=1`;
const INDEX = `${ORIGIN}/api/experimental/package-index/`;
const listingFixture = fixture('hexium-listing.json');
const indexFixture = fixture('hexium-index.ndjson');
const detailFixture = fixture('hexium-detail.json');

function adapterWith(known: Record<string, string>): HexiumAdapter {
  return new HexiumAdapter(config, { getAllKnownVersions: async () => new Map(Object.entries(known)) });
}

function ok(r: PollResult): Extract<PollResult, { status: 'ok' }> {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  return r;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('HexiumAdapter.poll — listing', () => {
  it('maps every listing item, including NSFW and deprecated flags', async () => {
    const body = JSON.parse(listingFixture) as { packages: Record<string, unknown>[] };
    body.packages[0]!.has_nsfw_content = true;
    body.packages[1]!.is_deprecated = true;
    const fake = createFakeFetch([[LISTING, () => json(body)]]);
    const res = ok(await adapterWith({}).poll(makeCtx(fake, { tickIndex: 1 })));

    expect(res.packages).toHaveLength(4);
    expect(res.packages[0]).toMatchObject({
      source: 'hexium:valheim',
      store: 'hexium',
      packageId: 'GenesisMods-zzzGenesisItemStacks',
      owner: 'GenesisMods',
      name: 'zzzGenesisItemStacks',
      version: '2.1.0',
      url: 'https://valheim.hexium.gg/mods/GenesisMods/zzzGenesisItemStacks',
      isNsfw: true,
      updatedAt: '2026-09-18T23:14:08.000000Z',
    });
    expect(res.packages[1]?.isDeprecated).toBe(true);
    expect(res.packages[2]?.isNsfw).toBe(false);
    expect(res.cursor).toBe('2026-09-18T23:14:08.000000Z');
    expect(res.complete).toBe(true);
  });

  it('does not filter the creation-ordered listing by cursor', async () => {
    const fake = createFakeFetch([[LISTING, () => text(listingFixture)]]);
    const res = ok(await adapterWith({}).poll(makeCtx(fake, { state: makeState({ cursor: '2030-01-01T00:00:00.000000Z' }) })));
    expect(res.packages).toHaveLength(4);
    expect(res.cursor).toBe('2030-01-01T00:00:00.000000Z');
  });

  it('honours a 304 on non-index ticks and sends the stored validator', async () => {
    const fake = createFakeFetch([[LISTING, () => new Response(null, { status: 304 })]]);
    const res = await adapterWith({}).poll(makeCtx(fake, { tickIndex: 1, state: makeState({ etag: '"h1"' }) }));
    expect(res).toEqual({ status: 'not-modified', etag: '"h1"' });
    expect(fake.calls[0]?.headers['if-none-match']).toBe('"h1"');
  });

  it('stores a returned ETag', async () => {
    const fake = createFakeFetch([[LISTING, () => text(listingFixture, { etag: '"h2"' })]]);
    const res = ok(await adapterWith({}).poll(makeCtx(fake, { tickIndex: 1 })));
    expect(res.etag).toBe('"h2"');
  });

  it('returns skipped on a changed payload, 5xx and network errors', async () => {
    for (const responder of [
      () => json({ items: [] }),
      () => new Response('', { status: 502 }),
      () => Promise.reject(new TypeError('down')),
      () => json({ packages: [{ nope: true }] }),
    ]) {
      const fake = createFakeFetch([[LISTING, responder]]);
      await expect(adapterWith({}).poll(makeCtx(fake))).resolves.toEqual({ status: 'skipped' });
    }
  });

  it('always sends a User-Agent and never credentials', async () => {
    const fake = createFakeFetch([
      [LISTING, () => text(listingFixture)],
      [INDEX, () => text(indexFixture)],
      ['/frontend/p/', () => text(detailFixture)],
    ]);
    const ctx = makeCtx(fake, { tickIndex: 3, secrets: { NEXUS_API_KEY: 'SECRET' } });
    await adapterWith({ 'Smoothbrain-Building': '0.9.0' }).poll(ctx);
    expect(fake.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of fake.calls) {
      expect(call.headers['user-agent']).toBe(ctx.userAgent);
      expect(call.headers.apikey).toBeUndefined();
      expect(call.headers.authorization).toBeUndefined();
      expect(new URL(call.url).hostname).toBe('valheim.hexium.gg');
    }
  });
});

describe('HexiumAdapter.poll — split cadence', () => {
  const known = { 'Smoothbrain-Building': '1.2.6', 'Smoothbrain-Afterdeath': '1.0.9', 'GenesisMods-NordGuide': '1.0.3' };

  function routes() {
    return createFakeFetch([
      [LISTING, () => text(listingFixture)],
      [INDEX, () => text(indexFixture)],
      ['/frontend/p/Smoothbrain/Building/', () => text(detailFixture)],
    ]);
  }

  it('skips the index on non-multiples of the cadence', async () => {
    for (const tickIndex of [1, 2, 4, 5]) {
      const fake = routes();
      const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex })));
      expect(fake.callsTo('package-index')).toHaveLength(0);
      expect(res.packages.map((p) => p.packageId)).not.toContain('Smoothbrain-Building');
    }
  });

  it('scans the index on tickIndex 0 and 3 and reports only known packages whose version changed', async () => {
    for (const tickIndex of [0, 3, 6]) {
      const fake = routes();
      const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex })));
      expect(fake.callsTo('package-index')).toHaveLength(1);
      const building = res.packages.find((p) => p.packageId === 'Smoothbrain-Building');
      expect(building).toMatchObject({ version: '1.2.7', owner: 'Smoothbrain', name: 'Building', store: 'hexium' });
      expect(res.packages.map((p) => p.packageId)).not.toContain('Smoothbrain-Afterdeath');
      expect(res.packages.map((p) => p.packageId)).not.toContain('denikson-BepInExPack_Valheim');
      expect(res.packages.filter((p) => p.packageId.startsWith('GenesisMods-'))).toHaveLength(3);
    }
  });

  it('enriches index hits with package detail and index file size', async () => {
    const res = ok(await adapterWith(known).poll(makeCtx(routes(), { tickIndex: 0 })));
    const building = res.packages.find((p) => p.packageId === 'Smoothbrain-Building');
    expect(building?.iconUrl).toBe('https://cdn.hexium.gg/upload/1/icon.png');
    expect(building?.categories).toEqual(['Valheim 1.0', 'Client & Server']);
    expect(building?.updatedAt).toBe('2026-09-09T12:30:12.000000Z');
    expect(building?.sizeBytes).toBeGreaterThan(0);
  });

  it('falls back to a minimal snapshot when the detail lookup fails', async () => {
    const fake = createFakeFetch([
      [LISTING, () => text(listingFixture)],
      [INDEX, () => text(indexFixture)],
      ['/frontend/p/', () => new Response('', { status: 500 })],
    ]);
    const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: 0 })));
    const building = res.packages.find((p) => p.packageId === 'Smoothbrain-Building');
    expect(building).toMatchObject({ version: '1.2.7', iconUrl: null, description: null, isNsfw: false });
    expect(building?.updatedAt).toBe('2026-09-19T00:05:00.000000Z');
  });

  it('keeps the listing snapshot when the index shows the same version', async () => {
    const fake = createFakeFetch([
      [LISTING, () => text(listingFixture)],
      [INDEX, () => text(`{"namespace":"GenesisMods","name":"NordGuide","version_number":"1.0.3","file_size":1,"dependencies":[]}`)],
    ]);
    const res = ok(await adapterWith({ 'GenesisMods-NordGuide': '0.9.0' }).poll(makeCtx(fake, { tickIndex: 0 })));
    expect(fake.callsTo('/frontend/p/')).toHaveLength(0);
    expect(res.packages.find((p) => p.packageId === 'GenesisMods-NordGuide')?.description).not.toBeNull();
  });

  it('skips the index scan before the source is bootstrapped', async () => {
    const fake = routes();
    const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: 0, state: makeState({ bootstrapped: false }) })));
    expect(fake.callsTo('package-index')).toHaveLength(0);
    expect(res.packages).toHaveLength(4);
    const cold = ok(await adapterWith(known).poll(makeCtx(routes(), { tickIndex: 0, state: null })));
    expect(cold.packages).toHaveLength(4);
  });

  it('never sends a conditional request for the listing on index ticks', async () => {
    const fake = routes();
    await adapterWith(known).poll(makeCtx(fake, { tickIndex: 0, state: makeState({ etag: '"h1"' }) }));
    expect(fake.callsTo('frontend/packages')[0]?.headers['if-none-match']).toBeUndefined();
  });

  it('still returns the listing when the index scan fails', async () => {
    const fake = createFakeFetch([
      [LISTING, () => text(listingFixture)],
      [INDEX, () => new Response('', { status: 500 })],
    ]);
    const res = ok(await adapterWith(known).poll(makeCtx(fake, { tickIndex: 0 })));
    expect(res.packages).toHaveLength(4);
  });

  it('caps detail lookups per tick but still returns every changed package', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `{"namespace":"N","name":"M${i}","version_number":"2.0.0","file_size":10,"dependencies":[],"suggestions":[]}`);
    const knownMany = Object.fromEntries(lines.map((_, i) => [`N-M${i}`, '1.0.0']));
    const fake = createFakeFetch([
      [LISTING, () => text(listingFixture)],
      [INDEX, () => text(lines.join('\n'))],
      ['/frontend/p/', () => text(detailFixture)],
    ]);
    const res = ok(await adapterWith(knownMany).poll(makeCtx(fake, { tickIndex: 0 })));
    expect(fake.callsTo('/frontend/p/')).toHaveLength(10);
    expect(res.packages.filter((p) => p.owner === 'N')).toHaveLength(25);
  });
});

describe('HexiumAdapter.reconcile', () => {
  it('returns every index package with no cursor filtering', async () => {
    const fake = createFakeFetch([[INDEX, () => text(indexFixture)]]);
    const out = await adapterWith({}).reconcile!(makeCtx(fake, { state: makeState({ cursor: '2099-01-01T00:00:00.000000Z' }) }));
    expect(out).toHaveLength(6);
    expect(out[0]).toMatchObject({ packageId: 'denikson-BepInExPack_Valheim', version: '5.4.2350', sizeBytes: 705576, store: 'hexium' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe(INDEX);
  });

  it('throws on upstream failure rather than returning an empty sweep', async () => {
    const fake = createFakeFetch([[INDEX, () => new Response('', { status: 503 })]]);
    await expect(adapterWith({}).reconcile!(makeCtx(fake))).rejects.toThrow();
  });

  it('throws when the body has no usable line', async () => {
    const fake = createFakeFetch([[INDEX, () => text('<html>maintenance</html>')]]);
    await expect(adapterWith({}).reconcile!(makeCtx(fake))).rejects.toThrow();
  });

  it('scans a synthetic 1100-line index quickly (CPU cost documented, loose bound)', async () => {
    const lines = Array.from(
      { length: 1100 },
      (_, i) =>
        `{"namespace":"Owner${i % 90}","name":"Mod${i}","version_number":"1.${i % 20}.${i % 7}","file_format":"zip","file_size":${10_000 + i},"dependencies":["denikson-BepInExPack_Valheim-5.4.2350","Owner${i % 90}-Dep${i}-1.0.0"],"suggestions":[]}`,
    );
    const body = lines.join('\n');
    const fake = createFakeFetch([[INDEX, () => text(body)]]);
    const ctx = makeCtx(fake);
    const adapter = adapterWith({});
    await adapter.reconcile!(ctx);
    const runs = 5;
    const start = performance.now();
    let count = 0;
    for (let i = 0; i < runs; i += 1) scanPackageIndex(body, () => (count += 1));
    const perScanMs = (performance.now() - start) / runs;
    console.info(`[cpu-note] scanPackageIndex: ${body.length} bytes, 1100 lines, ${perScanMs.toFixed(2)} ms per scan (Node, warm)`);
    expect(count).toBe(1100 * runs);
    expect(perScanMs).toBeLessThan(25);
  });
});

describe('scanPackageIndex', () => {
  it('falls back to JSON.parse for lines with escaped values and skips garbage', () => {
    const text2 = [
      `{"namespace":"A","name":"B","version_number":"1.0.0","file_size":5}`,
      `{"namespace":"C\\u0041","name":"D","version_number":"2.0.0"}`,
      `not json at all`,
      `{"namespace":"E","name":"F"}`,
      ``,
    ].join('\r\n');
    const seen: string[] = [];
    scanPackageIndex(text2, (e) => seen.push(`${e.namespace}/${e.name}@${e.version}:${e.fileSize}`));
    expect(seen).toEqual(['A/B@1.0.0:5', 'CA/D@2.0.0:null']);
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
    const out = await adapterWith({}).fetchChangelog(makeCtx(fake), pkg, '5.4.2350');
    expect(out.url).toBe(pkg.url);
    expect(out.excerpt).toContain('Updated to BepInEx');
    expect(fake.calls[0]?.headers['user-agent']).toBeTruthy();
  });

  it('returns nulls on failure', async () => {
    const fake = createFakeFetch([['/changelog/', () => new Response('', { status: 500 })]]);
    expect(await adapterWith({}).fetchChangelog(makeCtx(fake), pkg, '5.4.2350')).toEqual({ excerpt: null, url: null });
  });
});
