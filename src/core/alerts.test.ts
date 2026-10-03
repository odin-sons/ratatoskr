// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSender, SEND_OK, clientError, rateLimited } from '../testing/fakes.ts';
import { MemoryStore } from '../testing/memory-store.ts';
import { EXCEEDED_LEVEL, capLevel, formatCapAlert, raiseCapAlerts, type SourceCapUsage } from './alerts.ts';
import { SubrequestBudget } from './budget.ts';
import { CAP_ALERT_REPEAT_MS, PROJECT } from './constants.ts';
import type { CapUsage } from './types.ts';

const WEBHOOK = 'https://discord.invalid/api/webhooks/1/alert-token';
const NOW = new Date('2026-10-04T12:00:00.000Z');

const usage = (over: Partial<CapUsage> = {}): CapUsage => ({
  id: 'index-lines',
  label: 'package index line cap',
  unit: 'lines',
  limit: 1000,
  value: 100,
  exceeded: false,
  consequence: 'Updates of known packages are not detected.',
  constant: 'SOME_LIMIT',
  ...over,
});

const entry = (over: Partial<CapUsage> = {}, source = 'hexium:valheim'): SourceCapUsage => ({ source, usage: usage(over) });

function setup() {
  const store = new MemoryStore();
  const sender = new FakeSender();
  const run = (usages: SourceCapUsage[], over: { now?: Date; webhookUrl?: string | undefined; budget?: SubrequestBudget } = {}) =>
    raiseCapAlerts({
      store,
      sender,
      webhookUrl: 'webhookUrl' in over ? over.webhookUrl : WEBHOOK,
      budget: over.budget ?? new SubrequestBudget(),
      usages,
      now: over.now ?? NOW,
    });
  return { store, sender, run };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('capLevel', () => {
  it.each([
    [0, 0],
    [699, 0],
    [700, 1],
    [849, 1],
    [850, 2],
    [949, 2],
    [950, 3],
    [1000, 3],
  ])('puts %i of 1000 at level %i', (value, level) => {
    expect(capLevel(usage({ value }))).toBe(level);
  });

  it('puts an exceeded limit above every share, whatever its value', () => {
    expect(capLevel(usage({ exceeded: true, value: null }))).toBe(EXCEEDED_LEVEL);
    expect(capLevel(usage({ exceeded: true, value: 5 }))).toBe(EXCEEDED_LEVEL);
  });

  it('treats an unknown value or a zero limit as level 0', () => {
    expect(capLevel(usage({ value: null }))).toBe(0);
    expect(capLevel(usage({ limit: 0, value: 10 }))).toBe(0);
  });
});

describe('formatCapAlert', () => {
  it('names the source, the cap, the numbers, the constant and the project link, and never pings', () => {
    const message = formatCapAlert(entry({ value: 750, constant: 'HEXIUM_INDEX_MAX_LINES' }), 1);
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.content).toContain('🟡 hexium:valheim: package index line cap at 75 % (750 of 1,000 lines).');
    expect(message.content).toContain('Updates of known packages are not detected.');
    expect(message.content).toContain('`HEXIUM_INDEX_MAX_LINES`');
    expect(message.content).toContain(`[ratatoskr v${PROJECT.version}](${PROJECT.repoUrl})`);
  });

  it('says the limit is exceeded and that the alert repeats daily', () => {
    const { content } = formatCapAlert(entry({ exceeded: true, value: null, limit: 3500 }), EXCEEDED_LEVEL);
    expect(content).toContain('⛔ hexium:valheim: package index line cap exceeded (limit 3,500 lines).');
    expect(content).toContain('Reported again every 24 hours until it is fixed.');
  });

  it('uses a different icon at each level', () => {
    const icons = [1, 2, 3, EXCEEDED_LEVEL].map((level) => formatCapAlert(entry(), level).content!.split(' ')[0]);
    expect(new Set(icons).size).toBe(4);
  });
});

describe('raiseCapAlerts', () => {
  it('sends nothing below the first threshold and records nothing', async () => {
    const { store, sender, run } = setup();
    expect(await run([entry({ value: 100 })])).toEqual({ sent: 0, failed: 0 });
    expect(sender.calls).toHaveLength(0);
    expect(store.alertStates.size).toBe(0);
  });

  it('sends one alert per level reached and none while the level stays the same', async () => {
    const { store, sender, run } = setup();
    expect(await run([entry({ value: 720 })])).toEqual({ sent: 1, failed: 0 });
    expect(await run([entry({ value: 800 })])).toEqual({ sent: 0, failed: 0 });
    expect(await run([entry({ value: 900 })])).toEqual({ sent: 1, failed: 0 });
    expect(await run([entry({ value: 960 })])).toEqual({ sent: 1, failed: 0 });
    expect(sender.calls).toHaveLength(3);
    expect(sender.calls.every((c) => c.webhookUrl === WEBHOOK)).toBe(true);
    expect(store.alertStates.get('hexium:valheim:index-lines')).toEqual({ level: 3, notifiedAt: NOW.toISOString() });
  });

  it('sends a single alert at the reached level when usage jumps over the lower ones', async () => {
    const { sender, run } = setup();
    expect(await run([entry({ value: 970 })])).toEqual({ sent: 1, failed: 0 });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.payload.content).toContain('🔴');
  });

  it('repeats an exceeded limit only after 24 hours', async () => {
    const { sender, run } = setup();
    const exceeded = entry({ exceeded: true, value: null });
    expect(await run([exceeded])).toEqual({ sent: 1, failed: 0 });
    const justBefore = new Date(NOW.getTime() + CAP_ALERT_REPEAT_MS - 1);
    expect(await run([exceeded], { now: justBefore })).toEqual({ sent: 0, failed: 0 });
    const due = new Date(NOW.getTime() + CAP_ALERT_REPEAT_MS);
    expect(await run([exceeded], { now: due })).toEqual({ sent: 1, failed: 0 });
    expect(await run([exceeded], { now: new Date(due.getTime() + 60_000) })).toEqual({ sent: 0, failed: 0 });
    expect(sender.calls).toHaveLength(2);
  });

  it('does not repeat a non-exceeded level, however old the last alert is', async () => {
    const { run } = setup();
    await run([entry({ value: 800 })]);
    const later = new Date(NOW.getTime() + 30 * CAP_ALERT_REPEAT_MS);
    expect(await run([entry({ value: 800 })], { now: later })).toEqual({ sent: 0, failed: 0 });
  });

  it('records nothing for a refused send, so the next run tries again', async () => {
    const { store, sender, run } = setup();
    sender.enqueue(clientError(404), rateLimited(3));
    expect(await run([entry({ value: 800 })])).toEqual({ sent: 0, failed: 1 });
    expect(store.alertStates.size).toBe(0);
    expect(await run([entry({ value: 800 })])).toEqual({ sent: 0, failed: 1 });
    sender.enqueue(SEND_OK);
    expect(await run([entry({ value: 800 })])).toEqual({ sent: 1, failed: 0 });
    expect(store.alertStates.get('hexium:valheim:index-lines')?.level).toBe(1);
  });

  it('sends nothing and records nothing without an alert webhook, and says so once per run', async () => {
    const { store, sender, run } = setup();
    expect(await run([entry({ value: 800 }), entry({ value: 800, id: 'index-bytes' })], { webhookUrl: undefined })).toEqual({ sent: 0, failed: 0 });
    expect(sender.calls).toHaveLength(0);
    expect(store.alertStates.size).toBe(0);
    expect(vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes('ALERT_WEBHOOK_URL'))).toHaveLength(1);
    expect(await run([entry({ value: 800 })])).toEqual({ sent: 1, failed: 0 });
  });

  it('does not warn about a missing webhook when nothing is due', async () => {
    const { run } = setup();
    await run([entry({ value: 100 })], { webhookUrl: undefined });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('spends one subrequest per alert and skips the rest, unrecorded, when the budget is gone', async () => {
    const { store, sender, run } = setup();
    const budget = new SubrequestBudget(1);
    const both = [entry({ value: 800 }), entry({ value: 800, id: 'index-bytes' })];
    expect(await run(both, { budget })).toEqual({ sent: 1, failed: 0 });
    expect(budget.used).toBe(1);
    expect(sender.calls).toHaveLength(1);
    expect([...store.alertStates.keys()]).toEqual(['hexium:valheim:index-lines']);
    expect(await run(both)).toEqual({ sent: 1, failed: 0 });
    expect(store.alertStates.size).toBe(2);
  });

  it('records a lower level without sending, so crossing the threshold again alerts again', async () => {
    const { store, sender, run } = setup();
    await run([entry({ value: 960 })]);
    expect(await run([entry({ value: 100 })])).toEqual({ sent: 0, failed: 0 });
    expect(store.alertStates.get('hexium:valheim:index-lines')).toEqual({ level: 0, notifiedAt: NOW.toISOString() });
    expect(await run([entry({ value: 720 })])).toEqual({ sent: 1, failed: 0 });
    expect(sender.calls).toHaveLength(2);
  });

  it('alerts again for an exceeded limit after it was fixed and broke again', async () => {
    const { sender, run } = setup();
    await run([entry({ exceeded: true, value: null })]);
    await run([entry({ value: 900 })]);
    expect(await run([entry({ exceeded: true, value: null })])).toEqual({ sent: 1, failed: 0 });
    expect(sender.calls).toHaveLength(2);
  });

  it('alerts once for a limit listed twice in one run', async () => {
    const { sender, run } = setup();
    expect(await run([entry({ value: 800 }), entry({ value: 800 })])).toEqual({ sent: 1, failed: 0 });
    expect(sender.calls).toHaveLength(1);
  });

  it('keeps going and counts the alert as sent when saving its state fails', async () => {
    const { store, sender, run } = setup();
    vi.spyOn(store, 'setAlertState').mockRejectedValueOnce(new Error('D1 quota exhausted'));
    const both = [entry({ value: 800 }), entry({ value: 800, id: 'index-bytes' })];
    expect(await run(both)).toEqual({ sent: 2, failed: 0 });
    expect(sender.calls).toHaveLength(2);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('alert state not saved: D1 quota exhausted'))).toBe(true);
    expect([...store.alertStates.keys()]).toEqual(['hexium:valheim:index-bytes']);
  });

  it('repeats an exceeded limit whose stored time is unreadable, then stores a good one', async () => {
    const { store, run } = setup();
    store.alertStates.set('hexium:valheim:index-lines', { level: 4, notifiedAt: 'not a date' });
    expect(await run([entry({ exceeded: true, value: null })])).toEqual({ sent: 1, failed: 0 });
    expect(store.alertStates.get('hexium:valheim:index-lines')?.notifiedAt).toBe(NOW.toISOString());
  });

  it('keeps separate state per source and per limit', async () => {
    const { store, sender, run } = setup();
    const result = await run([entry({ value: 800 }, 'hexium:valheim'), entry({ value: 800 }, 'hexium:other'), entry({ value: 800, id: 'index-bytes' })]);
    expect(result).toEqual({ sent: 3, failed: 0 });
    expect([...store.alertStates.keys()].sort()).toEqual(['hexium:other:index-lines', 'hexium:valheim:index-bytes', 'hexium:valheim:index-lines']);
    expect(sender.calls).toHaveLength(3);
  });

  it('reads the alert state once per run, however many limits it checks', async () => {
    const { store, run } = setup();
    const read = vi.spyOn(store, 'getAlertStates');
    await run([entry({ value: 800 }), entry({ value: 800, id: 'index-bytes' })]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does nothing, not even a read, when there is nothing to check', async () => {
    const { store, run } = setup();
    const read = vi.spyOn(store, 'getAlertStates');
    expect(await run([])).toEqual({ sent: 0, failed: 0 });
    expect(read).not.toHaveBeenCalled();
  });
});
