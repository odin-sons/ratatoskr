// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FIXED_NOW_ISO, makeEvent, makeSubscription } from '../testing/fakes.ts';
import { makeHarness, type Harness } from '../testing/harness.ts';
import { drainOutbox } from './drain.ts';
import { fanOut, type CompiledSubscription } from './fanout.ts';
import { compileFilter } from './filter.ts';
import { outboxId } from './ids.ts';
import type { ModEvent, Subscription } from './types.ts';

const now = new Date(FIXED_NOW_ISO);

const mod = (owner: string, name: string): ModEvent => makeEvent({ pkg: { packageId: `${owner}-${name}`, owner, name } });

const compiled = (sub: Subscription): CompiledSubscription => ({ sub, filter: compileFilter(sub.filter) });

describe('fan-out with package filters', () => {
  it('routes each event only to the subscriptions whose package filter accepts it', async () => {
    const one = compiled(makeSubscription({ id: 'one-mod', filter: { packages: ['Author-CoolMod'] } }));
    const author = compiled(makeSubscription({ id: 'author', filter: { packages: ['Author'] } }));
    const noisy = compiled(makeSubscription({ id: 'all-but-noisy', filter: { excludePackages: ['Noisy'] } }));
    const cool = mod('Author', 'CoolMod');
    const other = mod('Author', 'Other');
    const spam = mod('Noisy', 'Spam');
    const { rows } = await fanOut([cool, other, spam], [one, author, noisy], { recentEventsByReleaseKeys: async () => new Map() }, now);
    const routed = (id: string) => rows.filter((r) => r.subscriptionId === id).map((r) => r.eventId);
    expect(routed('one-mod')).toEqual([cool.id]);
    expect(routed('author')).toEqual([cool.id, other.id]);
    expect(routed('all-but-noisy')).toEqual([cool.id, other.id]);
  });
});

async function enqueue(h: Harness, sub: Subscription, events: ModEvent[]): Promise<void> {
  h.store.addSubscription(sub);
  await h.store.commit({
    source: 'thunderstore:valheim',
    packages: events.map((e) => e.pkg),
    events,
    outbox: events.map((e) => ({ id: outboxId(sub.id, e.id), subscriptionId: sub.id, eventId: e.id, attempts: 0, nextAttemptAt: FIXED_NOW_ISO })),
    state: { id: 'thunderstore:valheim', cursor: null, etag: null, bootstrapped: true, lastOkAt: null },
  });
}

const drain = (h: Harness) => drainOutbox({ store: h.store, sender: h.sender, renderer: h.renderer, now });

describe('drain re-checks the package filters against the current subscription', () => {
  it('drops a due delivery once its package is excluded, and keeps the others', async () => {
    const h = makeHarness();
    const keep = mod('Author', 'Keep');
    const gone = mod('Noisy', 'Spam');
    await enqueue(h, makeSubscription({ mode: 'immediate', filter: {} }), [keep, gone]);
    h.store.addSubscription(makeSubscription({ mode: 'immediate', filter: { excludePackages: ['noisy'] } }));
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 1, filtered: 1, failed: 0 });
    expect(h.sender.calls.map((c) => c.payload.content)).toEqual([`immediate:${keep.id}`]);
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('drops a due delivery that a newly added allowlist no longer accepts', async () => {
    const h = makeHarness();
    const keep = mod('Author', 'Keep');
    const gone = mod('Other', 'Mod');
    await enqueue(h, makeSubscription({ mode: 'digest', filter: {} }), [keep, gone]);
    h.store.addSubscription(makeSubscription({ mode: 'digest', filter: { packages: ['Author-Keep'] } }));
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 1, filtered: 1 });
    expect(h.sender.calls[0]!.payload.content).toBe(`digest:${keep.id}`);
    expect(h.store.pendingRows()).toEqual([]);
  });
});
