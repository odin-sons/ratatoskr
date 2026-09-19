// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FakeAdapter, FIXED_NOW_ISO, makeSnapshot, makeSubscription } from '../testing/fakes.ts';
import { makeHarness, type Harness } from '../testing/harness.ts';
import { eventId } from './ids.ts';
import { runReconcile } from './tick.ts';
import type { PackageSnapshot } from './types.ts';

const TS = 'thunderstore:valheim';
const HX = 'hexium:valheim';
const NX = 'nexus:valheim';
const scheduled = Date.parse(FIXED_NOW_ISO);

const snap = (packageId: string, version: string, source = TS): PackageSnapshot => {
  const [owner = 'Owner', ...rest] = packageId.split('-');
  return makeSnapshot({ source, packageId, owner, name: rest.join('-') || 'Mod', version });
};

function bootstrap(h: Harness, source: string, versions: Record<string, string>): void {
  h.store.seedPackages(source, versions);
  h.store.sources.set(source, { id: source, cursor: 'cur', etag: 'etag', bootstrapped: true, lastOkAt: '2026-09-19T11:00:00.000Z' });
}

describe('runReconcile', () => {
  it('emits only packages missed by the tick poller', async () => {
    const adapter = new FakeAdapter({ id: TS }, { reconcilable: true });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, { 'A-Same': '1.0.0', 'B-Old': '1.0.0' });
    adapter.reconcileResult = [snap('A-Same', '1.0.0'), snap('B-Old', '1.1.0'), snap('C-Missed', '0.1.0')];

    const report = await runReconcile(h.deps, scheduled, 0);
    expect(report.sources[TS]).toEqual({ status: 'ok', events: 2 });
    expect([...h.store.events.keys()].sort()).toEqual([eventId(TS, 'B-Old', '1.1.0'), eventId(TS, 'C-Missed', '0.1.0')].sort());
    expect(h.store.events.get(eventId(TS, 'B-Old', '1.1.0'))).toMatchObject({ kind: 'update', versionFrom: '1.0.0' });
    expect(h.store.events.get(eventId(TS, 'C-Missed', '0.1.0'))).toMatchObject({ kind: 'new' });
    expect(report.sent).toBe(2);
  });

  it('leaves the tick cursor and etag untouched', async () => {
    const adapter = new FakeAdapter({ id: TS }, { reconcilable: true });
    const h = makeHarness({ adapters: [adapter] });
    bootstrap(h, TS, {});
    adapter.reconcileResult = [snap('A-One', '1.0.0')];
    await runReconcile(h.deps, scheduled, 0);
    expect(h.store.sources.get(TS)).toMatchObject({ cursor: 'cur', etag: 'etag', lastOkAt: '2026-09-19T11:00:00.000Z', bootstrapped: true });
  });

  it('never treats reconciliation as an emitting cold start: an unbootstrapped source is seeded silently', async () => {
    const adapter = new FakeAdapter({ id: TS }, { reconcilable: true });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    adapter.reconcileResult = [snap('A-One', '1.0.0'), snap('B-Two', '1.0.0')];
    const report = await runReconcile(h.deps, scheduled, 0);
    expect(report.sources[TS]).toEqual({ status: 'cold-start', events: 0 });
    expect(h.sender.calls).toHaveLength(0);
    expect(h.store.packages.size).toBe(2);
    expect(h.store.sources.get(TS)!.bootstrapped).toBe(true);

    adapter.reconcileResult = [snap('A-One', '1.0.0'), snap('B-Two', '1.0.0'), snap('C-Three', '1.0.0')];
    const next = await runReconcile(h.deps, scheduled, 0);
    expect(next.sources[TS]!.events).toBe(1);
  });

  it('rotates one reconcilable store per run and skips stores without an index', async () => {
    const ts = new FakeAdapter({ id: TS }, { reconcilable: true });
    const nx = new FakeAdapter({ id: NX });
    const hx = new FakeAdapter({ id: HX }, { reconcilable: true });
    const h = makeHarness({ adapters: [ts, nx, hx] });
    bootstrap(h, TS, {});
    bootstrap(h, HX, {});

    const r0 = await runReconcile(h.deps, scheduled, 0);
    const r1 = await runReconcile(h.deps, scheduled, 1);
    const r2 = await runReconcile(h.deps, scheduled, 2);
    expect(Object.keys(r0.sources)).toEqual([TS]);
    expect(Object.keys(r1.sources)).toEqual([HX]);
    expect(Object.keys(r2.sources)).toEqual([TS]);
    expect(ts.reconcileCalls).toHaveLength(2);
    expect(hx.reconcileCalls).toHaveLength(1);
    expect(nx.pollCalls).toHaveLength(0);
  });

  it('does nothing when no source supports reconciliation', async () => {
    const h = makeHarness({ adapters: [new FakeAdapter({ id: NX })] });
    const report = await runReconcile(h.deps, scheduled, 0);
    expect(report.sources).toEqual({});
  });

  it('fails soft when the sweep throws', async () => {
    const adapter = new FakeAdapter({ id: TS }, { reconcilable: true });
    const h = makeHarness({ adapters: [adapter] });
    bootstrap(h, TS, {});
    adapter.reconcileResult = new Error('index unavailable');
    const report = await runReconcile(h.deps, scheduled, 0);
    expect(report.sources[TS]).toEqual({ status: 'error', events: 0, error: 'index unavailable' });
  });

  it('does not advance state when the commit fails, and a rerun emits the same events', async () => {
    const adapter = new FakeAdapter({ id: TS }, { reconcilable: true });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, {});
    adapter.reconcileResult = [snap('A-One', '1.0.0')];
    h.store.failNextCommit();
    expect((await runReconcile(h.deps, scheduled, 0)).sources[TS]!.status).toBe('error');
    expect(h.store.events.size).toBe(0);
    expect((await runReconcile(h.deps, scheduled, 0)).sources[TS]!.events).toBe(1);
  });
});
