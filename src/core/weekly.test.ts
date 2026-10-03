// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { FakeSender, SEND_OK, clientError } from '../testing/fakes.ts';
import { MemoryStore } from '../testing/memory-store.ts';
import { SubrequestBudget } from './budget.ts';
import { WEEKLY_REPORT_MIN_GAP_MS } from './constants.ts';
import type { DailyUsage, UsageReader } from './ports.ts';
import { WEEKLY_REPORT_DAYS, WEEKLY_REPORT_KEY, maybeSendWeeklyReport, type WeeklyInput } from './weekly.ts';

const WEBHOOK = 'https://discord.invalid/api/webhooks/1/alert-token';
const MONDAY = Date.UTC(2026, 9, 5, 3, 1);
const TUESDAY = Date.UTC(2026, 9, 6, 3, 1);

const usage: DailyUsage[] = Array.from({ length: WEEKLY_REPORT_DAYS }, (_, i) => ({
  date: new Date(Date.UTC(2026, 8, 29 + i)).toISOString().slice(0, 10),
  rowsRead: 200_000,
  rowsWritten: 9_000,
  databaseBytes: 6_000_000,
}));

function setup(over: Partial<WeeklyInput> = {}) {
  const store = new MemoryStore();
  const sender = new FakeSender();
  const daily = vi.fn(async (): Promise<DailyUsage[]> => usage);
  const reader: UsageReader = { daily };
  const run = (extra: Partial<WeeklyInput> = {}) =>
    maybeSendWeeklyReport({
      store,
      sender,
      reader,
      webhookUrl: WEBHOOK,
      budget: new SubrequestBudget(),
      now: new Date(MONDAY),
      scheduledTimeMs: MONDAY,
      degradation: 0,
      ...over,
      ...extra,
    });
  return { store, sender, daily, run };
}

describe('maybeSendWeeklyReport', () => {
  it('sends the report to the alert channel on a Monday, and records it', async () => {
    const { store, sender, daily, run } = setup();
    expect(await run()).toBe(true);
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.webhookUrl).toBe(WEBHOOK);
    expect(sender.calls[0]!.payload.embeds![0]!.title).toContain('D1 usage');
    expect(daily).toHaveBeenCalledWith(new Date(MONDAY), WEEKLY_REPORT_DAYS);
    expect(store.alertStates.get(WEEKLY_REPORT_KEY)).toEqual({ level: 0, notifiedAt: new Date(MONDAY).toISOString() });
  });

  it('spends two subrequests: the analytics read and the send', async () => {
    const { run } = setup();
    const budget = new SubrequestBudget();
    await run({ budget });
    expect(budget.used).toBe(2);
  });

  it.each([
    ['another day of the week', { scheduledTimeMs: TUESDAY }],
    ['no analytics reader', { reader: undefined }],
    ['no alert webhook', { webhookUrl: undefined }],
    ['too little subrequest budget', { budget: new SubrequestBudget(1) }],
  ] as [string, Partial<WeeklyInput>][])('sends nothing for %s', async (_label, over) => {
    const { sender, daily, run } = setup();
    expect(await run(over)).toBe(false);
    expect(sender.calls).toHaveLength(0);
    expect(daily).not.toHaveBeenCalled();
  });

  it('sends one report per week, whichever reconcile run of the Monday comes first: the next Monday is due, a repeat within the gap is not', async () => {
    const { store, sender, run } = setup();
    await run();
    expect(await run({ now: new Date(MONDAY + 60_000) })).toBe(false);
    store.alertStates.set(WEEKLY_REPORT_KEY, { level: 0, notifiedAt: new Date(MONDAY - WEEKLY_REPORT_MIN_GAP_MS + 1).toISOString() });
    expect(await run()).toBe(false);
    store.alertStates.set(WEEKLY_REPORT_KEY, { level: 0, notifiedAt: new Date(MONDAY - WEEKLY_REPORT_MIN_GAP_MS).toISOString() });
    expect(await run()).toBe(true);
    expect(sender.calls).toHaveLength(2);
  });

  it('records nothing when Discord refuses the report, so the next Monday run tries again', async () => {
    const { store, sender, run } = setup();
    sender.enqueue(clientError(404));
    expect(await run()).toBe(false);
    expect(store.alertStates.size).toBe(0);
    sender.enqueue(SEND_OK);
    expect(await run()).toBe(true);
  });

  it('puts the current degradation step in the report', async () => {
    const { sender, run } = setup();
    await run({ degradation: 2 });
    expect(sender.calls[0]!.payload.embeds![0]!.description).toContain('step 2 is active');
  });

  it('lets a failing analytics read propagate for the caller to log, recording nothing', async () => {
    const { store, daily, run } = setup();
    daily.mockRejectedValueOnce(new Error('analytics API answered 502'));
    await expect(run()).rejects.toThrow('analytics API answered 502');
    expect(store.alertStates.size).toBe(0);
  });
});
