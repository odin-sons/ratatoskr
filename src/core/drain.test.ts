// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import {
  FIXED_NOW_ISO,
  clientError,
  makeEvent,
  makeSubscription,
  rateLimited,
  serverError,
} from '../testing/fakes.ts';
import { makeHarness, type Harness } from '../testing/harness.ts';
import { SubrequestBudget } from './budget.ts';
import { DIGEST_FIT_ATTEMPTS, DISCORD, OUTBOX_BACKOFF, OUTBOX_MAX_ATTEMPTS, POISON_ISOLATION_MAX_ITEMS, TICK_BUDGET } from './constants.ts';
import { backoffSeconds, collapseEquivalent, drainOutbox, scheduleFailure } from './drain.ts';
import { outboxId } from './ids.ts';
import { renderDigest, renderImmediate } from '../render/index.ts';
import type { DiscordMessage, DueDelivery, ModEvent, Subscription } from './types.ts';

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

const drain = (h: Harness, at = now, budget?: SubrequestBudget) =>
  drainOutbox({ store: h.store, sender: h.sender, renderer: h.renderer, now: at, ...(budget ? { budget } : {}) });

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

  it('hands the store emoji to every digest and immediate render', async () => {
    const storeEmojis = { thunderstore: '<:thunderstore:123456789012345678>' };
    const run = (mode: 'digest' | 'immediate') => async () => {
      const h = makeHarness();
      await enqueue(h, makeSubscription({ mode }), evs(2));
      await drainOutbox({ store: h.store, sender: h.sender, renderer: h.renderer, now, storeEmojis });
      return h;
    };
    expect((await run('digest')()).renderer.digestCalls.map((c) => c.storeEmojis)).toEqual([storeEmojis]);
    expect((await run('immediate')()).renderer.immediateEmojis).toEqual([storeEmojis, storeEmojis]);
    const bare = makeHarness();
    await enqueue(bare, makeSubscription({ mode: 'immediate' }), evs(1));
    await drain(bare);
    expect(bare.renderer.immediateEmojis).toEqual([undefined]);
  });

  describe('a message Discord rejects with 400 is retried once with the core buttons only', () => {
    const real = { renderDigest, renderImmediate };
    const rich = () =>
      makeEvent({
        kind: 'update',
        versionFrom: '0.9.0',
        pkg: {
          packageId: 'A-Mod',
          owner: 'A',
          name: 'Mod',
          url: 'https://thunderstore.io/c/valheim/p/A/Mod/',
          downloadUrl: 'https://thunderstore.io/package/download/A/Mod/1.0.0/',
          websiteUrl: 'https://example.com/mod',
        },
      });
    const labelsOf = (payload: DiscordMessage): string[] => {
      const container = payload.components![0] as { components: { type: number; components?: { label: string }[] }[] };
      return container.components.at(-1)!.components!.map((b) => b.label);
    };
    const rejectsOptionalButtons = (h: Harness): void => {
      h.sender.fallback = (call) => (labelsOf(call.payload).length > 2 ? clientError(400) : { ok: true });
    };

    it('resends without Download and Website, delivers the row and counts it as degraded', async () => {
      const h = makeHarness();
      rejectsOptionalButtons(h);
      await enqueue(h, makeSubscription({ mode: 'immediate' }), [rich()]);
      const report = await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now });
      expect(h.sender.calls.map((c) => labelsOf(c.payload))).toEqual([['Mod page', 'Download', 'Website'], ['Mod page']]);
      expect(report).toMatchObject({ sent: 1, failed: 0, parked: 0, degraded: 1 });
      expect(h.store.outboxRows()[0]).toMatchObject({ delivered: true, parked: false });
    });

    it('keeps the mod page button and everything else in the message', async () => {
      const h = makeHarness();
      rejectsOptionalButtons(h);
      await enqueue(h, makeSubscription({ mode: 'immediate' }), [rich()]);
      await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now });
      const [full, reduced] = h.sender.calls.map((c) => c.payload);
      expect(reduced!.flags).toBe(full!.flags);
      expect(JSON.stringify(reduced)).toContain('"label":"Mod page"');
      expect(JSON.stringify(reduced)).not.toContain('example.com/mod');
      expect(JSON.stringify(reduced)).not.toContain('package/download');
      const first = (m: DiscordMessage) => (m.components![0] as { components: unknown[] }).components[0];
      expect(first(reduced!)).toEqual(first(full!));
    });

    it('parks the row as before when the reduced message is rejected too, without counting it as degraded', async () => {
      const h = makeHarness();
      h.sender.fallback = () => clientError(400);
      await enqueue(h, makeSubscription({ mode: 'immediate' }), [rich()]);
      const report = await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now });
      expect(h.sender.calls).toHaveLength(2);
      expect(report).toMatchObject({ sent: 0, failed: 1, parked: 1, degraded: 0 });
      expect(h.store.outboxRows()[0]).toMatchObject({ parked: true });
    });

    it('does not resend when the message has no optional buttons, and parks it at once', async () => {
      const h = makeHarness();
      h.sender.fallback = () => clientError(400);
      const bare = makeEvent({ kind: 'update', versionFrom: '0.9.0', pkg: { packageId: 'A-Mod', owner: 'A', name: 'Mod', url: 'https://thunderstore.io/c/valheim/p/A/Mod/', downloadUrl: null, websiteUrl: null } });
      await enqueue(h, makeSubscription({ mode: 'immediate' }), [bare]);
      const report = await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now });
      expect(h.sender.calls).toHaveLength(1);
      expect(report).toMatchObject({ failed: 1, parked: 1, degraded: 0 });
    });

    it('does not resend a message a renderer cannot reduce', async () => {
      const h = makeHarness();
      h.sender.enqueue(clientError(400));
      await enqueue(h, makeSubscription({ mode: 'immediate' }), evs(1));
      const report = await drain(h);
      expect(h.sender.calls).toHaveLength(1);
      expect(report).toMatchObject({ failed: 1, parked: 1, degraded: 0 });
    });

    it('only reacts to 400: other client errors and server errors keep their handling', async () => {
      for (const failure of [clientError(404), clientError(403), serverError(500), rateLimited(3)]) {
        const h = makeHarness();
        h.sender.enqueue(failure);
        await enqueue(h, makeSubscription({ mode: 'immediate' }), [rich()]);
        const report = await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now });
        expect(h.sender.calls).toHaveLength(1);
        expect(report.degraded).toBe(0);
      }
    });

    it('does not resend without a send left in the budget, and leaves the row parked', async () => {
      const h = makeHarness();
      rejectsOptionalButtons(h);
      await enqueue(h, makeSubscription({ mode: 'immediate' }), [rich()]);
      const report = await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now, budget: new SubrequestBudget(1) });
      expect(h.sender.calls).toHaveLength(1);
      expect(report.degraded).toBe(0);
      expect(h.store.outboxRows()[0]).toMatchObject({ parked: true });
    });

    it('never applies to digests', async () => {
      const h = makeHarness();
      h.sender.fallback = () => clientError(400);
      await enqueue(h, makeSubscription({ mode: 'digest' }), [rich()]);
      const report = await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now });
      expect(h.sender.calls).toHaveLength(1);
      expect(report.degraded).toBe(0);
    });

    it('logs one line without any url', async () => {
      const h = makeHarness();
      rejectsOptionalButtons(h);
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
      await enqueue(h, makeSubscription({ mode: 'immediate' }), [rich()]);
      await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now });
      spy.mockRestore();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('degraded');
      expect(lines[0]).not.toMatch(/https?:|example\.com|package\/download/);
    });

    it('several immediate rows are handled independently', async () => {
      const h = makeHarness();
      rejectsOptionalButtons(h);
      const events = [rich(), makeEvent({ kind: 'update', versionFrom: '0.9.0', pkg: { packageId: 'B-Mod', owner: 'B', name: 'Mod', url: 'https://thunderstore.io/c/valheim/p/B/Mod/', downloadUrl: null, websiteUrl: null } })];
      await enqueue(h, makeSubscription({ mode: 'immediate' }), events);
      const report = await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now });
      expect(report).toMatchObject({ sent: 2, failed: 0, parked: 0, degraded: 1 });
      expect(h.sender.calls).toHaveLength(3);
    });
  });

  it('hands the source-button emoji and the language to every digest and immediate render', async () => {
    const settings = { storeEmojis: { thunderstore: '<:thunderstore:123456789012345678>' }, ratatoskrEmoji: '<:ratatoskr:123456789012345679>', locale: 'ru' as const };
    for (const mode of ['digest', 'immediate'] as const) {
      const h = makeHarness();
      await enqueue(h, makeSubscription({ mode }), evs(2));
      await drainOutbox({ store: h.store, sender: h.sender, renderer: h.renderer, now, ...settings });
      if (mode === 'digest') {
        expect(h.renderer.digestCalls.map((c) => [c.ratatoskrEmoji, c.locale])).toEqual([[settings.ratatoskrEmoji, 'ru']]);
      } else {
        expect(h.renderer.immediateSettings).toEqual([
          { ratatoskrEmoji: settings.ratatoskrEmoji, locale: 'ru' },
          { ratatoskrEmoji: settings.ratatoskrEmoji, locale: 'ru' },
        ]);
      }
    }
    const bare = makeHarness();
    await enqueue(bare, makeSubscription({ mode: 'immediate' }), evs(1));
    await drain(bare);
    expect(bare.renderer.immediateSettings).toEqual([{ ratatoskrEmoji: undefined, locale: undefined }]);
  });

  it('delivers real messages: a Components V2 message with buttons for immediate mode, embeds with the project field for digests', async () => {
    const real = { renderDigest, renderImmediate };
    const storeEmojis = { thunderstore: '<:thunderstore:123456789012345678>' };
    const event = makeEvent({ kind: 'update', versionFrom: '0.9.0', pkg: { packageId: 'A-Mod', owner: 'A', name: 'Mod', url: 'https://thunderstore.io/c/valheim/p/A/Mod/', downloadUrl: 'https://thunderstore.io/package/download/A/Mod/1.0.0/' } });
    for (const mode of ['immediate', 'digest'] as const) {
      const h = makeHarness();
      await enqueue(h, makeSubscription({ mode }), [event]);
      await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now, storeEmojis, locale: 'ru' });
      const payload = h.sender.calls[0]!.payload;
      if (mode === 'immediate') {
        expect(payload.flags).toBe(DISCORD.componentsV2Flag);
        expect(payload.embeds).toBeUndefined();
        expect(payload.content).toBeUndefined();
        const container = payload.components![0] as { components: { type: number; components?: { label: string }[] }[] };
        const row = container.components.at(-1)!;
        expect(row.components!.map((b) => b.label)).toEqual(['Страница мода', 'Скачать']);
        expect(JSON.stringify(payload)).toContain('<:thunderstore:123456789012345678>');
        expect(JSON.stringify(payload)).toContain('Обновление от A');
      } else {
        expect(payload.embeds![0]!.description).toContain('1 обновление');
        expect(payload.embeds!.at(-1)!.fields!.at(-1)!.value).toBe('-# [ratatoskr v1.0.0](https://github.com/odin-sons/ratatoskr)');
        expect(payload.components).toBeUndefined();
      }
    }
  });

  it('reschedules on 429 using retry_after and keeps the row', async () => {
    const h = makeHarness();
    const [ev] = evs(1);
    await enqueue(h, makeSubscription(), [ev!]);
    h.sender.enqueue(rateLimited(12));
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 0, failed: 1 });
    const [row] = h.store.outboxRows();
    expect(row).toMatchObject({ attempts: 0, parked: false, delivered: false });
    expect(row!.nextAttemptAt).toBe(new Date(now.getTime() + 12_000).toISOString());
    expect((await drain(h)).sent).toBe(0);
    expect((await drain(h, new Date(now.getTime() + 12_000))).sent).toBe(1);
  });

  it('never parks a row that only meets 429 with retry_after, however often it repeats', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription(), evs(1));
    let at = now;
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 4; i++) {
      h.sender.enqueue(rateLimited(30));
      await drain(h, at);
      at = new Date(at.getTime() + 30_000);
    }
    expect(h.store.outboxRows()[0]).toMatchObject({ attempts: 0, parked: false, delivered: false });
    expect((await drain(h, at)).sent).toBe(1);
  });

  it('still counts a 429 without retry_after as a failed attempt', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription(), evs(1));
    h.sender.enqueue({ ok: false, retryable: true, retryAfterSeconds: null, status: 429 });
    await drain(h);
    expect(h.store.outboxRows()[0]).toMatchObject({ attempts: 1, parked: false });
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
    expect(h.store.pendingRows().every((r) => r.attempts === 0)).toBe(true);
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

  it('sends the part of a digest that fits the remaining webhook allowance and leaves the rest due', async () => {
    const h = makeHarness();
    const a = makeSubscription({ id: 'a', mode: 'immediate' });
    const b = makeSubscription({ id: 'b', mode: 'digest' });
    await enqueue(h, a, evs(4, 'A'));
    h.renderer.perMessage = 1;
    await enqueue(h, b, evs(3, 'B'));
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 5, failed: 0, deferred: 2 });
    expect(h.store.pendingRows().every((r) => r.subscriptionId === 'b')).toBe(true);
    expect(h.store.pendingRows()).toHaveLength(2);
  });

  it('splits an oversized digest across ticks instead of exceeding the per-webhook cap', async () => {
    const h = makeHarness();
    h.renderer.perMessage = 1;
    const events = evs(DISCORD.webhookRequestsPer2s + 2);
    await enqueue(h, makeSubscription({ mode: 'digest' }), events);
    const first = await drain(h);
    expect(first).toMatchObject({ sent: DISCORD.webhookRequestsPer2s, deferred: 2, parked: 0 });
    expect(h.store.pendingRows()).toHaveLength(2);
    const second = await drain(h);
    expect(second).toMatchObject({ sent: 2, deferred: 0 });
    expect(h.store.pendingRows()).toEqual([]);
    expect(deliveredEventIds(h)).toEqual(events.map((e) => e.id));
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

function deliveredEventIds(h: Harness): string[] {
  return h.sender.calls.flatMap((c) => (c.payload.content ?? '').replace(/^digest:/, '').split(',').filter(Boolean));
}

/** Accepts `perWindow` messages per window, then answers 429 until `newWindow()`. */
function windowedSender(h: Harness, perWindow = DISCORD.webhookRequestsPer2s): { newWindow(): void } {
  let inWindow = 0;
  h.sender.fallback = () => {
    if (inWindow >= perWindow) return rateLimited(1);
    inWindow += 1;
    return { ok: true };
  };
  return {
    newWindow: () => {
      inWindow = 0;
    },
  };
}

describe('progressive digest delivery', () => {
  it('delivers a 400-row backlog over successive ticks, each event exactly once, nothing parked', async () => {
    const h = makeHarness();
    h.renderer.perMessage = 10;
    const events = evs(400);
    await enqueue(h, makeSubscription({ mode: 'digest' }), events);
    const window = windowedSender(h);

    let ticks = 0;
    while (h.store.pendingRows().length > 0 && ticks < 30) {
      window.newWindow();
      const report = await drain(h, new Date(now.getTime() + ticks * 300_000));
      expect(report.failed).toBe(0);
      expect(report.parked).toBe(0);
      ticks += 1;
    }
    expect(ticks).toBe(Math.ceil(400 / 10 / DISCORD.webhookRequestsPer2s));
    const delivered = deliveredEventIds(h);
    expect(delivered).toHaveLength(400);
    expect(new Set(delivered).size).toBe(400);
    expect(h.store.outboxRows().every((r) => r.delivered && !r.parked && r.attempts === 0)).toBe(true);
  });

  it('delivers the oldest rows first', async () => {
    const h = makeHarness();
    h.renderer.perMessage = 1;
    const events = evs(8);
    await enqueue(h, makeSubscription({ mode: 'digest' }), events);
    await drain(h);
    expect(deliveredEventIds(h)).toEqual(events.slice(0, DISCORD.webhookRequestsPer2s).map((e) => e.id));
    expect(h.store.pendingRows().map((r) => r.eventId)).toEqual(events.slice(DISCORD.webhookRequestsPer2s).map((e) => e.id));
  });

  it('with the real renderer, delivers 400 detailed events exactly once each with nothing parked', async () => {
    const h = makeHarness();
    const real = { renderDigest, renderImmediate };
    const events = Array.from({ length: 400 }, (_, i) =>
      makeEvent({ pkg: { packageId: `Owner${i}-Mod${i}`, owner: `Owner${i}`, name: `Mod${i}`, description: 'x'.repeat(200) } }),
    );
    await enqueue(h, makeSubscription({ mode: 'digest' }), events);
    const window = windowedSender(h);
    let ticks = 0;
    while (h.store.pendingRows().length > 0 && ticks < 200) {
      window.newWindow();
      await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now: new Date(now.getTime() + ticks * 300_000) });
      ticks += 1;
    }
    expect(h.store.pendingRows()).toEqual([]);
    expect(h.store.outboxRows().some((r) => r.parked)).toBe(false);
    const wire = h.sender.calls.map((c) => JSON.stringify(c.payload)).join('\n');
    for (let i = 0; i < 400; i++) {
      expect(wire.split(`https://thunderstore.invalid/Owner${i}-Mod${i}/`).length - 1).toBe(1);
    }
    expect(h.sender.calls.length).toBeGreaterThan(DISCORD.webhookRequestsPer2s);
  });

  it('sends a compact digest in one go when it fits, with a single render', async () => {
    const h = makeHarness();
    const events = Array.from({ length: 300 }, (_, i) =>
      makeEvent({ kind: 'update', versionFrom: '0.9.0', pkg: { packageId: `Owner${i}-Mod${i}`, owner: `Owner${i}`, name: `Mod${i}` } }),
    );
    await enqueue(h, makeSubscription({ mode: 'digest' }), events);
    const renders: number[] = [];
    const counting = {
      renderDigest: (evs: ModEvent[], opts: Parameters<typeof renderDigest>[1]) => {
        renders.push(evs.length);
        return renderDigest(evs, opts);
      },
      renderImmediate,
    };
    const report = await drainOutbox({ store: h.store, sender: h.sender, renderer: counting, now });
    expect(report.deferred).toBe(0);
    expect(h.store.pendingRows()).toEqual([]);
    expect(renders).toEqual([300]);
  });

  it('keeps the CPU cost of an oversized 400-row mixed backlog within a loose bound', async () => {
    const real = { renderDigest, renderImmediate };
    const events = Array.from({ length: 400 }, (_, i) =>
      makeEvent({
        kind: i % 5 === 0 ? 'new' : 'update',
        versionFrom: i % 5 === 0 ? null : '0.9.0',
        pkg: { packageId: `Owner${i}-Mod${i}`, owner: `Owner${i}`, name: `Mod${i}`, description: 'x'.repeat(300) },
      }),
    );
    const timed = async (): Promise<number> => {
      const h = makeHarness();
      await enqueue(h, makeSubscription({ mode: 'digest' }), events);
      const start = performance.now();
      await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now });
      return performance.now() - start;
    };
    await timed();
    const samples = [await timed(), await timed(), await timed()];
    expect(Math.min(...samples)).toBeLessThan(150);
  });

  it('bounds the number of renders for an oversized digest', async () => {
    const h = makeHarness();
    h.renderer.perMessage = 7;
    await enqueue(h, makeSubscription({ mode: 'digest' }), evs(400));
    await drain(h);
    expect(h.renderer.digestCalls.length).toBeLessThanOrEqual(1 + DIGEST_FIT_ATTEMPTS + Math.ceil(Math.log2(400)));
  });

  it('a failure marks only the sent prefix as failed; later rows are untouched', async () => {
    const h = makeHarness();
    h.renderer.perMessage = 1;
    await enqueue(h, makeSubscription({ mode: 'digest' }), evs(8));
    h.sender.enqueue({ ok: true }, serverError(500));
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 1, failed: 1, deferred: 3 });
    expect(h.store.outboxRows().map((r) => r.attempts)).toEqual([1, 1, 1, 1, 1, 0, 0, 0]);
    expect(h.store.outboxRows().some((r) => r.parked)).toBe(false);
  });

  it('shares the webhook allowance between subscriptions on the same webhook without starving either', async () => {
    const h = makeHarness();
    h.renderer.perMessage = 1;
    await enqueue(h, makeSubscription({ id: 'a', mode: 'digest' }), evs(3, 'A'));
    await enqueue(h, makeSubscription({ id: 'b', mode: 'digest' }), evs(3, 'B'));
    await drain(h);
    const deliveredFor = (id: string) => h.store.outboxRows().filter((r) => r.subscriptionId === id && r.delivered).length;
    expect(deliveredFor('a')).toBe(3);
    expect(deliveredFor('b')).toBe(2);
    await drain(h);
    expect(h.store.pendingRows()).toEqual([]);
  });
});

describe('drain: current filter is re-checked at delivery time', () => {
  it('does not send an NSFW event once the subscription no longer allows NSFW, and marks it delivered', async () => {
    const h = makeHarness();
    const nsfw = makeEvent({ pkg: { packageId: 'A-Lewd', owner: 'A', name: 'Lewd', isNsfw: true } });
    const safe = makeEvent({ pkg: { packageId: 'B-Safe', owner: 'B', name: 'Safe' } });
    await enqueue(h, makeSubscription({ mode: 'immediate', filter: { allowNsfw: true } }), [nsfw, safe]);
    h.store.addSubscription(makeSubscription({ mode: 'immediate', filter: { allowNsfw: false } }));
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 1, filtered: 1, failed: 0 });
    expect(h.sender.calls.map((c) => c.payload.content)).toEqual([`immediate:${safe.id}`]);
    expect(h.store.pendingRows()).toEqual([]);
    expect(h.store.outboxRows().every((r) => r.delivered)).toBe(true);
  });

  it('filters digest rows too and renders only what still matches', async () => {
    const h = makeHarness();
    const nsfw = makeEvent({ pkg: { packageId: 'A-Lewd', owner: 'A', name: 'Lewd', isNsfw: true } });
    const safe = makeEvent({ pkg: { packageId: 'B-Safe', owner: 'B', name: 'Safe' } });
    await enqueue(h, makeSubscription({ mode: 'digest', filter: { allowNsfw: true } }), [nsfw, safe]);
    h.store.addSubscription(makeSubscription({ mode: 'digest', filter: {} }));
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 1, filtered: 1 });
    expect(h.sender.calls[0]!.payload.content).toBe(`digest:${safe.id}`);
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('sends nothing and marks everything delivered when no row matches any more', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'digest', filter: {} }), evs(2));
    h.store.addSubscription(makeSubscription({ mode: 'digest', filter: { kinds: ['update'] } }));
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 0, filtered: 2 });
    expect(h.sender.calls).toHaveLength(0);
    expect(h.store.pendingRows()).toEqual([]);
  });
});

describe('drain: parked count', () => {
  it('reports rows parked in this drain and logs the count without the webhook url', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'immediate' }), evs(1));
    h.sender.enqueue(clientError(404));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = await drain(h);
      expect(report.parked).toBe(1);
      const lines = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(lines.filter((l) => l.includes('parked'))).toHaveLength(1);
      expect(lines.join('\n')).toContain('rows=1');
      expect(lines.join('\n')).not.toContain('discord.invalid');
    } finally {
      warn.mockRestore();
    }
  });

  it('counts every row of a parked digest', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'digest' }), evs(3));
    h.sender.enqueue(clientError(404));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await drain(h)).parked).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('reports zero when nothing was parked', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription(), evs(1));
    expect((await drain(h)).parked).toBe(0);
  });
});

describe('drain: subrequest budget', () => {
  it('stops sending when the shared budget is spent and leaves the rest due', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'immediate' }), evs(4));
    const budget = new SubrequestBudget(3);
    const report = await drain(h, now, budget);
    expect(report).toMatchObject({ sent: 3, deferred: 1 });
    expect(budget.used).toBe(3);
    expect(h.store.pendingRows()).toHaveLength(1);
  });

  it('limits a digest prefix to what the budget can still send', async () => {
    const h = makeHarness();
    h.renderer.perMessage = 1;
    await enqueue(h, makeSubscription({ mode: 'digest' }), evs(5));
    const budget = new SubrequestBudget(2);
    const report = await drain(h, now, budget);
    expect(report).toMatchObject({ sent: 2, deferred: 3 });
    expect(h.store.pendingRows()).toHaveLength(3);
  });

  it('counts sends of every webhook against the same pool', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ id: 'a', webhookUrl: 'https://discord.invalid/api/webhooks/1/a', mode: 'immediate' }), evs(2, 'A'));
    await enqueue(h, makeSubscription({ id: 'b', webhookUrl: 'https://discord.invalid/api/webhooks/2/b', mode: 'immediate' }), evs(2, 'B'));
    const budget = new SubrequestBudget(3);
    const report = await drain(h, now, budget);
    expect(report.sent).toBe(3);
    expect(h.sender.calls).toHaveLength(3);
  });
});

const WEBHOOK_A = 'https://discord.invalid/api/webhooks/1/aaa';
const WEBHOOK_B = 'https://discord.invalid/api/webhooks/2/bbb';

describe('drain: batched failure bookkeeping', () => {
  it('fails a 400-row digest with a single store call', async () => {
    const h = makeHarness();
    const updates = evs(400).map((e) => ({ ...e, kind: 'update' as const, versionFrom: '0.9.0' }));
    await enqueue(h, makeSubscription({ mode: 'digest' }), updates);
    h.sender.fallback = () => serverError(500);
    const markFailedMany = vi.spyOn(h.store, 'markFailedMany');
    const reschedule = vi.spyOn(h.store, 'rescheduleRows');
    const report = await drain(h);
    expect(report.failed).toBe(1);
    expect(markFailedMany).toHaveBeenCalledTimes(1);
    expect(markFailedMany.mock.calls[0]![0]).toHaveLength(400);
    expect(reschedule).not.toHaveBeenCalled();
    expect(h.store.outboxRows().every((r) => r.attempts === 1)).toBe(true);
  });

  it('uses one call per distinct schedule when rows carry different attempt counts', async () => {
    const h = makeHarness();
    const events = evs(6);
    await enqueue(h, makeSubscription({ mode: 'digest' }), events);
    await h.store.markFailedMany(events.slice(0, 3).map((e) => outboxId('sub-1', e.id)), FIXED_NOW_ISO, false);
    h.sender.fallback = () => serverError(500);
    const markFailedMany = vi.spyOn(h.store, 'markFailedMany');
    await drain(h);
    expect(markFailedMany).toHaveBeenCalledTimes(2);
    expect(h.store.outboxRows().map((r) => r.attempts)).toEqual([2, 2, 2, 1, 1, 1]);
  });
});

describe('drain: a failing webhook does not starve healthy ones', () => {
  const later = new Date(now.getTime() + 300_000);

  async function seed(h: Harness, mode: 'immediate' | 'digest', failingRows: number): Promise<void> {
    await enqueue(h, makeSubscription({ id: 'bad', webhookUrl: WEBHOOK_A, mode }), evs(failingRows, 'A'), '2026-09-19T11:00:00.000Z');
    await enqueue(h, makeSubscription({ id: 'good', webhookUrl: WEBHOOK_B, mode }), evs(3, 'B'), '2026-09-19T11:30:00.000Z');
    h.sender.fallback = (call) => (call.webhookUrl === WEBHOOK_A ? serverError(500) : { ok: true });
  }

  it('serves the healthy immediate subscription on the very next tick', async () => {
    const h = makeHarness();
    await seed(h, 'immediate', 450);
    await drain(h);
    expect(h.sender.callsTo(WEBHOOK_B)).toHaveLength(0);
    await drain(h, later);
    expect(h.sender.callsTo(WEBHOOK_B)).toHaveLength(3);
  });

  it('serves the healthy digest subscription on the very next tick', async () => {
    const h = makeHarness();
    h.renderer.perMessage = 1;
    await seed(h, 'digest', 450);
    await drain(h);
    await drain(h, later);
    expect(h.sender.callsTo(WEBHOOK_B)).toHaveLength(3);
  });

  it('reschedules the untried rows of the window in one call without bumping their attempts', async () => {
    const h = makeHarness();
    await seed(h, 'immediate', 450);
    const reschedule = vi.spyOn(h.store, 'rescheduleRows');
    await drain(h);
    expect(reschedule).toHaveBeenCalledTimes(1);
    expect(reschedule.mock.calls[0]![0]).toHaveLength(TICK_BUDGET.maxOutboxRows - 1);
    const rows = h.store.outboxRows().filter((r) => r.subscriptionId === 'bad');
    const retryAt = new Date(now.getTime() + OUTBOX_BACKOFF.baseSeconds * 1000).toISOString();
    const window = rows.slice(0, TICK_BUDGET.maxOutboxRows);
    expect(window.every((r) => r.nextAttemptAt === retryAt)).toBe(true);
    expect(window.filter((r) => r.attempts === 1)).toHaveLength(1);
    expect(window.filter((r) => r.attempts === 0)).toHaveLength(TICK_BUDGET.maxOutboxRows - 1);
    expect(rows.slice(TICK_BUDGET.maxOutboxRows).every((r) => r.nextAttemptAt === '2026-09-19T11:00:00.000Z')).toBe(true);
  });

  it('honours retry_after for the untried rows of a rate-limited webhook', async () => {
    const h = makeHarness();
    await seed(h, 'immediate', 10);
    h.sender.fallback = (call) => (call.webhookUrl === WEBHOOK_A ? rateLimited(90) : { ok: true });
    await drain(h);
    const retryAt = new Date(now.getTime() + 90_000).toISOString();
    expect(h.store.outboxRows().filter((r) => r.subscriptionId === 'bad').every((r) => r.nextAttemptAt === retryAt)).toBe(true);
    expect(h.sender.callsTo(WEBHOOK_B)).toHaveLength(3);
  });

  it('also reschedules rows of another subscription that shares the failing webhook', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ id: 'one', webhookUrl: WEBHOOK_A, mode: 'immediate' }), evs(2, 'A'));
    await enqueue(h, makeSubscription({ id: 'two', webhookUrl: WEBHOOK_A, mode: 'immediate' }), evs(2, 'B'));
    h.sender.fallback = () => serverError(500);
    await drain(h);
    const retryAt = new Date(now.getTime() + OUTBOX_BACKOFF.baseSeconds * 1000).toISOString();
    expect(h.store.outboxRows().every((r) => r.nextAttemptAt === retryAt)).toBe(true);
    expect(h.store.outboxRows().filter((r) => r.attempts === 1)).toHaveLength(1);
  });

  it('leaves rows deferred only by a cap or the budget where they are', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'immediate' }), evs(DISCORD.webhookRequestsPer2s + 3));
    const reschedule = vi.spyOn(h.store, 'rescheduleRows');
    await drain(h);
    expect(reschedule).not.toHaveBeenCalled();
    expect(h.store.pendingRows().every((r) => r.nextAttemptAt === FIXED_NOW_ISO)).toBe(true);
  });

  it('does not reschedule rows already delivered before the webhook started failing', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'immediate' }), evs(4));
    h.sender.enqueue({ ok: true }, serverError(500));
    await drain(h);
    const rows = h.store.outboxRows();
    expect(rows.filter((r) => r.delivered)).toHaveLength(1);
    expect(rows.filter((r) => !r.delivered && r.attempts === 1)).toHaveLength(1);
    expect(rows.filter((r) => !r.delivered && r.attempts === 0)).toHaveLength(2);
  });
});

describe('drain: unrenderable events', () => {
  const warnSpy = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  function poison(h: Harness, ids: Set<string>) {
    const original = h.renderer.renderDigest.bind(h.renderer);
    return vi.spyOn(h.renderer, 'renderDigest').mockImplementation((events, opts) => {
      if (events.some((e) => ids.has(e.id))) throw new Error('cannot render');
      return original(events, opts);
    });
  }

  it('parks one poison event of a 50-event digest and delivers the other 49', async () => {
    const h = makeHarness();
    const events = evs(50);
    const bad = events[17]!;
    await enqueue(h, makeSubscription({ mode: 'digest' }), events);
    const render = poison(h, new Set([bad.id]));
    const warn = warnSpy();
    try {
      const report = await drain(h);
      expect(report).toMatchObject({ sent: 1, failed: 1, parked: 1, deferred: 0 });
      const delivered = h.sender.calls[0]!.payload.content!.replace('digest:', '').split(',');
      expect(delivered).toEqual(events.filter((e) => e.id !== bad.id).map((e) => e.id));
      const rows = h.store.outboxRows();
      expect(rows.filter((r) => r.delivered)).toHaveLength(49);
      expect(rows.find((r) => r.eventId === bad.id)).toMatchObject({ parked: true, delivered: false, attempts: 1 });
      expect(rows.filter((r) => !r.delivered && r.eventId !== bad.id)).toEqual([]);
      expect(rows.filter((r) => r.eventId !== bad.id).every((r) => r.attempts === 0)).toBe(true);
      expect(render.mock.calls.length).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(50)) + 3);
      const lines = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(bad.id);
      expect(lines[0]).not.toContain('discord.invalid');
      expect(lines[0]).not.toContain('cannot render');
    } finally {
      warn.mockRestore();
    }
  });

  it('isolates several poison events and never retries them', async () => {
    const h = makeHarness();
    const events = evs(50);
    const bad = new Set([events[0]!.id, events[24]!.id, events[49]!.id]);
    await enqueue(h, makeSubscription({ mode: 'digest' }), events);
    poison(h, bad);
    const warn = warnSpy();
    try {
      const report = await drain(h);
      expect(report).toMatchObject({ failed: 3, parked: 3 });
      expect(h.store.outboxRows().filter((r) => r.delivered)).toHaveLength(47);
      expect(h.store.pendingRows()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    const calls = h.sender.calls.length;
    await drain(h, new Date(now.getTime() + 3_600_000));
    expect(h.sender.calls).toHaveLength(calls);
  });

  it('parks every row of a poison event that absorbed an equivalent release from another store', async () => {
    const h = makeHarness();
    const ts = makeEvent({ pkg: { store: 'thunderstore', owner: 'Au', name: 'Mod', version: '3.0.0' } });
    const hx = makeEvent({ pkg: { store: 'hexium', owner: 'Au', name: 'Mod', version: '3.0.0' } });
    const fine = makeEvent({ pkg: { packageId: 'Fine-Mod', owner: 'Fine', name: 'Mod' } });
    const sub = makeSubscription({ mode: 'digest' });
    await enqueue(h, sub, [ts, fine]);
    await enqueue(h, sub, [hx]);
    poison(h, new Set([ts.id]));
    const warn = warnSpy();
    try {
      const report = await drain(h);
      expect(report.parked).toBe(2);
    } finally {
      warn.mockRestore();
    }
    expect(h.store.outboxRows().filter((r) => r.parked)).toHaveLength(2);
    expect(h.store.outboxRows().filter((r) => r.delivered)).toHaveLength(1);
  });

  it('stays within the isolation budget when every event of the digest is unrenderable', async () => {
    const h = makeHarness();
    const events = evs(100);
    await enqueue(h, makeSubscription({ mode: 'digest' }), events);
    const render = poison(h, new Set(events.map((e) => e.id)));
    const warn = warnSpy();
    try {
      const report = await drain(h);
      expect(report.sent).toBe(0);
      expect(report.parked).toBeGreaterThan(0);
      expect(report.parked + report.deferred).toBe(100);
      const rendered = render.mock.calls.reduce((sum, call) => sum + call[0].length, 0);
      const detailedPrefix = DISCORD.webhookRequestsPer2s * DISCORD.embedsPerMessage;
      expect(rendered).toBeLessThanOrEqual(POISON_ISOLATION_MAX_ITEMS + 3 * detailedPrefix);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps making progress across ticks when isolation is cut short', async () => {
    const h = makeHarness();
    const events = evs(100);
    await enqueue(h, makeSubscription({ mode: 'digest' }), events);
    poison(h, new Set(events.map((e) => e.id)));
    const warn = warnSpy();
    let ticks = 0;
    try {
      while (h.store.pendingRows().length > 0 && ticks < 100) await drain(h, new Date(now.getTime() + ticks++ * 300_000));
    } finally {
      warn.mockRestore();
    }
    expect(h.store.pendingRows()).toEqual([]);
    expect(h.store.outboxRows().every((r) => r.parked)).toBe(true);
    expect(ticks).toBeGreaterThan(1);
  });

  it('falls back to a transient failure when no single event reproduces the error', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'digest' }), evs(4));
    const original = h.renderer.renderDigest.bind(h.renderer);
    vi.spyOn(h.renderer, 'renderDigest').mockImplementation((events, opts) => {
      if (events.length > 1) throw new Error('combination only');
      return original(events, opts);
    });
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 0, failed: 1, parked: 0 });
    expect(h.store.pendingRows().every((r) => r.attempts === 1)).toBe(true);
  });

  it('parks an immediate event whose render throws and still sends the others', async () => {
    const h = makeHarness();
    const events = evs(3);
    await enqueue(h, makeSubscription({ mode: 'immediate' }), events);
    vi.spyOn(h.renderer, 'renderImmediate').mockImplementation((event) => {
      if (event.id === events[1]!.id) throw new Error('cannot render');
      return { content: `immediate:${event.id}`, allowed_mentions: { parse: [] } };
    });
    const warn = warnSpy();
    try {
      const report = await drain(h);
      expect(report).toMatchObject({ sent: 2, failed: 1, parked: 1 });
      const lines = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(events[1]!.id);
    } finally {
      warn.mockRestore();
    }
    expect(h.store.outboxRows().find((r) => r.eventId === events[1]!.id)).toMatchObject({ parked: true });
    expect(h.store.pendingRows()).toEqual([]);
  });
});

describe('drain: subscription changelog opt-out', () => {
  const real = { renderDigest, renderImmediate };
  const withChangelog = () =>
    makeEvent({
      kind: 'update',
      versionFrom: '0.9.0',
      changelog: '- fixed a thing',
      changelogUrl: 'https://thunderstore.io/c/valheim/p/A/Mod/changelog/',
    });

  it('leaves the Changelog block out of an immediate message when the subscription opted out', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'immediate', filter: { includeChangelog: false } }), [withChangelog()]);
    await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now });
    const payload = JSON.stringify(h.sender.calls[0]!.payload);
    expect(payload).not.toContain('fixed a thing');
    expect(payload).not.toContain('Changelog');
  });

  it('still shows the Changelog block by default', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'immediate' }), [withChangelog()]);
    await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now });
    expect(JSON.stringify(h.sender.calls[0]!.payload)).toContain('fixed a thing');
  });

  it('leaves the Changelog field out of a digest message when the subscription opted out', async () => {
    const h = makeHarness();
    await enqueue(h, makeSubscription({ mode: 'digest', filter: { includeChangelog: false } }), [withChangelog()]);
    await drainOutbox({ store: h.store, sender: h.sender, renderer: real, now });
    const payload = JSON.stringify(h.sender.calls[0]!.payload);
    expect(payload).not.toContain('fixed a thing');
  });
});
