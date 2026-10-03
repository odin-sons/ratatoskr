// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter, FIXED_NOW_ISO, makeSnapshot, makeSubscription, okPoll } from '../testing/fakes.ts';
import { makeHarness, type Harness } from '../testing/harness.ts';
import { D1_FREE } from './constants.ts';
import type { DailyUsage, UsageReader } from './ports.ts';
import { runReconcile, runTick } from './tick.ts';
import { DEGRADATION_KEY } from './usage.ts';
import { WEEKLY_REPORT_KEY } from './weekly.ts';

const HX = 'hexium:valheim';
const WEBHOOK = 'https://discord.invalid/api/webhooks/9/alert-token';
const TODAY = FIXED_NOW_ISO.slice(0, 10);
const CHECK_TICK = 1_000_000;
const at = (tick: number): number => tick * 300_000;
const MONDAY_03_01 = Date.UTC(2026, 9, 5, 3, 1);

const reading = (readShare: number, writeShare = 0): DailyUsage => ({
  date: TODAY,
  rowsRead: readShare * D1_FREE.rowsReadPerDay,
  rowsWritten: writeShare * D1_FREE.rowsWrittenPerDay,
  databaseBytes: 6_000_000,
});

function readerOf(next: () => DailyUsage[] | Error): UsageReader & { calls: number } {
  const r = {
    calls: 0,
    async daily(): Promise<DailyUsage[]> {
      r.calls += 1;
      const value = next();
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return r;
}

function setup(usage: UsageReader | undefined, opts: { reconcilable?: boolean } = {}): { h: Harness; adapter: FakeAdapter } {
  const adapter = new FakeAdapter({ id: HX }, opts);
  const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ mode: 'immediate' })] });
  if (usage !== undefined) h.deps.usage = usage;
  h.deps.alertWebhookUrl = WEBHOOK;
  h.store.sources.set(HX, { id: HX, cursor: null, etag: null, bootstrapped: true, lastOkAt: FIXED_NOW_ISO });
  h.store.seedPackages(HX, { 'Owner-Mod': '1.0.0' });
  return { h, adapter };
}

const update = () => makeSnapshot({ source: HX, store: 'hexium', packageId: 'Owner-Mod', version: '1.1.0' });
const alertTexts = (h: Harness): string[] => h.sender.callsTo(WEBHOOK).map((c) => c.payload.content ?? '');

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('runTick: the D1 usage monitor', () => {
  it('alerts to the alert channel when daily usage crosses a threshold, and not again at the same level', async () => {
    const { h, adapter } = setup(readerOf(() => [reading(0.55)]));
    adapter.enqueue(okPoll([]), okPoll([]));
    const first = await runTick(h.deps, at(CHECK_TICK));
    expect(alertTexts(h).some((t) => t.includes('D1 rows read today at 55 %'))).toBe(true);
    expect(first.alerts).toBe(alertTexts(h).length);
    const before = alertTexts(h).length;
    await runTick(h.deps, at(CHECK_TICK + 3));
    expect(alertTexts(h)).toHaveLength(before);
  });

  it('applies no degradation below 70 %, and the poll context carries none', async () => {
    const { h, adapter } = setup(readerOf(() => [reading(0.55)]));
    adapter.enqueue(okPoll([]));
    const report = await runTick(h.deps, at(CHECK_TICK));
    expect(report.usageStep).toBe(0);
    expect(adapter.pollCalls[0]).not.toHaveProperty('degradation');
  });

  it.each([
    [0.72, 1],
    [0.86, 2],
    [0.97, 3],
  ])('at %f of a daily limit applies step %i to this tick and the poll context', async (share, step) => {
    const { h, adapter } = setup(readerOf(() => [reading(share)]));
    adapter.enqueue(okPoll([]));
    const report = await runTick(h.deps, at(CHECK_TICK));
    expect(report.usageStep).toBe(step);
    expect(adapter.pollCalls[0]!.degradation).toBe(step);
    expect(h.store.alertStates.get(DEGRADATION_KEY)?.level).toBe(step);
  });

  it('keeps applying the stored step on ticks that do not read the analytics API', async () => {
    const usage = readerOf(() => [reading(0.9)]);
    const { h, adapter } = setup(usage);
    adapter.enqueue(okPoll([]), okPoll([]));
    await runTick(h.deps, at(CHECK_TICK));
    const next = await runTick(h.deps, at(CHECK_TICK + 1));
    expect(usage.calls).toBe(1);
    expect(next.usageStep).toBe(2);
    expect(adapter.pollCalls[1]!.degradation).toBe(2);
  });

  it('counts the analytics read as a subrequest', async () => {
    const { h, adapter } = setup(readerOf(() => [reading(0.1)]));
    adapter.enqueue(okPoll([]));
    expect((await runTick(h.deps, at(CHECK_TICK))).subrequests).toBe(1);
  });

  it('is off without a reader: no read, no step, no usage alert', async () => {
    const { h, adapter } = setup(undefined);
    h.store.alertStates.set(DEGRADATION_KEY, { level: 3, notifiedAt: FIXED_NOW_ISO });
    adapter.enqueue(okPoll([]));
    const report = await runTick(h.deps, at(CHECK_TICK));
    expect(report.usageStep).toBe(0);
    expect(alertTexts(h)).toHaveLength(0);
    expect(adapter.pollCalls[0]).not.toHaveProperty('degradation');
  });

  it('carries on with polling and delivery when the analytics API fails', async () => {
    const { h, adapter } = setup(readerOf(() => new Error('analytics API answered 502')));
    adapter.enqueue(okPoll([update()]));
    const report = await runTick(h.deps, at(CHECK_TICK));
    expect(report.sources[HX]).toMatchObject({ status: 'ok', events: 1 });
    expect(report.sent).toBe(1);
    expect(report.usageStep).toBe(0);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('usage monitor failed'))).toBe(true);
  });

  describe('step 1 pauses changelog and website fetches', () => {
    it('fetches the changelog of an update when no step applies', async () => {
      const { h, adapter } = setup(readerOf(() => [reading(0.1)]));
      adapter.enqueue(okPoll([update()]));
      const report = await runTick(h.deps, at(CHECK_TICK));
      expect(adapter.changelogCalls).toHaveLength(1);
      expect(report.changelogSkipped).toBe(0);
    });

    it('skips them, counts them as skipped, and still delivers the update', async () => {
      const { h, adapter } = setup(readerOf(() => [reading(0.75)]));
      adapter.enqueue(okPoll([update()]));
      const report = await runTick(h.deps, at(CHECK_TICK));
      expect(adapter.changelogCalls).toHaveLength(0);
      expect(report.changelogSkipped).toBe(1);
      expect(report.sent).toBe(1);
    });
  });
});

describe('runReconcile under the D1 usage steps', () => {
  const reconcileAt = Date.UTC(2026, 9, 6, 4, 1);

  it('runs and purges as before when no step applies', async () => {
    const { h, adapter } = setup(readerOf(() => [reading(0.1)]), { reconcilable: true });
    const purge = vi.spyOn(h.store, 'purgeDelivered');
    await runReconcile(h.deps, reconcileAt, 1);
    expect(adapter.reconcileCalls).toHaveLength(1);
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('pauses the reconcile pass and the purge from step 1, and delivery still runs', async () => {
    const { h, adapter } = setup(readerOf(() => [reading(0.1)]), { reconcilable: true });
    h.store.alertStates.set(DEGRADATION_KEY, { level: 1, notifiedAt: FIXED_NOW_ISO });
    const purge = vi.spyOn(h.store, 'purgeDelivered');
    const report = await runReconcile(h.deps, reconcileAt, 1);
    expect(adapter.reconcileCalls).toHaveLength(0);
    expect(purge).not.toHaveBeenCalled();
    expect(report.usageStep).toBe(1);
    expect(report.purged).toBe(0);
  });

  it('reconciles as before when the monitor is off, whatever a stale stored step says', async () => {
    const { h, adapter } = setup(undefined, { reconcilable: true });
    h.store.alertStates.set(DEGRADATION_KEY, { level: 3, notifiedAt: FIXED_NOW_ISO });
    await runReconcile(h.deps, reconcileAt, 1);
    expect(adapter.reconcileCalls).toHaveLength(1);
  });
});

describe('runReconcile: the weekly report', () => {
  const week = (): DailyUsage[] => Array.from({ length: 7 }, (_, i) => ({ ...reading(0.04), date: new Date(Date.UTC(2026, 9, 5 - 6 + i)).toISOString().slice(0, 10) }));

  it('goes to the alert channel on the first reconcile run of a Monday, once per week', async () => {
    const usage = readerOf(() => week());
    const { h } = setup(usage, { reconcilable: true });
    h.clock.set(new Date(MONDAY_03_01).toISOString());
    const report = await runReconcile(h.deps, MONDAY_03_01, 0);
    const reports = h.sender.callsTo(WEBHOOK).filter((c) => c.payload.embeds !== undefined);
    expect(reports).toHaveLength(1);
    expect(report.alerts).toBe(1);
    expect(h.store.alertStates.has(WEEKLY_REPORT_KEY)).toBe(true);

    h.clock.set(new Date(MONDAY_03_01 + 3_600_000).toISOString());
    const again = await runReconcile(h.deps, MONDAY_03_01 + 3_600_000, 0);
    expect(again.alerts).toBe(0);
    expect(h.sender.callsTo(WEBHOOK).filter((c) => c.payload.embeds !== undefined)).toHaveLength(1);
  });

  it('is not sent on another weekday', async () => {
    const { h } = setup(readerOf(() => week()), { reconcilable: true });
    const tuesday = Date.UTC(2026, 9, 6, 3, 1);
    h.clock.set(new Date(tuesday).toISOString());
    await runReconcile(h.deps, tuesday, 0);
    expect(h.sender.callsTo(WEBHOOK)).toHaveLength(0);
  });

  it('is retried by the next reconcile run of the same Monday after a failed first attempt', async () => {
    let healthy = false;
    const { h } = setup(readerOf(() => (healthy ? week() : new Error('analytics API answered 502'))), { reconcilable: true });
    h.clock.set(new Date(MONDAY_03_01).toISOString());
    await runReconcile(h.deps, MONDAY_03_01, 0);
    expect(h.store.alertStates.has(WEEKLY_REPORT_KEY)).toBe(false);
    healthy = true;
    h.clock.set(new Date(MONDAY_03_01 + 3_600_000).toISOString());
    const second = await runReconcile(h.deps, MONDAY_03_01 + 3_600_000, 1);
    expect(second.alerts).toBe(1);
  });

  it('never fails the reconcile run when the report cannot be built', async () => {
    const { h, adapter } = setup(readerOf(() => new Error('analytics API answered 502')), { reconcilable: true });
    h.clock.set(new Date(MONDAY_03_01).toISOString());
    const report = await runReconcile(h.deps, MONDAY_03_01, 0);
    expect(adapter.reconcileCalls).toHaveLength(1);
    expect(report.alerts).toBe(0);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('weekly report failed'))).toBe(true);
  });
});
