// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { OUTBOX_MAX_ATTEMPTS } from '../core/constants.ts';
import { outboxId } from '../core/ids.ts';
import type { CommitBatch } from '../core/ports.ts';
import { FIXED_NOW_ISO, makeEvent, makeSnapshot, makeSubscription } from './fakes.ts';
import { MemoryStore } from './memory-store.ts';
import { runRedeliveryScenario } from './redelivery-scenario.ts';
import { runStoreContract, type StoreContractEnv } from './store-contract.ts';

const state = { id: 'thunderstore:valheim', cursor: 'c', etag: null, bootstrapped: true, lastOkAt: null };

function batch(store: MemoryStore, over: Partial<CommitBatch> = {}): CommitBatch {
  const event = makeEvent();
  store.addSubscription(makeSubscription());
  return {
    source: state.id,
    packages: [event.pkg],
    events: [event],
    outbox: [{ id: outboxId('sub-1', event.id), subscriptionId: 'sub-1', eventId: event.id, attempts: 0, nextAttemptAt: FIXED_NOW_ISO }],
    state,
    ...over,
  };
}

function createMemoryEnv(): StoreContractEnv {
  const store = new MemoryStore();
  return {
    store,
    addSubscription: async (sub) => store.addSubscription(sub),
    setSubscriptionEnabled: async (id, enabled) => {
      const sub = store.subscriptions.get(id);
      if (sub) store.subscriptions.set(id, { ...sub, enabled });
    },
  };
}

runStoreContract('MemoryStore', createMemoryEnv);
runRedeliveryScenario('MemoryStore', createMemoryEnv);

describe('MemoryStore', () => {
  it('commits packages, events, outbox and state together', async () => {
    const store = new MemoryStore();
    await store.commit(batch(store));
    expect(store.packages.size).toBe(1);
    expect(store.events.size).toBe(1);
    expect(store.outboxRows()).toHaveLength(1);
    expect(await store.getSourceState(state.id)).toEqual(state);
    expect(await store.getKnownVersions(state.id, ['Owner-Mod', 'Nope'])).toEqual(new Map([['Owner-Mod', '1.0.0']]));
    expect(await store.getAllKnownVersions(state.id)).toEqual(new Map([['Owner-Mod', '1.0.0']]));
  });

  it('applies nothing when the commit is scripted to fail', async () => {
    const store = new MemoryStore();
    const b = batch(store);
    store.failNextCommit();
    await expect(store.commit(b)).rejects.toThrow();
    expect(store.packages.size + store.events.size + store.outbox.size + store.sources.size).toBe(0);
    await store.commit(b);
    expect(store.events.size).toBe(1);
  });

  it('is idempotent on the UNIQUE (subscription, event) pair, even after delivery', async () => {
    const store = new MemoryStore();
    const b = batch(store);
    await store.commit(b);
    await store.markDelivered(b.outbox.map((r) => r.id), FIXED_NOW_ISO);
    await store.commit({ ...b, outbox: [{ ...b.outbox[0]!, id: 'other-id' }] });
    expect(store.outboxRows()).toHaveLength(1);
    expect(await store.takeDue(FIXED_NOW_ISO, 10)).toEqual([]);
  });

  it('takeDue honours time, limit, parked rows and the attempts ceiling', async () => {
    const store = new MemoryStore();
    const events = [makeEvent({ pkg: { packageId: 'A-A' } }), makeEvent({ pkg: { packageId: 'B-B' } }), makeEvent({ pkg: { packageId: 'C-C' } })];
    store.addSubscription(makeSubscription());
    await store.commit({
      source: state.id,
      packages: [],
      events,
      outbox: events.map((e, i) => ({
        id: outboxId('sub-1', e.id),
        subscriptionId: 'sub-1',
        eventId: e.id,
        attempts: 0,
        nextAttemptAt: i === 2 ? '2099-01-01T00:00:00.000Z' : FIXED_NOW_ISO,
      })),
      state,
    });
    expect(await store.takeDue(FIXED_NOW_ISO, 10)).toHaveLength(2);
    expect(await store.takeDue(FIXED_NOW_ISO, 1)).toHaveLength(1);

    await store.markFailedMany([outboxId('sub-1', events[0]!.id)], FIXED_NOW_ISO, true);
    const due = await store.takeDue(FIXED_NOW_ISO, 10);
    expect(due.map((d) => d.event.id)).toEqual([events[1]!.id]);

    const id = outboxId('sub-1', events[1]!.id);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) await store.markFailedMany([id], FIXED_NOW_ISO, false);
    expect(await store.takeDue(FIXED_NOW_ISO, 10)).toEqual([]);
  });

  it('stores changelog on a committed event and exposes it through takeDue', async () => {
    const store = new MemoryStore();
    const b = batch(store);
    await store.commit(b);
    await store.setEventDetails(b.events[0]!.id, { changelog: 'notes', changelogUrl: 'https://x.invalid/c', websiteUrl: null });
    const [due] = await store.takeDue(FIXED_NOW_ISO, 1);
    expect(due!.event).toMatchObject({ changelog: 'notes', changelogUrl: 'https://x.invalid/c' });
  });

  it('touchSource updates etag and last_ok_at only', async () => {
    const store = new MemoryStore();
    await store.commit(batch(store));
    await store.touchSource({ ...state, cursor: 'IGNORED', etag: 'e2', lastOkAt: FIXED_NOW_ISO });
    expect(await store.getSourceState(state.id)).toEqual({ ...state, etag: 'e2', lastOkAt: FIXED_NOW_ISO });
  });

  it('makeSnapshot derives source from store', () => {
    expect(makeSnapshot({ store: 'hexium' }).source).toBe('hexium:valheim');
  });
});
