// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FakeAdapter, FIXED_NOW_ISO, makeEvent, makeSnapshot, makeSubscription, okPoll } from '../testing/fakes.ts';
import { makeHarness, type Harness } from '../testing/harness.ts';
import { CADENCE, DELIVERED_RETENTION_DAYS, OUTBOX_PURGE_BATCH } from './constants.ts';
import { eventId, outboxId } from './ids.ts';
import { runReconcile, runTick } from './tick.ts';
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

  it('does not run for a source that is not bootstrapped yet: seeding belongs to polling', async () => {
    const adapter = new FakeAdapter({ id: TS }, { reconcilable: true });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    adapter.reconcileResult = [snap('A-One', '1.0.0'), snap('B-Two', '1.0.0')];
    const report = await runReconcile(h.deps, scheduled, 0);
    expect(report.sources[TS]).toEqual({ status: 'skipped', events: 0 });
    expect(adapter.reconcileCalls).toHaveLength(0);
    expect(h.sender.calls).toHaveLength(0);
    expect(h.store.packages.size).toBe(0);
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

describe('runReconcile: slice hint', () => {
  const DAY_MS = 86_400_000;

  async function hints(h: Harness, adapter: FakeAdapter, runs: { at: number; index: number }[], perDay?: number): Promise<(number | undefined)[]> {
    if (perDay !== undefined) h.deps.reconcileRunsPerDay = perDay;
    for (const run of runs) await runReconcile(h.deps, run.at, run.index);
    return adapter.reconcileCalls.map((c) => c.sliceHint);
  }

  const setup = () => {
    const adapter = new FakeAdapter({ id: HX }, { reconcilable: true });
    const h = makeHarness({ adapters: [adapter] });
    bootstrap(h, HX, {});
    return { adapter, h };
  };

  it('is consecutive across the reconcile runs of a day and continues on the next day', async () => {
    const { adapter, h } = setup();
    const day = Math.floor(scheduled / DAY_MS);
    const runs = [
      { at: day * DAY_MS + 3 * 3_600_000 + 60_000, index: 0 },
      { at: day * DAY_MS + 4 * 3_600_000 + 60_000, index: 1 },
      { at: day * DAY_MS + 5 * 3_600_000 + 60_000, index: 2 },
      { at: (day + 1) * DAY_MS + 3 * 3_600_000 + 60_000, index: 0 },
    ];
    const seen = await hints(h, adapter, runs);
    expect(seen).toEqual([0, 1, 2, 3].map((n) => day * CADENCE.reconcileRunsPerDay + n));
    for (let i = 1; i < seen.length; i++) expect(seen[i]! - seen[i - 1]!).toBe(1);
  });

  it('uses the configured number of runs per day', async () => {
    const { adapter, h } = setup();
    const day = Math.floor(scheduled / DAY_MS);
    const seen = await hints(h, adapter, [{ at: day * DAY_MS, index: 1 }], 5);
    expect(seen).toEqual([day * 5 + 1]);
  });

  it('is not set for tick polls', async () => {
    const adapter = new FakeAdapter({ id: TS });
    const h = makeHarness({ adapters: [adapter] });
    adapter.enqueue(okPoll([]));
    await runTick(h.deps, scheduled);
    expect(adapter.pollCalls[0]!.sliceHint).toBeUndefined();
  });
});

describe('runReconcile: purge of delivered rows', () => {
  const DAY_MS = 86_400_000;

  async function withDeliveredRow(h: Harness, name: string, deliveredAtMs: number): Promise<void> {
    const sub = makeSubscription();
    h.store.addSubscription(sub);
    const event = makeEvent({ pkg: { packageId: `Own-${name}`, owner: 'Own', name } });
    const row = { id: outboxId(sub.id, event.id), subscriptionId: sub.id, eventId: event.id, attempts: 0, nextAttemptAt: FIXED_NOW_ISO };
    await h.store.commit({
      source: TS,
      packages: [event.pkg],
      events: [event],
      outbox: [row],
      state: { id: TS, cursor: 'cur', etag: 'etag', bootstrapped: true, lastOkAt: null },
    });
    await h.store.markDelivered([row.id], new Date(deliveredAtMs).toISOString());
  }

  it('deletes rows delivered longer ago than the retention and reports them', async () => {
    const adapter = new FakeAdapter({ id: TS }, { reconcilable: true });
    const h = makeHarness({ adapters: [adapter] });
    await withDeliveredRow(h, 'Old', scheduled - (DELIVERED_RETENTION_DAYS + 1) * DAY_MS);
    await withDeliveredRow(h, 'Recent', scheduled - DAY_MS);
    const report = await runReconcile(h.deps, scheduled, 0);
    expect(report.purged).toBe(1);
    expect(h.store.outboxRows()).toHaveLength(1);
    expect(h.store.outboxRows()[0]!.eventId).toContain('Recent');
  });

  it('purges even when no source supports reconciliation', async () => {
    const h = makeHarness({ adapters: [new FakeAdapter({ id: NX })] });
    await withDeliveredRow(h, 'Old', scheduled - (DELIVERED_RETENTION_DAYS + 1) * DAY_MS);
    expect((await runReconcile(h.deps, scheduled, 0)).purged).toBe(1);
  });

  it('asks the store to delete at most one bounded batch', async () => {
    const h = makeHarness();
    const calls: [string, number][] = [];
    h.store.purgeDelivered = async (olderThan, limit) => {
      calls.push([olderThan, limit]);
      return 0;
    };
    await runReconcile(h.deps, scheduled, 0);
    expect(calls).toEqual([[new Date(scheduled - DELIVERED_RETENTION_DAYS * DAY_MS).toISOString(), OUTBOX_PURGE_BATCH]]);
  });

  it('does not fail the run when the purge throws', async () => {
    const adapter = new FakeAdapter({ id: TS }, { reconcilable: true });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
    bootstrap(h, TS, {});
    adapter.reconcileResult = [snap('A-One', '1.0.0')];
    h.store.purgeDelivered = async () => {
      throw new Error('d1 down');
    };
    const report = await runReconcile(h.deps, scheduled, 0);
    expect(report.sources[TS]).toEqual({ status: 'ok', events: 1 });
    expect(report.purged).toBe(0);
  });

  it('never purges on a tick run', async () => {
    const h = makeHarness();
    let called = false;
    h.store.purgeDelivered = async () => {
      called = true;
      return 0;
    };
    await runTick(h.deps, scheduled);
    expect(called).toBe(false);
  });
});
