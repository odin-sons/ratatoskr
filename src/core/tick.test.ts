// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { FakeAdapter, FIXED_NOW_ISO, clientError, makeEvent, makeSnapshot, makeSubscription, okPoll, rateLimited } from '../testing/fakes.ts';
import { makeHarness, type Harness } from '../testing/harness.ts';
import { DISCORD, TICK_BUDGET } from './constants.ts';
import { eventId, outboxId } from './ids.ts';
import { renderDigest, renderImmediate } from '../render/index.ts';
import { runTick } from './tick.ts';
import type { PackageSnapshot } from './types.ts';

const TS = 'thunderstore:valheim';
const HX = 'hexium:valheim';
const scheduled = Date.parse(FIXED_NOW_ISO);

const snap = (packageId: string, version = '1.0.0', extra: Partial<PackageSnapshot> = {}): PackageSnapshot => {
  const [owner = 'Owner', ...rest] = packageId.split('-');
  return makeSnapshot({ packageId, owner, name: rest.join('-') || 'Mod', version, ...extra });
};

function bootstrap(h: Harness, source: string, versions: Record<string, string>, cursor: string | null = 'c0'): void {
  h.store.seedPackages(source, versions);
  h.store.sources.set(source, { id: source, cursor, etag: 'e0', bootstrapped: true, lastOkAt: '2026-09-19T11:00:00.000Z' });
}

describe('runTick: cold start', () => {
  it('seeds packages and state without emitting, then emits on the next tick', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });

    adapter.enqueue(okPoll([snap('A-One'), snap('B-Two')], { cursor: 'c1', etag: 'e1' }));
    const first = await runTick(h.deps, scheduled);
    expect(first.sources[TS]).toEqual({ status: 'cold-start', events: 0 });
    expect(h.sender.calls).toHaveLength(0);
    expect(h.store.events.size).toBe(0);
    expect(h.store.packages.size).toBe(2);
    expect(h.store.sources.get(TS)).toMatchObject({ bootstrapped: true, cursor: 'c1', etag: 'e1' });
    expect(adapter.pollCalls[0]!.state).toBeNull();

    adapter.enqueue(okPoll([snap('A-One', '1.1.0'), snap('C-Three')], { cursor: 'c2' }));
    const second = await runTick(h.deps, scheduled + 300_000);
    expect(second.sources[TS]).toEqual({ status: 'ok', events: 2 });
    expect(second.sent).toBe(2);
    expect(adapter.pollCalls[1]!.state).toMatchObject({ bootstrapped: true, cursor: 'c1' });
    expect(h.store.sources.get(TS)!.cursor).toBe('c2');
  });

  it('passes tickIndex = floor(scheduledTime / 5min)', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter] });
    adapter.enqueue({ status: 'skipped' });
    await runTick(h.deps, 7 * 300_000 + 12_345);
    expect(adapter.pollCalls[0]!.tickIndex).toBe(7);
  });

  it('seeds silently when an unbootstrapped state row exists', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    h.store.sources.set(TS, { id: TS, cursor: null, etag: null, bootstrapped: false, lastOkAt: null });
    adapter.enqueue(okPoll([snap('A-One')]));
    const report = await runTick(h.deps, scheduled);
    expect(report.sources[TS]!.status).toBe('cold-start');
    expect(h.sender.calls).toHaveLength(0);
  });
});

describe('runTick: staged cold start', () => {
  const hx = { source: HX, store: 'hexium' } as const;

  it('stays un-bootstrapped and silent while the adapter reports an incomplete seed', async () => {
    const adapter = new FakeAdapter({ id: HX });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });

    adapter.enqueue(okPoll([snap('A-One', '1.0.0', hx)], { cursor: 'seed:1', complete: false }));
    const first = await runTick(h.deps, scheduled);
    expect(first.sources[HX]).toEqual({ status: 'cold-start', events: 0 });
    expect(h.store.sources.get(HX)).toMatchObject({ bootstrapped: false, cursor: 'seed:1' });

    adapter.enqueue(okPoll([snap('B-Two', '1.0.0', hx)], { cursor: 'seed:2', complete: false }));
    await runTick(h.deps, scheduled + 300_000);
    expect(h.store.sources.get(HX)).toMatchObject({ bootstrapped: false, cursor: 'seed:2' });
    expect(adapter.pollCalls[1]!.state).toMatchObject({ bootstrapped: false, cursor: 'seed:1' });

    adapter.enqueue(okPoll([snap('C-Three', '1.0.0', hx)], { cursor: 'c-final', complete: true }));
    await runTick(h.deps, scheduled + 600_000);
    expect(h.store.sources.get(HX)).toMatchObject({ bootstrapped: true, cursor: 'c-final' });
    expect(h.store.packages.size).toBe(3);
    expect(h.store.events.size).toBe(0);
    expect(h.sender.calls).toHaveLength(0);

    adapter.enqueue(okPoll([snap('B-Two', '1.1.0', hx)]));
    const after = await runTick(h.deps, scheduled + 900_000);
    expect(after.sources[HX]).toEqual({ status: 'ok', events: 1 });
  });

  it('bootstraps immediately when the first poll is complete', async () => {
    const adapter = new FakeAdapter({ id: HX });
    const h = makeHarness({ adapters: [adapter] });
    adapter.enqueue(okPoll([snap('A-One', '1.0.0', hx)], { cursor: 'c1' }));
    await runTick(h.deps, scheduled);
    expect(h.store.sources.get(HX)!.bootstrapped).toBe(true);
  });
});

describe('store upsert', () => {
  it('keeps richer stored fields when a later snapshot lacks them', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, {});
    h.store.packages.set(`${TS}|A-One`, snap('A-One', '1.0.0', { description: 'kept', isNsfw: true, iconUrl: 'https://i/x.png' }));
    adapter.enqueue(okPoll([snap('A-One', '2.0.0', { description: null, isNsfw: false, iconUrl: null })]));
    await runTick(h.deps, scheduled);
    expect(h.store.packages.get(`${TS}|A-One`)).toMatchObject({ version: '2.0.0', description: 'kept', isNsfw: true, iconUrl: 'https://i/x.png' });
  });
});

describe('runTick: crash safety', () => {
  it('does not advance the cursor when the commit throws, and the re-run is idempotent', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'digest' })] });
    bootstrap(h, TS, { 'A-One': '1.0.0' });

    adapter.enqueue(okPoll([snap('A-One', '2.0.0')], { cursor: 'c1' }));
    h.store.failNextCommit();
    const failed = await runTick(h.deps, scheduled);
    expect(failed.sources[TS]).toMatchObject({ status: 'error', events: 0 });
    expect(h.store.sources.get(TS)!.cursor).toBe('c0');
    expect(h.store.events.size).toBe(0);
    expect(h.store.outboxRows()).toHaveLength(0);

    adapter.enqueue(okPoll([snap('A-One', '2.0.0')], { cursor: 'c1' }));
    const retried = await runTick(h.deps, scheduled + 300_000);
    expect(retried.sources[TS]).toEqual({ status: 'ok', events: 1 });
    expect([...h.store.events.keys()]).toEqual([eventId(TS, 'A-One', '2.0.0')]);
    expect(h.store.outboxRows()).toHaveLength(1);
    expect(h.store.sources.get(TS)!.cursor).toBe('c1');

    adapter.enqueue(okPoll([snap('A-One', '2.0.0')], { cursor: 'c1' }));
    const again = await runTick(h.deps, scheduled + 600_000);
    expect(again.sources[TS]!.events).toBe(0);
    expect(h.store.outboxRows()).toHaveLength(1);
  });

  it('the UNIQUE outbox pair prevents double fan-out when the same batch is committed twice', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('A-One')]));
    await runTick(h.deps, scheduled);
    const [row] = h.store.outboxRows();
    await h.store.commit({
      source: TS,
      packages: [],
      events: [h.store.events.get(eventId(TS, 'A-One', '1.0.0'))!],
      outbox: [{ id: outboxId('sub-1', eventId(TS, 'A-One', '1.0.0')), subscriptionId: 'sub-1', eventId: eventId(TS, 'A-One', '1.0.0'), attempts: 0, nextAttemptAt: FIXED_NOW_ISO }],
      state: h.store.sources.get(TS)!,
    });
    expect(h.store.outboxRows()).toHaveLength(1);
    expect(h.store.outboxRows()[0]).toMatchObject({ id: row!.id, delivered: true });
    expect(h.sender.calls).toHaveLength(1);
  });
});

describe('runTick: releases that already have an event', () => {
  it('neither stores nor fans out an event that exists, but still upserts the package and advances the cursor', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, { 'A-One': '2.0.0' });
    const old = makeEvent({ pkg: { packageId: 'A-One', owner: 'A', name: 'One', version: '1.0.0' }, changelog: 'kept' });
    h.store.events.set(old.id, old);
    const spy = vi.spyOn(h.store, 'existingEventIds');

    adapter.enqueue(okPoll([snap('A-One', '1.0.0'), snap('B-Two', '1.0.0')], { cursor: 'c1' }));
    const report = await runTick(h.deps, scheduled);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(report.sources[TS]).toEqual({ status: 'ok', events: 1 });
    expect(h.sender.calls).toHaveLength(1);
    expect(h.store.events.get(old.id)).toMatchObject({ changelog: 'kept' });
    expect(h.store.outboxRows().map((r) => r.eventId)).toEqual([eventId(TS, 'B-Two', '1.0.0')]);
    expect(h.store.packages.get(`${TS}|A-One`)).toMatchObject({ version: '1.0.0' });
    expect(h.store.sources.get(TS)!.cursor).toBe('c1');
  });

  it('fetches no changelog for an event that already exists', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, { 'A-One': '2.0.0' });
    const old = makeEvent({ pkg: { packageId: 'A-One', owner: 'A', name: 'One', version: '1.0.0' } });
    h.store.events.set(old.id, old);
    adapter.enqueue(okPoll([snap('A-One', '1.0.0')]));
    const report = await runTick(h.deps, scheduled);
    expect(report.changelogFetches).toBe(0);
  });

  it('does not query the store when nothing changed', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, { 'A-One': '1.0.0' });
    const spy = vi.spyOn(h.store, 'existingEventIds');
    adapter.enqueue(okPoll([snap('A-One', '1.0.0')]));
    await runTick(h.deps, scheduled);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('runTick: isolation and statuses', () => {
  it('a failing adapter does not block the others or throw', async () => {
    const bad = new FakeAdapter({ id: HX });
    const good = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [bad, good], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, {});
    bootstrap(h, HX, {});
    bad.enqueue(new Error('hexium exploded'));
    good.enqueue(okPoll([snap('A-One')]));
    const report = await runTick(h.deps, scheduled);
    expect(report.sources[HX]).toEqual({ status: 'error', events: 0, error: 'hexium exploded' });
    expect(report.sources[TS]).toEqual({ status: 'ok', events: 1 });
    expect(report.sent).toBe(1);
  });

  it('touches etag and last_ok_at on not-modified and leaves the cursor alone', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter] });
    bootstrap(h, TS, {});
    adapter.enqueue({ status: 'not-modified', etag: 'e9' });
    const report = await runTick(h.deps, scheduled);
    expect(report.sources[TS]!.status).toBe('not-modified');
    expect(h.store.sources.get(TS)).toMatchObject({ cursor: 'c0', etag: 'e9', lastOkAt: FIXED_NOW_ISO, bootstrapped: true });
    expect(h.store.commitCount).toBe(0);
  });

  it('writes nothing for a skipped source', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter] });
    bootstrap(h, TS, {});
    const before = { ...h.store.sources.get(TS)! };
    adapter.enqueue({ status: 'skipped' });
    const report = await runTick(h.deps, scheduled);
    expect(report.sources[TS]!.status).toBe('skipped');
    expect(h.store.sources.get(TS)).toEqual(before);
  });

  it('does not poll disabled sources', async () => {
    const adapter = new FakeAdapter({ id: TS, enabled: false });
    const h = makeHarness({ adapters: [adapter] });
    const report = await runTick(h.deps, scheduled);
    expect(report.sources[TS]!.status).toBe('disabled');
    expect(adapter.pollCalls).toHaveLength(0);
  });

  it('reports errors instead of throwing when subscriptions cannot be loaded', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter] });
    h.store.listSubscriptions = async () => {
      throw new Error('d1 down');
    };
    const report = await runTick(h.deps, scheduled);
    expect(report.sources[TS]!.status).toBe('error');
    expect(adapter.pollCalls).toHaveLength(0);
  });
});

describe('runTick: budgets', () => {
  it('polls at most maxListingFetches adapters per tick and defers the rest', async () => {
    const adapters = Array.from({ length: TICK_BUDGET.maxListingFetches + 2 }, (_, i) => new FakeAdapter({ id: `nexus:g${i}` }));
    const h = makeHarness({ adapters });
    for (const a of adapters) a.enqueue({ status: 'not-modified', etag: null });
    const report = await runTick(h.deps, scheduled);
    expect(adapters.filter((a) => a.pollCalls.length > 0)).toHaveLength(TICK_BUDGET.maxListingFetches);
    expect(Object.values(report.sources).filter((s) => s.status === 'deferred')).toHaveLength(2);
    expect(report.deferred).toBe(2);
  });

  it('rotates which sources are deferred between ticks', async () => {
    const adapters = Array.from({ length: TICK_BUDGET.maxListingFetches + 1 }, (_, i) => new FakeAdapter({ id: `nexus:g${i}` }));
    const h = makeHarness({ adapters });
    const deferredIn = async (tick: number): Promise<string> => {
      for (const a of adapters) a.enqueue({ status: 'not-modified', etag: null });
      const r = await runTick(h.deps, tick * 300_000);
      return Object.entries(r.sources).find(([, s]) => s.status === 'deferred')![0];
    };
    expect(await deferredIn(0)).not.toBe(await deferredIn(1));
  });

  it('skipped sources do not consume the listing budget', async () => {
    const adapters = Array.from({ length: TICK_BUDGET.maxListingFetches + 3 }, (_, i) => new FakeAdapter({ id: `nexus:g${i}` }));
    const h = makeHarness({ adapters });
    const report = await runTick(h.deps, scheduled);
    expect(adapters.every((a) => a.pollCalls.length === 1)).toBe(true);
    expect(report.deferred).toBe(0);
  });

  it('caps changelog fetches at maxChangelogFetches and reports the remainder as skipped, not deferred', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'digest' })] });
    bootstrap(h, TS, {});
    const total = TICK_BUDGET.maxChangelogFetches + 3;
    adapter.enqueue(okPoll(Array.from({ length: total }, (_, i) => snap(`A${i}-Mod`))));
    const report = await runTick(h.deps, scheduled);
    expect(report.changelogFetches).toBe(TICK_BUDGET.maxChangelogFetches);
    expect(adapter.changelogCalls).toHaveLength(TICK_BUDGET.maxChangelogFetches);
    expect(report.changelogSkipped).toBe(3);
    expect(report.deferred).toBe(0);
    const withChangelog = [...h.store.events.values()].filter((e) => e.changelog !== null);
    expect(withChangelog).toHaveLength(TICK_BUDGET.maxChangelogFetches);
    expect(withChangelog[0]!.changelogUrl).not.toBeNull();
  });

  it('fetches changelogs only for new events and watchlist-hit updates that reach a subscription', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const sub = makeSubscription({ mode: 'digest', filter: { watchlist: ['Star'] } });
    const h = makeHarness({ adapters: [adapter], subscriptions: [sub] });
    bootstrap(h, TS, { 'Star-Mod': '1.0.0', 'Plain-Mod': '1.0.0', 'Nsfw-Mod': '1.0.0' });
    adapter.enqueue(
      okPoll([
        snap('Star-Mod', '2.0.0'),
        snap('Plain-Mod', '2.0.0'),
        snap('Fresh-Mod'),
        snap('Nsfw-New', '1.0.0', { isNsfw: true }),
        snap('Nsfw-Mod', '2.0.0', { isNsfw: true, owner: 'Star' }),
      ]),
    );
    const report = await runTick(h.deps, scheduled);
    expect(adapter.changelogCalls.map((c) => c.pkg.packageId).sort()).toEqual(['Fresh-Mod', 'Star-Mod']);
    expect(report.changelogFetches).toBe(2);
  });

  it('fetches a changelog for every update delivered to an immediate subscription, but not for a digest one', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const imm = makeSubscription({ id: 'imm', mode: 'immediate', webhookUrl: 'https://discord.invalid/api/webhooks/1/a', filter: { sources: [TS] } });
    const h = makeHarness({ adapters: [adapter], subscriptions: [imm] });
    bootstrap(h, TS, { 'Plain-Mod': '1.0.0' });
    adapter.enqueue(okPoll([snap('Plain-Mod', '2.0.0')]));
    const report = await runTick(h.deps, scheduled);
    expect(report.changelogFetches).toBe(1);
    expect(h.renderer.immediateCalls[0]!.changelog).toBe('changelog Plain-Mod 2.0.0');

    const digestOnly = makeHarness({ adapters: [new FakeAdapter({ id: TS })], subscriptions: [makeSubscription({ mode: 'digest' })] });
    bootstrap(digestOnly, TS, { 'Plain-Mod': '1.0.0' });
    (digestOnly.adapters[0] as FakeAdapter).enqueue(okPoll([snap('Plain-Mod', '2.0.0')]));
    expect((await runTick(digestOnly.deps, scheduled)).changelogFetches).toBe(0);
  });

  it('renders immediate updates beyond the per-tick changelog cap without a changelog', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'immediate' })] });
    const total = TICK_BUDGET.maxChangelogFetches + 3;
    bootstrap(h, TS, Object.fromEntries(Array.from({ length: total }, (_, i) => [`A${i}-Mod`, '1.0.0'])));
    adapter.enqueue(okPoll(Array.from({ length: total }, (_, i) => snap(`A${i}-Mod`, '2.0.0'))));
    const report = await runTick(h.deps, scheduled);
    expect(report.changelogFetches).toBe(TICK_BUDGET.maxChangelogFetches);
    expect(report.changelogSkipped).toBe(3);
    const withChangelog = [...h.store.events.values()].filter((e) => e.changelog !== null);
    expect(withChangelog).toHaveLength(TICK_BUDGET.maxChangelogFetches);
    expect(report.sent).toBe(DISCORD.webhookRequestsPer2s);
  });

  describe('package website from the details phase', () => {
    const SITE = 'https://site.example/mod';

    it('stores the website on the package and hands it to the renderer with the event', async () => {
      const adapter = new FakeAdapter({ id: TS });
      adapter.changelog = (pkg, _version) => ({ excerpt: 'notes', url: `${pkg.url}changelog/`, websiteUrl: SITE });
      const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'immediate' })] });
      bootstrap(h, TS, {});
      adapter.enqueue(okPoll([snap('A-One')]));
      const report = await runTick(h.deps, scheduled);
      expect(report.changelogFetches).toBe(1);
      expect([...h.store.packages.values()].map((p) => p.websiteUrl)).toEqual([SITE]);
      expect(h.renderer.immediateCalls[0]!.pkg.websiteUrl).toBe(SITE);
      expect(h.renderer.immediateCalls[0]!.changelog).toBe('notes');
    });

    it('stores a website found without any changelog', async () => {
      const adapter = new FakeAdapter({ id: TS });
      adapter.changelog = () => ({ excerpt: null, url: null, websiteUrl: SITE });
      const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'immediate' })] });
      bootstrap(h, TS, {});
      adapter.enqueue(okPoll([snap('A-One')]));
      await runTick(h.deps, scheduled);
      expect(h.renderer.immediateCalls[0]!.pkg.websiteUrl).toBe(SITE);
      expect(h.renderer.immediateCalls[0]!.changelog).toBeNull();
    });

    it('writes nothing when the details phase found nothing', async () => {
      const adapter = new FakeAdapter({ id: TS });
      adapter.changelog = () => ({ excerpt: null, url: null });
      const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'immediate' })] });
      const write = vi.spyOn(h.store, 'setEventDetails');
      bootstrap(h, TS, {});
      adapter.enqueue(okPoll([snap('A-One')]));
      await runTick(h.deps, scheduled);
      expect(write).not.toHaveBeenCalled();
    });

    it('keeps a website the package already has when the details phase finds none', async () => {
      const adapter = new FakeAdapter({ id: TS });
      adapter.changelog = () => ({ excerpt: 'notes', url: null });
      const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'immediate' })] });
      bootstrap(h, TS, {});
      adapter.enqueue(okPoll([snap('A-One', '1.0.0', { websiteUrl: 'https://listed.example/' })]));
      await runTick(h.deps, scheduled);
      expect(h.renderer.immediateCalls[0]!.pkg.websiteUrl).toBe('https://listed.example/');
    });

    it('renders events beyond the cap without a website and never asks for it again', async () => {
      const adapter = new FakeAdapter({ id: TS });
      adapter.changelog = () => ({ excerpt: null, url: null, websiteUrl: SITE });
      const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'digest' })] });
      bootstrap(h, TS, {});
      const total = TICK_BUDGET.maxChangelogFetches + 2;
      adapter.enqueue(okPoll(Array.from({ length: total }, (_, i) => snap(`A${i}-Mod`))));
      await runTick(h.deps, scheduled);
      const withSite = [...h.store.packages.values()].filter((p) => p.websiteUrl === SITE);
      expect(withSite).toHaveLength(TICK_BUDGET.maxChangelogFetches);
      expect(adapter.changelogCalls).toHaveLength(TICK_BUDGET.maxChangelogFetches);
      await runTick(h.deps, scheduled + 300_000);
      expect(adapter.changelogCalls).toHaveLength(TICK_BUDGET.maxChangelogFetches);
    });
  });

  it('ignores changelog failures and still delivers', async () => {
    const adapter = new FakeAdapter({ id: TS });
    adapter.changelog = () => new Error('boom');
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('A-One')]));
    const report = await runTick(h.deps, scheduled);
    expect(report.sent).toBe(1);
    expect(h.store.events.values().next().value!.changelog).toBeNull();
  });

  it('caps Discord sends per webhook and reports deferred rows without losing them', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, {});
    const total = DISCORD.webhookRequestsPer2s + 4;
    adapter.enqueue(okPoll(Array.from({ length: total }, (_, i) => snap(`A${i}-Mod`))));
    const report = await runTick(h.deps, scheduled);
    expect(report.sent).toBe(DISCORD.webhookRequestsPer2s);
    expect(report.deferred).toBe(4);
    expect(h.store.pendingRows()).toHaveLength(4);
  });
});

describe('runTick: first-seen update of a pre-existing mod', () => {
  it('is delivered as an update: no new-package treatment and no forced changelog fetch', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'digest' })] });
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('Old-Mod', '2.0.0', { previousVersion: '1.9.0' })]));
    const report = await runTick(h.deps, scheduled);
    expect(report.sources[TS]).toEqual({ status: 'ok', events: 1 });
    expect(h.store.events.get(eventId(TS, 'Old-Mod', '2.0.0'))).toMatchObject({ kind: 'update', versionFrom: '1.9.0' });
    expect(report.changelogFetches).toBe(0);
    expect(adapter.changelogCalls).toHaveLength(0);
    h.clock.set('2026-09-19T12:30:00.000Z');
    await runTick(h.deps, scheduled + 23 * 60_000);
    expect(h.renderer.digestCalls[0]!.detailed).toEqual([false]);
  });

  it('still gets the watchlist detail treatment like any update', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'digest', filter: { watchlist: ['Old'] } })] });
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('Old-Mod', '2.0.0', { previousVersion: '1.9.0' })]));
    const report = await runTick(h.deps, scheduled);
    expect(report.changelogFetches).toBe(1);
  });

  it('an unseen package without previousVersion is still new and fetches its changelog', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'digest' })] });
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('Fresh-Mod', '1.0.0')]));
    const report = await runTick(h.deps, scheduled);
    expect(h.store.events.get(eventId(TS, 'Fresh-Mod', '1.0.0'))).toMatchObject({ kind: 'new', versionFrom: null });
    expect(report.changelogFetches).toBe(1);
  });
});

describe('runTick: store emoji', () => {
  it('hands the configured emoji to the renderer for immediate and digest deliveries', async () => {
    const storeEmojis = { thunderstore: '<:thunderstore:123456789012345678>' };
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({
      adapters: [adapter],
      subscriptions: [
        makeSubscription({ id: 'imm', mode: 'immediate', webhookUrl: 'https://discord.invalid/api/webhooks/1/a' }),
        makeSubscription({ id: 'dig', mode: 'digest', webhookUrl: 'https://discord.invalid/api/webhooks/2/b' }),
      ],
    });
    h.deps.storeEmojis = storeEmojis;
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('A-One')]));
    await runTick(h.deps, scheduled);
    h.clock.set('2026-09-19T12:30:00.000Z');
    await runTick(h.deps, scheduled + 23 * 60_000);
    expect(h.renderer.immediateEmojis).toEqual([storeEmojis]);
    expect(h.renderer.digestCalls.map((c) => c.storeEmojis)).toEqual([storeEmojis]);
  });

  it('hands the source-button emoji and the language to the renderer for immediate and digest deliveries', async () => {
    const ratatoskrEmoji = '<:ratatoskr:123456789012345679>';
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({
      adapters: [adapter],
      subscriptions: [
        makeSubscription({ id: 'imm', mode: 'immediate', webhookUrl: 'https://discord.invalid/api/webhooks/1/a' }),
        makeSubscription({ id: 'dig', mode: 'digest', webhookUrl: 'https://discord.invalid/api/webhooks/2/b' }),
      ],
    });
    h.deps.ratatoskrEmoji = ratatoskrEmoji;
    h.deps.locale = 'ru';
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('A-One')]));
    await runTick(h.deps, scheduled);
    h.clock.set('2026-09-19T12:30:00.000Z');
    await runTick(h.deps, scheduled + 23 * 60_000);
    expect(h.renderer.immediateSettings).toEqual([{ ratatoskrEmoji, locale: 'ru' }]);
    expect(h.renderer.digestCalls.map((c) => [c.ratatoskrEmoji, c.locale])).toEqual([[ratatoskrEmoji, 'ru']]);
  });
});

describe('runTick: delivery modes', () => {
  it('sends immediate subscriptions now and digest subscriptions at the epoch-aligned boundary', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const imm = makeSubscription({ id: 'imm', webhookUrl: 'https://discord.invalid/api/webhooks/1/a', mode: 'immediate' });
    const dig = makeSubscription({ id: 'dig', webhookUrl: 'https://discord.invalid/api/webhooks/2/b', mode: 'digest', digestIntervalMin: 30 });
    const h = makeHarness({ adapters: [adapter], subscriptions: [imm, dig] });
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('A-One'), snap('B-Two')]));

    const first = await runTick(h.deps, scheduled);
    expect(first.sent).toBe(2);
    expect(h.sender.callsTo(imm.webhookUrl)).toHaveLength(2);
    expect(h.sender.callsTo(dig.webhookUrl)).toHaveLength(0);
    const digestRows = h.store.pendingRows().filter((r) => r.subscriptionId === 'dig');
    expect(digestRows.map((r) => r.nextAttemptAt)).toEqual(['2026-09-19T12:30:00.000Z', '2026-09-19T12:30:00.000Z']);

    h.clock.set('2026-09-19T12:25:00.000Z');
    await runTick(h.deps, scheduled + 18 * 60_000);
    expect(h.sender.callsTo(dig.webhookUrl)).toHaveLength(0);

    h.clock.set('2026-09-19T12:30:00.000Z');
    const boundary = await runTick(h.deps, scheduled + 23 * 60_000);
    expect(boundary.sent).toBe(1);
    expect(h.sender.callsTo(dig.webhookUrl)).toHaveLength(1);
    expect(h.renderer.digestCalls[0]!.events).toHaveLength(2);
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('keeps an NSFW package away from subscriptions that did not opt in', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const safe = makeSubscription({ id: 'safe', webhookUrl: 'https://discord.invalid/api/webhooks/1/a' });
    const lewd = makeSubscription({ id: 'lewd', webhookUrl: 'https://discord.invalid/api/webhooks/2/b', filter: { allowNsfw: true } });
    const h = makeHarness({ adapters: [adapter], subscriptions: [safe, lewd] });
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('A-One', '1.0.0', { isNsfw: true })]));
    await runTick(h.deps, scheduled);
    expect(h.sender.callsTo(safe.webhookUrl)).toHaveLength(0);
    expect(h.sender.callsTo(lewd.webhookUrl)).toHaveLength(1);
  });

  it('reschedules a 429 with retry_after rather than losing the row', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('A-One')]));
    h.sender.enqueue(rateLimited(20));
    const report = await runTick(h.deps, scheduled);
    expect(report).toMatchObject({ sent: 0, failed: 1 });
    expect(h.store.pendingRows()[0]).toMatchObject({ attempts: 0, nextAttemptAt: new Date(Date.parse(FIXED_NOW_ISO) + 20_000).toISOString() });

    h.clock.advance(20_000);
    const next = await runTick(h.deps, scheduled + 300_000);
    expect(next.sent).toBe(1);
    expect(h.store.pendingRows()).toEqual([]);
  });
});

describe('runTick: cross-store dedup', () => {
  const setup = (subs = [makeSubscription({ mode: 'digest' })]) => {
    const ts = new FakeAdapter({ id: TS });
    const hx = new FakeAdapter({ id: HX });
    const h = makeHarness({ adapters: [ts, hx], subscriptions: subs });
    bootstrap(h, TS, {});
    bootstrap(h, HX, {});
    ts.enqueue(okPoll([snap('Au-Mod', '1.0.0')]));
    hx.enqueue(okPoll([snap('Au-Mod', '1.0.0', { source: HX, store: 'hexium' })]));
    return h;
  };

  it('fans out only the first store event to a subscription with dedup on', async () => {
    const h = setup();
    const report = await runTick(h.deps, scheduled);
    expect(report.sources[TS]!.events).toBe(1);
    expect(report.sources[HX]!.events).toBe(1);
    expect(h.store.events.size).toBe(2);
    expect(h.store.outboxRows().map((r) => r.eventId)).toEqual([eventId(TS, 'Au-Mod', '1.0.0')]);
  });

  it('fans out both when the subscription opted out of dedup', async () => {
    const h = setup([makeSubscription({ mode: 'digest', filter: { dedupAcrossStores: false } })]);
    await runTick(h.deps, scheduled);
    expect(h.store.outboxRows()).toHaveLength(2);
  });

  it('does not lose the item for a store-restricted subscription', async () => {
    const restricted = makeSubscription({ id: 'hx-only', mode: 'digest', filter: { sources: [HX] } });
    const open = makeSubscription({ id: 'open', mode: 'digest' });
    const h = setup([restricted, open]);
    await runTick(h.deps, scheduled);
    const rows = h.store.outboxRows().map((r) => `${r.subscriptionId}:${r.eventId}`);
    expect(rows.sort()).toEqual(
      [`hx-only:${eventId(HX, 'Au-Mod', '1.0.0')}`, `open:${eventId(TS, 'Au-Mod', '1.0.0')}`].sort(),
    );
  });

  it('does not dedup a different version of the same package', async () => {
    const h = setup();
    const hx = h.adapters[1] as FakeAdapter;
    hx.enqueue(okPoll([snap('Au-Mod', '1.0.1', { source: HX, store: 'hexium' })]));
    await runTick(h.deps, scheduled);
    await runTick(h.deps, scheduled + 300_000);
    expect(h.store.outboxRows().map((r) => r.eventId)).toContain(eventId(HX, 'Au-Mod', '1.0.1'));
  });
});

describe('runTick: report', () => {
  it('starts with zeroed counters', async () => {
    const h = makeHarness();
    expect(await runTick(h.deps, scheduled)).toEqual({
      sources: {},
      sent: 0,
      failed: 0,
      changelogFetches: 0,
      changelogSkipped: 0,
      deferred: 0,
      parked: 0,
      degraded: 0,
      filtered: 0,
      purged: 0,
      subrequests: 0,
    });
  });

  it('carries adapter warnings into the source report, on ok and on cold-start results', async () => {
    const adapter = new FakeAdapter({ id: HX });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    adapter.enqueue(okPoll([snap('A-One')], { cursor: 'seed:1', complete: false, warnings: ['seed warning'] }));
    const cold = await runTick(h.deps, scheduled);
    expect(cold.sources[HX]).toEqual({ status: 'cold-start', events: 0, warnings: ['seed warning'] });

    bootstrap(h, HX, { 'A-One': '1.0.0' });
    adapter.enqueue(okPoll([snap('A-One', '1.1.0')], { warnings: ['index above cap', 'lookups failed 2'] }));
    const ok = await runTick(h.deps, scheduled + 300_000);
    expect(ok.sources[HX]).toEqual({ status: 'ok', events: 1, warnings: ['index above cap', 'lookups failed 2'] });
  });

  it('omits the warnings key when the adapter reports none, including an empty list', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter] });
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([], { warnings: [] }));
    const report = await runTick(h.deps, scheduled);
    expect(report.sources[TS]).not.toHaveProperty('warnings');
  });

  it('carries the parked count of the drain', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('A-One')]));
    h.sender.enqueue(clientError(404));
    const report = await runTick(h.deps, scheduled);
    expect(report).toMatchObject({ sent: 0, failed: 1, parked: 1 });
  });

  it('carries the count of rows whose subscription filter no longer matches', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'digest', filter: { allowNsfw: true } })] });
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('A-Lewd', '1.0.0', { isNsfw: true })]));
    await runTick(h.deps, scheduled);
    h.store.addSubscription(makeSubscription({ mode: 'digest', filter: {} }));
    h.clock.set('2026-09-19T12:30:00.000Z');
    const report = await runTick(h.deps, scheduled + 23 * 60_000);
    expect(report).toMatchObject({ sent: 0, filtered: 1 });
  });

  it('counts the subrequests spent on sends', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('A-One'), snap('B-Two')]));
    const report = await runTick(h.deps, scheduled);
    expect(report.subrequests).toBe(h.sender.calls.length);
  });
});

describe('runTick: degraded immediate messages', () => {
  it('reports a message Discord accepted only without its optional buttons', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'immediate' })] });
    h.deps.renderer = { renderDigest, renderImmediate };
    h.sender.fallback = (call) => {
      const container = call.payload.components?.[0] as { components: { type: number; components?: unknown[] }[] } | undefined;
      const buttons = container?.components.at(-1)?.components?.length ?? 0;
      return buttons > 2 ? clientError(400) : { ok: true };
    };
    bootstrap(h, TS, {});
    adapter.enqueue(okPoll([snap('A-One', '1.0.0', { downloadUrl: 'https://thunderstore.io/package/download/A/One/1.0.0/', websiteUrl: 'https://example.com/one' })]));
    const report = await runTick(h.deps, scheduled);
    expect(h.sender.calls).toHaveLength(2);
    expect(report).toMatchObject({ sent: 1, failed: 0, parked: 0, degraded: 1 });
  });
});
