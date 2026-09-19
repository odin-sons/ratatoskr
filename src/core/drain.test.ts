// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  FIXED_NOW_ISO,
  clientError,
  makeEvent,
  makeSubscription,
  rateLimited,
  serverError,
} from '../testing/fakes.ts';
import { makeHarness, type Harness } from '../testing/harness.ts';
import { DISCORD, OUTBOX_BACKOFF, OUTBOX_MAX_ATTEMPTS, TICK_BUDGET } from './constants.ts';
import { backoffSeconds, collapseEquivalent, drainOutbox, scheduleFailure } from './drain.ts';
import { outboxId } from './ids.ts';
import type { DueDelivery, ModEvent, Subscription } from './types.ts';

const now = new Date(FIXED_NOW_ISO);

async function enqueue(h: Harness, sub: Subscription, events: ModEvent[], nextAttemptAt = FIXED_NOW_ISO): Promise<void> {
  h.store.addSubscription(sub);
  await h.store.commit({
    source: events[0]?.pkg.source ?? 'thunderstore:valheim',
    packages: events.map((e) => e.pkg),
    events,
    outbox: events.map((e) => ({
      id: outboxId(sub.id, e.id),
      subscriptionId: sub.id,
      eventId: e.id,
      attempts: 0,
      nextAttemptAt,
    })),
    state: { id: events[0]?.pkg.source ?? 'thunderstore:valheim', cursor: null, etag: null, bootstrapped: true, lastOkAt: null },
  });
}

const drain = (h: Harness, at = now) =>
  drainOutbox({ store: h.store, sender: h.sender, renderer: h.renderer, now: at });

const evs = (n: number, prefix = 'P'): ModEvent[] =>
  Array.from({ length: n }, (_, i) => makeEvent({ pkg: { packageId: `${prefix}${i}-Mod`, owner: `${prefix}${i}`, name: 'Mod' } }));

describe('scheduleFailure / backoff', () => {
  const row = { id: 'r', subscriptionId: 's', eventId: 'e', attempts: 2, nextAttemptAt: FIXED_NOW_ISO };

  it('backs off exponentially up to the max', () => {
    expect(backoffSeconds(0)).toBe(OUTBOX_BACKOFF.baseSeconds);
    expect(backoffSeconds(2)).toBe(OUTBOX_BACKOFF.baseSeconds * 4);
    expect(backoffSeconds(50)).toBe(OUTBOX_BACKOFF.maxSeconds);
  });

  it('honours retry_after over the backoff curve', () => {
    const out = scheduleFailure(row, { ok: false, retryable: true, retryAfterSeconds: 7.2, status: 429 }, now);
    expect(out).toEqual({ nextAttemptAt: new Date(now.getTime() + 7200).toISOString(), parked: false });
  });

  it('parks at the attempt ceiling and immediately for non-retryable errors', () => {
    const last = { ...row, attempts: OUTBOX_MAX_ATTEMPTS - 1 };
    expect(scheduleFailure(last, { ok: false, retryable: true, retryAfterSeconds: null, status: 500 }, now).parked).toBe(true);
    expect(scheduleFailure(row, { ok: false, retryable: false, status: 404 }, now).parked).toBe(true);
  });
});

describe('collapseEquivalent', () => {
  const due = (event: ModEvent): DueDelivery => ({
    row: { id: `r-${event.id}`, subscriptionId: 's', eventId: event.id, attempts: 0, nextAttemptAt: FIXED_NOW_ISO },
    subscription: makeSubscription(),
    event,
  });

  it('keeps the first equivalent event and fills alsoOn from other stores', () => {
    const ts = makeEvent({ pkg: { store: 'thunderstore', owner: 'Auth', name: 'Cool-Mod', version: '2.0.0' } });
    const hx = makeEvent({ pkg: { store: 'hexium', owner: 'auth', name: 'Cool Mod', version: '2.0.0', url: 'https://hexium.invalid/x/' } });
    const out = collapseEquivalent([due(ts), due(hx)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.delivery.event.id).toBe(ts.id);
    expect(out[0]!.delivery.event.alsoOn).toEqual([{ store: 'hexium', url: 'https://hexium.invalid/x/' }]);
    expect(out[0]!.rows.map((r) => r.eventId)).toEqual([ts.id, hx.id]);
  });

  it('does not merge different versions or same-store items', () => {
    const a = makeEvent({ pkg: { owner: 'A', name: 'B', version: '1.0.0' } });
    const b = makeEvent({ pkg: { owner: 'A', name: 'B', version: '1.0.1', store: 'hexium' } });
    expect(collapseEquivalent([due(a), due(b)])).toHaveLength(2);
    const c = makeEvent({ pkg: { owner: 'A', name: 'B', version: '1.0.0', source: 'thunderstore:other' } });
    expect(collapseEquivalent([due(a), due(c)])).toHaveLength(2);
  });
});

describe('drainOutbox', () => {
  it('sends one message per event for immediate subscriptions and marks them delivered', async () => {
    const h = makeHarness();
    const events = evs(3);
    await enqueue(h, makeSubscription({ mode: 'immediate' }), events);
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 3, failed: 0, deferred: 0 });
    expect(h.sender.calls.map((c) => c.payload.content)).toEqual(events.map((e) => `immediate:${e.id}`));
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('does not send rows before their digest boundary', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'digest' }), evs(2), '2026-09-19T12:30:00.000Z');
    expect((await drain(h)).sent).toBe(0);
    expect(h.sender.calls).toHaveLength(0);
    expect(h.store.pendingRows()).toHaveLength(2);
  });

  it('sends one digest containing every due event once the boundary is reached', async () => {
    const h = makeHarness();
    const events = evs(3);
    await enqueue(h, makeSubscription({ mode: 'digest' }), events, '2026-09-19T12:30:00.000Z');
    const report = await drain(h, new Date('2026-09-19T12:30:00.000Z'));
    expect(report.sent).toBe(1);
    expect(h.sender.calls[0]!.payload.content).toBe(`digest:${events.map((e) => e.id).join(',')}`);
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('renders new events and watchlist hits in detail for that subscription only', async () => {
    const h = makeHarness();
    const fresh = makeEvent({ pkg: { packageId: 'A-New' } });
    const hit = makeEvent({ kind: 'update', versionFrom: '0.1', pkg: { owner: 'Star', name: 'Mod', packageId: 'Star-Mod' } });
    const plain = makeEvent({ kind: 'update', versionFrom: '0.1', pkg: { packageId: 'B-Plain', owner: 'B', name: 'Plain' } });
    await enqueue(h, makeSubscription({ mode: 'digest', filter: { watchlist: ['star'] } }), [fresh, hit, plain]);
    await drain(h);
    expect(h.renderer.digestCalls[0]!.detailed).toEqual([true, true, false]);
  });

  it('reschedules on 429 using retry_after and keeps the row', async () => {
    const h = makeHarness();
    const [ev] = evs(1);
    await enqueue(h, makeSubscription(), [ev!]);
    h.sender.enqueue(rateLimited(12));
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 0, failed: 1 });
    const [row] = h.store.outboxRows();
    expect(row).toMatchObject({ attempts: 1, parked: false, delivered: false });
    expect(row!.nextAttemptAt).toBe(new Date(now.getTime() + 12_000).toISOString());
    expect((await drain(h)).sent).toBe(0);
    expect((await drain(h, new Date(now.getTime() + 12_000))).sent).toBe(1);
  });

  it('applies exponential backoff on 5xx', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription(), evs(1));
    h.sender.enqueue(serverError(503));
    await drain(h);
    expect(h.store.outboxRows()[0]!.nextAttemptAt).toBe(new Date(now.getTime() + OUTBOX_BACKOFF.baseSeconds * 1000).toISOString());
  });

  it('parks a row once attempts reach the ceiling', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription(), evs(1));
    h.sender.fallback = () => serverError(500);
    let at = now;
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await drain(h, at);
      at = new Date(at.getTime() + OUTBOX_BACKOFF.maxSeconds * 1000 + 1);
    }
    const [row] = h.store.outboxRows();
    expect(row).toMatchObject({ parked: true, delivered: false });
    expect(row!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    const callsBefore = h.sender.calls.length;
    await drain(h, at);
    expect(h.sender.calls).toHaveLength(callsBefore);
  });

  it('parks immediately on a non-retryable error', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription(), evs(1));
    h.sender.enqueue(clientError(404));
    await drain(h);
    expect(h.store.outboxRows()[0]).toMatchObject({ parked: true, attempts: 1 });
  });

  it('leaves a digest pending and retries it whole when a later message fails', async () => {
    const h = makeHarness();
    h.renderer.perMessage = 1;
    const events = evs(3);
    await enqueue(h, makeSubscription({ mode: 'digest' }), events);
    h.sender.enqueue({ ok: true }, serverError(500));
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 1, failed: 1 });
    expect(h.store.pendingRows()).toHaveLength(3);
    expect(h.store.outboxRows().every((r) => r.attempts === 1)).toBe(true);
    const retry = await drain(h, new Date(now.getTime() + OUTBOX_BACKOFF.baseSeconds * 1000));
    expect(retry.sent).toBe(3);
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('stops sending to a webhook after a retryable failure in the same tick', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'immediate' }), evs(3));
    h.sender.enqueue({ ok: true }, rateLimited(30));
    const report = await drain(h);
    expect(h.sender.calls).toHaveLength(2);
    expect(report).toMatchObject({ sent: 1, failed: 1, deferred: 1 });
    expect(h.store.pendingRows()).toHaveLength(2);
    expect(h.store.pendingRows().filter((r) => r.attempts === 0)).toHaveLength(1);
  });

  it('caps sends per webhook per tick and leaves the rest for the next tick', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'immediate' }), evs(DISCORD.webhookRequestsPer2s + 3));
    const report = await drain(h);
    expect(report.sent).toBe(DISCORD.webhookRequestsPer2s);
    expect(report.deferred).toBe(3);
    expect(h.store.pendingRows()).toHaveLength(3);
    expect((await drain(h)).sent).toBe(3);
  });

  it('caps total Discord sends per tick and reports the remainder as deferred', async () => {
    const h = makeHarness();
    const subs = Array.from({ length: 10 }, (_, i) =>
      makeSubscription({ id: `s${i}`, webhookUrl: `https://discord.invalid/api/webhooks/${i}/t`, mode: 'immediate' }),
    );
    const events = evs(TICK_BUDGET.maxDiscordSends);
    for (const sub of subs) await enqueue(h, sub, events.slice(0, 5));
    const report = await drain(h);
    expect(report.sent).toBe(TICK_BUDGET.maxDiscordSends);
    expect(h.sender.calls).toHaveLength(TICK_BUDGET.maxDiscordSends);
    expect(report.deferred).toBe(50 - TICK_BUDGET.maxDiscordSends);
    expect(h.store.pendingRows()).toHaveLength(50 - TICK_BUDGET.maxDiscordSends);
  });

  it('defers a digest that does not fit the remaining webhook budget instead of splitting it', async () => {
    const h = makeHarness();
    const a = makeSubscription({ id: 'a', mode: 'immediate' });
    const b = makeSubscription({ id: 'b', mode: 'digest' });
    await enqueue(h, a, evs(4, 'A'));
    h.renderer.perMessage = 1;
    await enqueue(h, b, evs(3, 'B'));
    const report = await drain(h);
    expect(report.sent).toBe(4);
    expect(report.deferred).toBe(3);
    expect(h.store.pendingRows().every((r) => r.subscriptionId === 'b')).toBe(true);
  });

  it('still sends an oversized digest when it is the first thing for its webhook', async () => {
    const h = makeHarness();
    h.renderer.perMessage = 1;
    await enqueue(h, makeSubscription({ mode: 'digest' }), evs(DISCORD.webhookRequestsPer2s + 2));
    const report = await drain(h);
    expect(report.sent).toBe(DISCORD.webhookRequestsPer2s + 2);
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('collapses the same release from two stores into one item with alsoOn', async () => {
    const h = makeHarness();
    const ts = makeEvent({ pkg: { store: 'thunderstore', owner: 'Au', name: 'Mod', version: '3.0.0' } });
    const hx = makeEvent({ pkg: { store: 'hexium', owner: 'Au', name: 'Mod', version: '3.0.0', url: 'https://hexium.invalid/au-mod/' } });
    await enqueue(h, makeSubscription({ mode: 'digest' }), [ts]);
    await enqueue(h, makeSubscription({ mode: 'digest' }), [hx]);
    await drain(h);
    const call = h.renderer.digestCalls[0]!;
    expect(call.events).toHaveLength(1);
    expect(call.events[0]!.alsoOn).toEqual([{ store: 'hexium', url: 'https://hexium.invalid/au-mod/' }]);
    expect(h.store.pendingRows()).toEqual([]);
    expect(h.store.outboxRows().every((r) => r.delivered)).toBe(true);
  });

  it('does not collapse when the subscription opted out of cross-store dedup', async () => {
    const h = makeHarness();
    const ts = makeEvent({ pkg: { store: 'thunderstore', owner: 'Au', name: 'Mod', version: '3.0.0' } });
    const hx = makeEvent({ pkg: { store: 'hexium', owner: 'Au', name: 'Mod', version: '3.0.0' } });
    const sub = makeSubscription({ mode: 'digest', filter: { dedupAcrossStores: false } });
    await enqueue(h, sub, [ts]);
    await enqueue(h, sub, [hx]);
    await drain(h);
    expect(h.renderer.digestCalls[0]!.events).toHaveLength(2);
  });

  it('skips disabled subscriptions without touching their rows', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ enabled: false }), evs(2));
    expect((await drain(h)).sent).toBe(0);
    expect(h.store.pendingRows()).toHaveLength(2);
  });

  it('treats a throwing sender as a retryable failure', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription(), evs(1));
    h.sender.fallback = () => {
      throw new Error('network down');
    };
    const report = await drain(h);
    expect(report.failed).toBe(1);
    expect(h.store.outboxRows()[0]).toMatchObject({ attempts: 1, parked: false });
  });
});
