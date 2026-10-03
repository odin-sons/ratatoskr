// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../testing/memory-store.ts';
import { SubrequestBudget } from './budget.ts';
import { D1_FREE } from './constants.ts';
import type { DailyUsage, UsageReader } from './ports.ts';
import { DEGRADATION_KEY } from './usage.ts';
import { readDegradation, runUsageMonitor } from './usage-monitor.ts';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const CHECK_TICK = 4;
const OTHER_TICK = 5;

const today = (readShare: number, writeShare = 0): DailyUsage => ({
  date: '2026-10-04',
  rowsRead: readShare * D1_FREE.rowsReadPerDay,
  rowsWritten: writeShare * D1_FREE.rowsWrittenPerDay,
  databaseBytes: 6_000_000,
});

function reader(...results: (DailyUsage | Error)[]): UsageReader & { calls: number } {
  const queue = [...results];
  const r = {
    calls: 0,
    async daily(): Promise<DailyUsage[]> {
      r.calls += 1;
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (next instanceof Error) throw next;
      return [next];
    },
  };
  return r;
}

function setup(readerImpl: UsageReader | undefined) {
  const store = new MemoryStore();
  const run = (tickIndex: number, budget = new SubrequestBudget()) => runUsageMonitor({ store, reader: readerImpl, budget, now: NOW, tickIndex });
  return { store, run };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('runUsageMonitor', () => {
  it('is off without a reader: no degradation, no alerts, no reads of the store', async () => {
    const { store, run } = setup(undefined);
    const read = vi.spyOn(store, 'getAlertStates');
    store.alertStates.set(DEGRADATION_KEY, { level: 3, notifiedAt: NOW.toISOString() });
    expect(await run(CHECK_TICK)).toEqual({ degradation: 0, usages: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it('reads the analytics API on every third tick only, and spends one subrequest on it', async () => {
    const r = reader(today(0.1));
    const { run } = setup(r);
    for (const tick of [CHECK_TICK, CHECK_TICK + 1, CHECK_TICK + 2, CHECK_TICK + 3]) await run(tick);
    expect(r.calls).toBe(2);
    const budget = new SubrequestBudget();
    await run(CHECK_TICK, budget);
    expect(budget.used).toBe(1);
  });

  it('returns the limits to alert on after a reading', async () => {
    const { run } = setup(reader(today(0.6)));
    const outcome = await run(CHECK_TICK);
    expect(outcome.usages.map((u) => u.usage.id)).toEqual(expect.arrayContaining(['rows-read', 'rows-written', 'database-size']));
    expect(outcome.degradation).toBe(0);
  });

  it('stores a changed degradation step and applies it, then keeps applying it on ticks that do not read', async () => {
    const r = reader(today(0.9));
    const { store, run } = setup(r);
    expect((await run(CHECK_TICK)).degradation).toBe(2);
    expect(store.alertStates.get(DEGRADATION_KEY)).toEqual({ level: 2, notifiedAt: NOW.toISOString() });
    const between = await run(OTHER_TICK);
    expect(between).toEqual({ degradation: 2, usages: [] });
    expect(r.calls).toBe(1);
  });

  it('writes the step only when it changes', async () => {
    const { store, run } = setup(reader(today(0.9)));
    await run(CHECK_TICK);
    const write = vi.spyOn(store, 'setAlertState');
    await run(CHECK_TICK + 3);
    expect(write).not.toHaveBeenCalled();
  });

  it('lowers the step when usage falls, as after midnight', async () => {
    const { store, run } = setup(reader(today(0.96), today(0.02)));
    expect((await run(CHECK_TICK)).degradation).toBe(3);
    expect((await run(CHECK_TICK + 3)).degradation).toBe(0);
    expect(store.alertStates.get(DEGRADATION_KEY)?.level).toBe(0);
  });

  it('keeps the stored step when the analytics API fails, and says so without failing the run', async () => {
    const { store, run } = setup(reader(today(0.9), new Error('analytics API answered 502')));
    await run(CHECK_TICK);
    const outcome = await run(CHECK_TICK + 3);
    expect(outcome).toEqual({ degradation: 2, usages: [] });
    expect(store.alertStates.get(DEGRADATION_KEY)?.level).toBe(2);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('usage monitor failed: Error: analytics API answered 502'))).toBe(true);
  });

  it('does not read when the subrequest budget is gone', async () => {
    const r = reader(today(0.9));
    const { run } = setup(r);
    expect(await run(CHECK_TICK, new SubrequestBudget(0))).toEqual({ degradation: 0, usages: [] });
    expect(r.calls).toBe(0);
  });

  it('keeps the stored step when the reading has no day in it', async () => {
    const empty: UsageReader = { daily: async () => [] };
    const { store, run } = setup(empty);
    store.alertStates.set(DEGRADATION_KEY, { level: 1, notifiedAt: NOW.toISOString() });
    expect(await run(CHECK_TICK)).toEqual({ degradation: 1, usages: [] });
  });
});

describe('readDegradation', () => {
  it('is 0 when nothing is stored or the store fails', async () => {
    const store = new MemoryStore();
    const r = reader(today(0));
    expect(await readDegradation(store, r, NOW)).toBe(0);
    vi.spyOn(store, 'getAlertStates').mockRejectedValue(new Error('no such table: alert_state'));
    expect(await readDegradation(store, r, NOW)).toBe(0);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('degradation level not read'))).toBe(true);
  });

  it('applies the stored step only on the UTC day it was written', async () => {
    const store = new MemoryStore();
    const r = reader(today(0));
    store.alertStates.set(DEGRADATION_KEY, { level: 3, notifiedAt: '2026-10-04T00:05:00.000Z' });
    expect(await readDegradation(store, r, new Date('2026-10-04T23:59:59.999Z'))).toBe(3);
    expect(await readDegradation(store, r, new Date('2026-10-05T00:00:00.000Z'))).toBe(0);
  });
});

describe('a stored step from an earlier day', () => {
  it('is not applied, so a revoked token cannot hold a step for ever', async () => {
    const { store, run } = setup(reader(new Error('analytics API answered 401')));
    store.alertStates.set(DEGRADATION_KEY, { level: 3, notifiedAt: '2026-10-03T22:00:00.000Z' });
    expect(await run(OTHER_TICK)).toEqual({ degradation: 0, usages: [] });
    expect(await run(CHECK_TICK)).toEqual({ degradation: 0, usages: [] });
  });

  it('is rewritten on the first successful reading of the day, even when the step is the same', async () => {
    const { store, run } = setup(reader(today(0.9)));
    store.alertStates.set(DEGRADATION_KEY, { level: 2, notifiedAt: '2026-10-03T22:00:00.000Z' });
    expect((await run(CHECK_TICK)).degradation).toBe(2);
    expect(store.alertStates.get(DEGRADATION_KEY)).toEqual({ level: 2, notifiedAt: NOW.toISOString() });
    expect((await run(OTHER_TICK)).degradation).toBe(2);
  });

  it('is left alone when the new step is 0', async () => {
    const { store, run } = setup(reader(today(0.1)));
    store.alertStates.set(DEGRADATION_KEY, { level: 0, notifiedAt: '2026-10-03T22:00:00.000Z' });
    const write = vi.spyOn(store, 'setAlertState');
    await run(CHECK_TICK);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('a failed write of the step', () => {
  it('still applies the step just read and returns the usage alerts', async () => {
    const { store, run } = setup(reader(today(0.9)));
    vi.spyOn(store, 'setAlertState').mockRejectedValue(new Error('D1 write quota exhausted'));
    const outcome = await run(CHECK_TICK);
    expect(outcome.degradation).toBe(2);
    expect(outcome.usages.length).toBeGreaterThan(0);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('degradation level not saved'))).toBe(true);
  });
});
