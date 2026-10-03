// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter, FIXED_NOW_ISO, SEND_OK, clientError, makeSnapshot, makeSubscription, okPoll } from '../testing/fakes.ts';
import { makeHarness, type Harness } from '../testing/harness.ts';
import { runTick } from './tick.ts';
import type { CapUsage } from './types.ts';

const HX = 'hexium:valheim';
const ALERT_WEBHOOK = 'https://discord.invalid/api/webhooks/9/alert-token';
const scheduled = Date.parse(FIXED_NOW_ISO);

const linesUsage = (value: number | null, over: Partial<CapUsage> = {}): CapUsage => ({
  id: 'index-lines',
  label: 'package index line cap',
  unit: 'lines',
  limit: 3500,
  value,
  exceeded: false,
  consequence: 'Updates of Hexium packages the bot already knows are not detected.',
  constant: 'HEXIUM_INDEX_MAX_LINES',
  ...over,
});

function setup(withWebhook = true): { h: Harness; adapter: FakeAdapter } {
  const adapter = new FakeAdapter({ id: HX });
  const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription()] });
  h.store.sources.set(HX, { id: HX, cursor: null, etag: null, bootstrapped: true, lastOkAt: FIXED_NOW_ISO });
  if (withWebhook) h.deps.alertWebhookUrl = ALERT_WEBHOOK;
  return { h, adapter };
}

const alertCalls = (h: Harness) => h.sender.callsTo(ALERT_WEBHOOK);

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('runTick: limit alerts', () => {
  it('sends an alert to the alert webhook, once, when a source reports a limit at a new level', async () => {
    const { h, adapter } = setup();
    adapter.enqueue(okPoll([], { capUsage: [linesUsage(2500)] }), okPoll([], { capUsage: [linesUsage(2510)] }));

    const first = await runTick(h.deps, scheduled);
    expect(first.alerts).toBe(1);
    expect(first.alertsFailed).toBe(0);
    expect(alertCalls(h)).toHaveLength(1);
    expect(alertCalls(h)[0]!.payload.content).toContain('🟠 hexium:valheim: package index line cap at 71 % (2,500 of 3,500 lines).');
    expect(h.store.alertStates.get('hexium:valheim:index-lines')).toMatchObject({ level: 1 });

    const second = await runTick(h.deps, scheduled + 300_000);
    expect(second.alerts).toBe(0);
    expect(alertCalls(h)).toHaveLength(1);
  });

  it('sends an exceeded alert that names the cap', async () => {
    const { h, adapter } = setup();
    adapter.enqueue(okPoll([], { capUsage: [linesUsage(null, { exceeded: true })] }));
    await runTick(h.deps, scheduled);
    expect(alertCalls(h)[0]!.payload.content).toContain('⛔ hexium:valheim: package index line cap exceeded (limit 3,500 lines).');
    expect(alertCalls(h)[0]!.payload.content).toContain('`HEXIUM_INDEX_MAX_LINES`');
  });

  it('counts the alert as a subrequest', async () => {
    const { h, adapter } = setup();
    adapter.enqueue(okPoll([], { capUsage: [linesUsage(3000)] }));
    const report = await runTick(h.deps, scheduled);
    expect(report.subrequests).toBe(1);
  });

  it('sends nothing, and keeps nothing, when no alert webhook is configured', async () => {
    const { h, adapter } = setup(false);
    adapter.enqueue(okPoll([], { capUsage: [linesUsage(3000)] }));
    const report = await runTick(h.deps, scheduled);
    expect(report.alerts).toBe(0);
    expect(h.sender.calls).toHaveLength(0);
    expect(h.store.alertStates.size).toBe(0);
  });

  it('counts a refused alert and retries it on the next tick', async () => {
    const { h, adapter } = setup();
    adapter.enqueue(okPoll([], { capUsage: [linesUsage(3000)] }), okPoll([], { capUsage: [linesUsage(3000)] }));
    h.sender.enqueue(clientError(404));
    const first = await runTick(h.deps, scheduled);
    expect(first).toMatchObject({ alerts: 0, alertsFailed: 1 });
    h.sender.enqueue(SEND_OK);
    const second = await runTick(h.deps, scheduled + 300_000);
    expect(second).toMatchObject({ alerts: 1, alertsFailed: 0 });
  });

  it('never sends an alert to a subscription webhook', async () => {
    const { h, adapter } = setup();
    adapter.enqueue(okPoll([], { capUsage: [linesUsage(3000)] }));
    await runTick(h.deps, scheduled);
    expect(h.sender.calls.filter((c) => c.webhookUrl !== ALERT_WEBHOOK)).toHaveLength(0);
  });

  it('delivers the tick’s mod updates even when the alert state cannot be read', async () => {
    const { h, adapter } = setup();
    h.store.seedPackages(HX, { 'Owner-Mod': '1.0.0' });
    vi.spyOn(h.store, 'getAlertStates').mockRejectedValue(new Error('no such table: alert_state'));
    adapter.enqueue(okPoll([makeSnapshot({ source: HX, store: 'hexium', packageId: 'Owner-Mod', version: '1.1.0' })], { capUsage: [linesUsage(3000)] }));

    const report = await runTick(h.deps, scheduled);
    expect(report.sources[HX]).toMatchObject({ status: 'ok', events: 1 });
    expect(report.sent).toBe(1);
    expect(report.alerts).toBe(0);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('limit alerts failed'))).toBe(true);
  });

  it('does not read the alert state on ticks where no source reported a limit', async () => {
    const { h, adapter } = setup();
    const read = vi.spyOn(h.store, 'getAlertStates');
    adapter.enqueue(okPoll([]));
    await runTick(h.deps, scheduled);
    expect(read).not.toHaveBeenCalled();
  });
});
