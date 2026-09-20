// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PollResult, SourceAdapter } from '../core/ports.ts';
import type { SourceConfig } from '../core/types.ts';
import { createFakeFetch, fixture, json, makeCtx, makeState, text } from './__fixtures__/fake-fetch.ts';
import { NexusAdapter, quotaLow } from './nexus.ts';

const enabled: SourceConfig = { id: 'nexus:valheim', store: 'nexus', community: 'valheim', enabled: true };
const disabled: SourceConfig = { ...enabled, enabled: false };
const API = 'https://api.nexusmods.com/v1/games/valheim';
const KEY = 'TOP-SECRET-KEY';
const secrets = { NEXUS_API_KEY: KEY };

const BASE = 1_789_776_000;
const iso = (offsetSeconds: number): string => `${new Date((BASE + offsetSeconds) * 1000).toISOString().slice(0, 19)}.000000Z`;

function ok(r: PollResult): Extract<PollResult, { status: 'ok' }> {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  return r;
}

function routes(extra: Array<[string, () => Response]> = []) {
  return createFakeFetch([
    ...extra,
    [`${API}/mods/updated.json`, () => text(fixture('nexus-updated.json'))],
    [`${API}/mods/latest_added.json`, () => text(fixture('nexus-latest-added.json'))],
    [`${API}/mods/102.json`, () => text(fixture('nexus-mod-102.json'))],
    [`${API}/mods/103.json`, () => text(fixture('nexus-mod-103.json'))],
    [`${API}/mods/101.json`, () => new Response('', { status: 404 })],
  ]);
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('NexusAdapter — disabled by default', () => {
  it('skips without any request when the source is not enabled, even with a key', async () => {
    const fake = routes();
    await expect(new NexusAdapter(disabled).poll(makeCtx(fake, { secrets }))).resolves.toEqual({ status: 'skipped' });
    expect(fake.calls).toHaveLength(0);
  });

  it('skips without any request when enabled but no key is present', async () => {
    const fake = routes();
    await expect(new NexusAdapter(enabled).poll(makeCtx(fake, { secrets: {} }))).resolves.toEqual({ status: 'skipped' });
    await expect(new NexusAdapter(enabled).poll(makeCtx(fake, { secrets: { NEXUS_API_KEY: '' } }))).resolves.toEqual({ status: 'skipped' });
    expect(fake.calls).toHaveLength(0);
  });

  it('does not fetch changelogs when disabled', async () => {
    const fake = routes();
    const pkg = { packageId: '102', url: 'https://www.nexusmods.com/valheim/mods/102' } as Parameters<NexusAdapter['fetchChangelog']>[1];
    await expect(new NexusAdapter(disabled).fetchChangelog(makeCtx(fake, { secrets }), pkg, '2.3.1')).resolves.toEqual({ excerpt: null, url: null });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('NexusAdapter.poll', () => {
  const adapter = new NexusAdapter(enabled);

  it('merges updated and latest-added mods newer than the cursor, resolving metadata with a cap', async () => {
    const fake = routes();
    const ctx = makeCtx(fake, { secrets, state: makeState({ cursor: iso(-2400) }) });
    const res = ok(await adapter.poll(ctx));

    expect(res.packages.map((p) => `${p.packageId}@${p.version}`)).toEqual(['102@2.3.1', '103@0.5.0', '104@1.0.0']);
    expect(res.cursor).toBe(iso(-300));
    expect(res.complete).toBe(true);
    expect(fake.callsTo('/mods/101.json')).toHaveLength(0);
    expect(res.packages[0]).toMatchObject({
      store: 'nexus',
      source: 'nexus:valheim',
      owner: 'Fletcher',
      name: 'Better Bows',
      url: 'https://www.nexusmods.com/valheim/mods/102',
    });
  });

  it('maps contains_adult_content to isNsfw', async () => {
    const res = ok(await adapter.poll(makeCtx(routes(), { secrets, state: makeState({ cursor: iso(-2400) }) })));
    expect(res.packages.find((p) => p.packageId === '103')?.isNsfw).toBe(true);
    expect(res.packages.find((p) => p.packageId === '102')?.isNsfw).toBe(false);
  });

  it('skips a mod whose metadata is 404 and moves the cursor past it', async () => {
    const res = ok(await adapter.poll(makeCtx(routes(), { secrets, state: makeState({ cursor: iso(-7200) }) })));
    expect(res.packages.map((p) => p.packageId)).toEqual(['102', '103', '104']);
    expect(res.cursor).toBe(iso(-300));
  });

  it('sends the key only to api.nexusmods.com and never logs it', async () => {
    const fake = routes();
    await adapter.poll(makeCtx(fake, { secrets, state: makeState({ cursor: iso(-7200) }) }));
    for (const call of fake.calls) {
      expect(new URL(call.url).hostname).toBe('api.nexusmods.com');
      expect(call.headers.apikey).toBe(KEY);
      expect(call.headers['user-agent']).toBeTruthy();
      expect(call.headers['application-name']).toBe('ratatoskr');
      expect(call.headers.authorization).toBeUndefined();
    }
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).not.toContain(KEY);
  });

  it('never logs the key on failure', async () => {
    const fake = createFakeFetch([['api.nexusmods.com', () => new Response('nope', { status: 500 })]]);
    await expect(adapter.poll(makeCtx(fake, { secrets }))).resolves.toEqual({ status: 'skipped' });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(KEY);
  });

  it('caps metadata lookups and defers the rest without advancing the cursor past them', async () => {
    const updated = Array.from({ length: 8 }, (_, i) => ({ mod_id: 200 + i, latest_file_update: BASE - 3000 + i * 60, latest_mod_activity: 0 }));
    const fake = createFakeFetch([
      [`${API}/mods/updated.json`, () => json(updated)],
      [`${API}/mods/latest_added.json`, () => json([])],
      [`${API}/mods/`, () => text(fixture('nexus-mod-102.json'))],
    ]);
    const res = ok(await adapter.poll(makeCtx(fake, { secrets, state: makeState({ cursor: iso(-4000) }) })));
    expect(fake.callsTo('/mods/2')).toHaveLength(5);
    expect(res.packages).toHaveLength(5);
    expect(res.cursor).toBe(iso(-3000 + 4 * 60));
    expect(res.complete).toBe(false);
  });

  it('backs off (skipped) when the hourly quota is nearly exhausted', async () => {
    const fake = createFakeFetch([
      [`${API}/mods/updated.json`, () => text(fixture('nexus-updated.json'), { 'x-rl-hourly-remaining': '10', 'x-rl-daily-remaining': '19000' })],
    ]);
    await expect(adapter.poll(makeCtx(fake, { secrets }))).resolves.toEqual({ status: 'skipped' });
    expect(fake.calls).toHaveLength(1);
  });

  it('stops looking up metadata mid-tick when the quota runs low', async () => {
    const fake = createFakeFetch([
      [`${API}/mods/updated.json`, () => text(fixture('nexus-updated.json'))],
      [`${API}/mods/latest_added.json`, () => text('[]')],
      [`${API}/mods/102.json`, () => text(fixture('nexus-mod-102.json'), { 'x-rl-daily-remaining': '5' })],
      [`${API}/mods/103.json`, () => text(fixture('nexus-mod-103.json'))],
      [`${API}/mods/101.json`, () => new Response('', { status: 404 })],
    ]);
    const res = ok(await adapter.poll(makeCtx(fake, { secrets, state: makeState({ cursor: iso(-2400) }) })));
    expect(res.packages.map((p) => p.packageId)).toEqual(['102']);
    expect(res.complete).toBe(false);
    expect(fake.callsTo('/mods/103.json')).toHaveLength(0);
  });

  it('clamps a stored cursor from the future to now, so newer mods are not skipped forever', async () => {
    const fake = routes([[`${API}/mods/updated.json`, () => json([{ mod_id: 102, latest_file_update: BASE + 600 }])]]);
    const res = ok(await adapter.poll(makeCtx(fake, { secrets, state: makeState({ cursor: '2099-01-01T00:00:00.000000Z' }) })));
    expect(res.packages.map((p) => p.packageId)).toEqual(['102']);
    expect(res.cursor).toBe(iso(600));
  });

  it('holds a clamped cursor at now when nothing is newer', async () => {
    const fake = routes([[`${API}/mods/updated.json`, () => json([])], [`${API}/mods/latest_added.json`, () => json([])]]);
    const res = ok(await adapter.poll(makeCtx(fake, { secrets, state: makeState({ cursor: '2099-01-01T00:00:00.000000Z' }) })));
    expect(res.packages).toEqual([]);
    expect(res.cursor).toBe(iso(300));
  });

  it('cold start emits the latest-added mods and the newest bare ids, cursor at the maximum', async () => {
    const res = ok(await adapter.poll(makeCtx(routes(), { secrets, state: null })));
    expect(res.packages.map((p) => p.packageId).sort()).toEqual(['102', '103', '104']);
    expect(res.cursor).toBe(iso(-300));
  });

  it('returns skipped on changed payloads, 401/429 and network errors', async () => {
    for (const responder of [
      () => json({ error: 'x' }),
      () => new Response('', { status: 401 }),
      () => new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
      () => Promise.reject(new TypeError('down')),
    ]) {
      const fake = createFakeFetch([['api.nexusmods.com', responder]]);
      await expect(adapter.poll(makeCtx(fake, { secrets }))).resolves.toEqual({ status: 'skipped' });
    }
  });

  it('ignores unpublished or unavailable mods', async () => {
    const fake = createFakeFetch([
      [`${API}/mods/updated.json`, () => json([{ mod_id: 300, latest_file_update: BASE - 60, latest_mod_activity: 0 }])],
      [`${API}/mods/latest_added.json`, () => json([])],
      [`${API}/mods/300.json`, () => json({ mod_id: 300, name: 'Hidden', version: '1.0', status: 'hidden', available: false, updated_timestamp: BASE - 60 })],
    ]);
    const res = ok(await adapter.poll(makeCtx(fake, { secrets, state: makeState({ cursor: iso(-600) }) })));
    expect(res.packages).toEqual([]);
    expect(res.cursor).toBe(iso(-60));
  });
});

describe('quotaLow', () => {
  it('flags either window under five percent and ignores absent headers', () => {
    expect(quotaLow(new Headers())).toBe(false);
    expect(quotaLow(new Headers({ 'x-rl-hourly-remaining': '99' }))).toBe(true);
    expect(quotaLow(new Headers({ 'x-rl-hourly-remaining': '100' }))).toBe(false);
    expect(quotaLow(new Headers({ 'x-rl-daily-remaining': '999' }))).toBe(true);
    expect(quotaLow(new Headers({ 'x-rl-daily-remaining': '1000', 'x-rl-hourly-remaining': '1500' }))).toBe(false);
  });
});

describe('NexusAdapter.fetchChangelog', () => {
  const adapter = new NexusAdapter(enabled);
  const pkg = { packageId: '102', url: 'https://www.nexusmods.com/valheim/mods/102' } as Parameters<NexusAdapter['fetchChangelog']>[1];

  it('extracts the version entry from changelogs.json', async () => {
    const fake = createFakeFetch([[`${API}/mods/102/changelogs.json`, () => text(fixture('nexus-changelogs.json'))]]);
    const out = await adapter.fetchChangelog(makeCtx(fake, { secrets }), pkg, '2.3.1');
    expect(out.url).toBe('https://www.nexusmods.com/valheim/mods/102?tab=logs');
    expect(out.excerpt).toContain('Fixed crash on load');
    expect(fake.calls[0]?.headers.apikey).toBe(KEY);
  });

  it('returns nulls for an unknown version or a failing endpoint', async () => {
    const fake = createFakeFetch([[`${API}/mods/102/changelogs.json`, () => text(fixture('nexus-changelogs.json'))]]);
    expect((await adapter.fetchChangelog(makeCtx(fake, { secrets }), pkg, '9.9.9')).excerpt).toBeNull();
    const failing = createFakeFetch([['api.nexusmods.com', () => new Response('', { status: 500 })]]);
    expect(await adapter.fetchChangelog(makeCtx(failing, { secrets }), pkg, '2.3.1')).toEqual({ excerpt: null, url: null });
  });
});

it('has no reconcile', () => {
  const adapter: SourceAdapter = new NexusAdapter(enabled);
  expect(adapter.reconcile).toBeUndefined();
});

describe('NexusAdapter — hostile timestamps', () => {
  const adapter = new NexusAdapter(enabled);
  const cursor = makeState({ cursor: iso(-4000) });

  it.each([1e20, -5, Number.MAX_SAFE_INTEGER, 8.64e15])('skips an updated.json row with latest_file_update %s and still processes the rest', async (bad) => {
    const fake = createFakeFetch([
      [`${API}/mods/updated.json`, () => json([{ mod_id: 400, latest_file_update: bad }, { mod_id: 102, latest_file_update: BASE - 600 }])],
      [`${API}/mods/latest_added.json`, () => json([])],
      [`${API}/mods/102.json`, () => text(fixture('nexus-mod-102.json'))],
    ]);
    const res = ok(await adapter.poll(makeCtx(fake, { secrets, state: cursor })));
    expect(res.packages.map((p) => p.packageId)).toEqual(['102']);
    expect(fake.callsTo('/mods/400.json')).toHaveLength(0);
  });

  it('falls back to created_timestamp when updated_timestamp of a latest-added mod is out of range', async () => {
    const mod = { mod_id: 500, name: 'Odd', version: '1.0', author: 'a', updated_timestamp: 1e20, created_timestamp: BASE - 120, contains_adult_content: false, status: 'published', available: true };
    const fake = createFakeFetch([
      [`${API}/mods/updated.json`, () => json([])],
      [`${API}/mods/latest_added.json`, () => json([mod])],
    ]);
    const res = ok(await adapter.poll(makeCtx(fake, { secrets, state: cursor })));
    expect(res.packages.map((p) => [p.packageId, p.updatedAt])).toEqual([['500', iso(-120)]]);
    expect(res.cursor).toBe(iso(-120));
  });

  it('uses the listing timestamp when the metadata timestamp is out of range', async () => {
    const meta = { mod_id: 600, name: 'Odd', version: '1.0', author: 'a', updated_timestamp: 1e20, contains_adult_content: false, status: 'published', available: true };
    const fake = createFakeFetch([
      [`${API}/mods/updated.json`, () => json([{ mod_id: 600, latest_file_update: BASE - 300 }])],
      [`${API}/mods/latest_added.json`, () => json([])],
      [`${API}/mods/600.json`, () => json(meta)],
    ]);
    const res = ok(await adapter.poll(makeCtx(fake, { secrets, state: cursor })));
    expect(res.packages[0]?.updatedAt).toBe(iso(-300));
  });
});

describe('NexusAdapter — adult content fails closed', () => {
  const adapter = new NexusAdapter(enabled);

  async function flagged(mutate: (mod: Record<string, unknown>) => void) {
    const mod = JSON.parse(fixture('nexus-mod-102.json')) as Record<string, unknown>;
    mutate(mod);
    const fake = createFakeFetch([
      [`${API}/mods/updated.json`, () => json([{ mod_id: 102, latest_file_update: BASE - 600 }])],
      [`${API}/mods/latest_added.json`, () => json([])],
      [`${API}/mods/102.json`, () => json(mod)],
    ]);
    return ok(await adapter.poll(makeCtx(fake, { secrets, state: makeState({ cursor: iso(-4000) }) }))).packages[0];
  }

  it.each([
    ['missing', (mod: Record<string, unknown>) => void delete mod.contains_adult_content],
    ['null', (mod: Record<string, unknown>) => void (mod.contains_adult_content = null)],
    ['a string', (mod: Record<string, unknown>) => void (mod.contains_adult_content = 'false')],
    ['a number', (mod: Record<string, unknown>) => void (mod.contains_adult_content = 0)],
  ])('marks a mod adult when its flag is %s', async (_label, mutate) => {
    expect((await flagged(mutate))?.isNsfw).toBe(true);
  });

  it('keeps an explicit false as safe', async () => {
    expect((await flagged(() => {}))?.isNsfw).toBe(false);
  });

  it('leaves previousVersion unknown', async () => {
    expect((await flagged(() => {}))?.previousVersion).toBeUndefined();
  });
});

describe('NexusAdapter.fetchChangelog — hardening', () => {
  const adapter = new NexusAdapter(enabled);
  const pkg = { packageId: '102', url: 'https://www.nexusmods.com/valheim/mods/102' } as Parameters<NexusAdapter['fetchChangelog']>[1];

  it('refuses a changelog body above the changelog cap without parsing it', async () => {
    const huge = JSON.stringify({ '2.3.1': Array.from({ length: 30_000 }, (_, i) => `line ${i} of a very long changelog`) });
    expect(huge.length).toBeGreaterThan(300_000);
    const fake = createFakeFetch([[`${API}/mods/102/changelogs.json`, () => text(huge)]]);
    const parse = vi.spyOn(JSON, 'parse');
    expect(await adapter.fetchChangelog(makeCtx(fake, { secrets }), pkg, '2.3.1')).toEqual({ excerpt: null, url: null });
    expect(parse).not.toHaveBeenCalled();
  });

  it('ignores versions whose value is not a list of strings', async () => {
    const body = { '2.3.1': 'not a list', '2.3.0': { a: 1 }, '2.2.0': ['fine', 7, null] };
    const fake = createFakeFetch([[`${API}/mods/102/changelogs.json`, () => json(body)]]);
    expect((await adapter.fetchChangelog(makeCtx(fake, { secrets }), pkg, '2.3.1')).excerpt).toBeNull();
    expect((await adapter.fetchChangelog(makeCtx(fake, { secrets }), pkg, '2.2.0')).excerpt).toContain('fine');
  });

  it('returns nulls for a body that is not an object', async () => {
    for (const body of [[], 'x', 5, null]) {
      const fake = createFakeFetch([[`${API}/mods/102/changelogs.json`, () => json(JSON.stringify(body))]]);
      expect(await adapter.fetchChangelog(makeCtx(fake, { secrets }), pkg, '2.3.1')).toEqual({ excerpt: null, url: null });
    }
  });
});
