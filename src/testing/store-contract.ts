// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CLOUDFLARE, OUTBOX_MAX_ATTEMPTS } from '../core/constants.ts';
import { outboxId, releaseKey } from '../core/ids.ts';
import type { CommitBatch, Store } from '../core/ports.ts';
import type { ModEvent, OutboxRow, Subscription } from '../core/types.ts';
import { makeEvent, makeSubscription } from './fakes.ts';

export interface StoreContractEnv {
  store: Store;
  addSubscription(sub: Subscription): Promise<void>;
  setSubscriptionEnabled(id: string, enabled: boolean): Promise<void>;
}

const SOURCE = 'thunderstore:valheim';
const SUB = 'sub-1';
const T0 = '2026-09-19T10:00:00.000Z';
const NOW = '2026-09-19T12:00:00.000Z';
const DAY_MS = 86_400_000;

const state = { id: SOURCE, cursor: 'c', etag: null, bootstrapped: true, lastOkAt: null };

const event = (n: number, over: Parameters<typeof makeEvent>[0] = {}): ModEvent =>
  makeEvent({ pkg: { packageId: `Owner${n}-Mod${n}`, owner: `Owner${n}`, name: `Mod${n}` }, ...over });

const row = (subId: string, e: ModEvent, over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: outboxId(subId, e.id),
  subscriptionId: subId,
  eventId: e.id,
  attempts: 0,
  nextAttemptAt: T0,
  ...over,
});

const batch = (events: ModEvent[], outbox: OutboxRow[], over: Partial<CommitBatch> = {}): CommitBatch => ({
  source: SOURCE,
  packages: events.map((e) => e.pkg),
  events,
  outbox,
  state,
  ...over,
});

/** Behaviour every `Store` implementation must share; run it against each one. */
export function runStoreContract(name: string, create: () => Promise<StoreContractEnv> | StoreContractEnv): void {
  describe(`Store contract: ${name}`, () => {
    async function setup(subs: Subscription[] = [makeSubscription({ id: SUB })]): Promise<StoreContractEnv> {
      const env = await create();
      for (const sub of subs) await env.addSubscription(sub);
      return env;
    }

    describe('commit idempotency', () => {
      it('keeps one event and one outbox row when the same batch is committed twice', async () => {
        const { store } = await setup();
        const e = event(1, { changelog: 'first' });
        await store.commit(batch([e], [row(SUB, e)]));
        await store.commit(batch([{ ...e, changelog: 'second' }], [row(SUB, e)]));
        const due = await store.takeDue(NOW, 10);
        expect(due).toHaveLength(1);
        expect(due[0]!.event.changelog).toBe('first');
      });

      it('ignores a second row for the same (subscription, event) pair even under a different row id', async () => {
        const { store } = await setup();
        const e = event(1);
        await store.commit(batch([e], [row(SUB, e)]));
        await store.commit(batch([e], [row(SUB, e, { id: 'another-id' })]));
        expect(await store.takeDue(NOW, 10)).toHaveLength(1);
      });

      it('keeps attempts and schedule of a failed row when the batch is committed again', async () => {
        const { store } = await setup();
        const e = event(1);
        const r = row(SUB, e);
        await store.commit(batch([e], [r]));
        await store.markFailedMany([r.id], '2026-09-19T11:00:00.000Z', false);
        await store.commit(batch([e], [r]));
        const [due] = await store.takeDue(NOW, 10);
        expect(due!.row).toMatchObject({ attempts: 1, nextAttemptAt: '2026-09-19T11:00:00.000Z' });
      });

      it('never recreates a delivered row when the pair is committed again', async () => {
        const { store } = await setup();
        const e = event(1);
        const r = row(SUB, e);
        await store.commit(batch([e], [r]));
        await store.markDelivered([r.id], NOW);
        expect(await store.takeDue(NOW, 10)).toEqual([]);
        await store.commit(batch([e], [r]));
        await store.commit(batch([e], [row(SUB, e, { id: 'another-id' })]));
        expect(await store.takeDue(NOW, 10)).toEqual([]);
      });

      it('other subscriptions still get their own row for an already delivered event', async () => {
        const other = makeSubscription({ id: 'sub-2', webhookUrl: 'https://discord.invalid/api/webhooks/2/token' });
        const { store } = await setup([makeSubscription({ id: SUB }), other]);
        const e = event(1);
        await store.commit(batch([e], [row(SUB, e)]));
        await store.markDelivered([row(SUB, e).id], NOW);
        await store.commit(batch([e], [row(SUB, e), row('sub-2', e)]));
        expect((await store.takeDue(NOW, 10)).map((d) => d.subscription.id)).toEqual(['sub-2']);
      });
    });

    describe('takeDue', () => {
      it('returns rows oldest first, ties in insertion order', async () => {
        const { store } = await setup();
        const [a, b, c, d] = [event(1), event(2), event(3), event(4)] as [ModEvent, ModEvent, ModEvent, ModEvent];
        await store.commit(
          batch(
            [a, b, c, d],
            [
              row(SUB, a, { nextAttemptAt: '2026-09-19T10:03:00.000Z' }),
              row(SUB, b, { nextAttemptAt: '2026-09-19T10:01:00.000Z' }),
              row(SUB, c, { nextAttemptAt: '2026-09-19T10:01:00.000Z' }),
              row(SUB, d, { nextAttemptAt: '2026-09-19T10:02:00.000Z' }),
            ],
          ),
        );
        expect((await store.takeDue(NOW, 10)).map((x) => x.event.id)).toEqual([b.id, c.id, d.id, a.id]);
      });

      it('honours the limit and the due time', async () => {
        const { store } = await setup();
        const events = [event(1), event(2), event(3)];
        await store.commit(
          batch(events, [
            row(SUB, events[0]!, { nextAttemptAt: '2026-09-19T10:01:00.000Z' }),
            row(SUB, events[1]!, { nextAttemptAt: '2026-09-19T10:02:00.000Z' }),
            row(SUB, events[2]!, { nextAttemptAt: '2026-09-19T10:03:00.000Z' }),
          ]),
        );
        expect(await store.takeDue(NOW, 2)).toHaveLength(2);
        expect((await store.takeDue('2026-09-19T10:02:00.000Z', 10)).map((x) => x.event.id)).toEqual([events[0]!.id, events[1]!.id]);
        expect(await store.takeDue('2026-09-19T10:00:59.000Z', 10)).toEqual([]);
      });

      it('joins the subscription and the event for rendering', async () => {
        const { store } = await setup([makeSubscription({ id: SUB, mode: 'digest', filter: { allowNsfw: true }, digestIntervalMin: 15 })]);
        const e = event(1, { kind: 'update', versionFrom: '0.9.0', changelog: 'notes', changelogUrl: 'https://cl.invalid/x' });
        await store.commit(batch([e], [row(SUB, e)]));
        const [due] = await store.takeDue(NOW, 10);
        expect(due!.subscription).toMatchObject({ id: SUB, mode: 'digest', filter: { allowNsfw: true }, digestIntervalMin: 15, enabled: true });
        expect(due!.event).toMatchObject({
          id: e.id,
          kind: 'update',
          versionFrom: '0.9.0',
          versionTo: e.versionTo,
          changelog: 'notes',
          changelogUrl: 'https://cl.invalid/x',
        });
        expect(due!.event.pkg).toMatchObject({ packageId: e.pkg.packageId, owner: e.pkg.owner, name: e.pkg.name });
      });

      it('skips parked rows and rows at the attempt ceiling', async () => {
        const { store } = await setup();
        const [a, b, c] = [event(1), event(2), event(3)] as [ModEvent, ModEvent, ModEvent];
        await store.commit(batch([a, b, c], [row(SUB, a), row(SUB, b), row(SUB, c)]));
        await store.markFailedMany([row(SUB, a).id], T0, true);
        for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) await store.markFailedMany([row(SUB, b).id], T0, false);
        expect((await store.takeDue(NOW, 10)).map((x) => x.event.id)).toEqual([c.id]);
      });

      it('skips delivered rows', async () => {
        const { store } = await setup();
        const [a, b] = [event(1), event(2)] as [ModEvent, ModEvent];
        await store.commit(batch([a, b], [row(SUB, a), row(SUB, b)]));
        await store.markDelivered([row(SUB, a).id], NOW);
        expect((await store.takeDue(NOW, 10)).map((x) => x.event.id)).toEqual([b.id]);
      });

      it('skips rows of a disabled subscription and returns them once it is enabled again', async () => {
        const env = await setup();
        const e = event(1);
        await env.store.commit(batch([e], [row(SUB, e)]));
        await env.setSubscriptionEnabled(SUB, false);
        expect(await env.store.takeDue(NOW, 10)).toEqual([]);
        await env.setSubscriptionEnabled(SUB, true);
        expect(await env.store.takeDue(NOW, 10)).toHaveLength(1);
      });

      it('exposes a changelog stored after commit', async () => {
        const { store } = await setup();
        const e = event(1);
        await store.commit(batch([e], [row(SUB, e)]));
        await store.setEventChangelog(e.id, 'notes', 'https://cl.invalid/x');
        const [due] = await store.takeDue(NOW, 10);
        expect(due!.event).toMatchObject({ changelog: 'notes', changelogUrl: 'https://cl.invalid/x' });
      });
    });

    describe('markFailedMany', () => {
      it('bumps attempts and reschedules the row', async () => {
        const { store } = await setup();
        const e = event(1);
        const r = row(SUB, e);
        await store.commit(batch([e], [r]));
        await store.markFailedMany([r.id], '2026-09-19T11:00:00.000Z', false);
        await store.markFailedMany([r.id], '2026-09-19T13:00:00.000Z', false);
        expect(await store.takeDue(NOW, 10)).toEqual([]);
        const [due] = await store.takeDue('2026-09-19T13:00:00.000Z', 10);
        expect(due!.row).toMatchObject({ attempts: 2, nextAttemptAt: '2026-09-19T13:00:00.000Z' });
      });

      it('parks a row so it is never due again', async () => {
        const { store } = await setup();
        const e = event(1);
        const r = row(SUB, e);
        await store.commit(batch([e], [r]));
        await store.markFailedMany([r.id], T0, true);
        expect(await store.takeDue('2099-01-01T00:00:00.000Z', 10)).toEqual([]);
      });

      it('never un-parks a parked row', async () => {
        const { store } = await setup();
        const e = event(1);
        const r = row(SUB, e);
        await store.commit(batch([e], [r]));
        await store.markFailedMany([r.id], T0, true);
        await store.markFailedMany([r.id], T0, false);
        expect(await store.takeDue('2099-01-01T00:00:00.000Z', 10)).toEqual([]);
      });

      it('ignores an unknown row id', async () => {
        const { store } = await setup();
        await expect(store.markFailedMany(['missing'], T0, false)).resolves.toBeUndefined();
      });

      it('accepts an empty list', async () => {
        const { store } = await setup();
        await expect(store.markFailedMany([], T0, false)).resolves.toBeUndefined();
      });

      it('bumps every listed row once and leaves the others alone', async () => {
        const { store } = await setup();
        const [a, b, c] = [event(1), event(2), event(3)] as [ModEvent, ModEvent, ModEvent];
        await store.commit(batch([a, b, c], [row(SUB, a), row(SUB, b), row(SUB, c)]));
        await store.markFailedMany([row(SUB, a).id, row(SUB, b).id, 'missing'], '2026-09-19T13:00:00.000Z', false);
        const due = await store.takeDue('2026-09-19T13:00:00.000Z', 10);
        const byEvent = new Map(due.map((d) => [d.event.id, d.row]));
        expect(byEvent.get(a.id)).toMatchObject({ attempts: 1, nextAttemptAt: '2026-09-19T13:00:00.000Z' });
        expect(byEvent.get(b.id)).toMatchObject({ attempts: 1, nextAttemptAt: '2026-09-19T13:00:00.000Z' });
        expect(byEvent.get(c.id)).toMatchObject({ attempts: 0, nextAttemptAt: T0 });
      });

      it('parks every listed row', async () => {
        const { store } = await setup();
        const [a, b] = [event(1), event(2)] as [ModEvent, ModEvent];
        await store.commit(batch([a, b], [row(SUB, a), row(SUB, b)]));
        await store.markFailedMany([row(SUB, a).id, row(SUB, b).id], T0, true);
        expect(await store.takeDue('2099-01-01T00:00:00.000Z', 10)).toEqual([]);
      });

      it('handles more ids than one statement can bind, bumping each row exactly once', async () => {
        const { store } = await setup();
        const n = CLOUDFLARE.d1MaxBoundParams * 2 + 7;
        const events = Array.from({ length: n }, (_, i) => event(i));
        const outbox = events.map((e) => row(SUB, e));
        await store.commit(batch(events, outbox));
        await store.markFailedMany(outbox.map((r) => r.id), '2026-09-19T13:00:00.000Z', false);
        const due = await store.takeDue('2026-09-19T13:00:00.000Z', n);
        expect(due).toHaveLength(n);
        expect(due.every((d) => d.row.attempts === 1)).toBe(true);
      });
    });

    describe('rescheduleRows', () => {
      it('accepts an empty list and unknown ids', async () => {
        const { store } = await setup();
        await expect(store.rescheduleRows([], NOW)).resolves.toBeUndefined();
        await expect(store.rescheduleRows(['missing'], NOW)).resolves.toBeUndefined();
      });

      it('moves the listed rows without bumping attempts', async () => {
        const { store } = await setup();
        const [a, b] = [event(1), event(2)] as [ModEvent, ModEvent];
        await store.commit(batch([a, b], [row(SUB, a), row(SUB, b)]));
        await store.markFailedMany([row(SUB, a).id], T0, false);
        await store.rescheduleRows([row(SUB, a).id], '2026-09-19T13:00:00.000Z');
        expect((await store.takeDue(NOW, 10)).map((d) => d.event.id)).toEqual([b.id]);
        const due = await store.takeDue('2026-09-19T13:00:00.000Z', 10);
        expect(due.find((d) => d.event.id === a.id)!.row).toMatchObject({ attempts: 1, nextAttemptAt: '2026-09-19T13:00:00.000Z' });
      });

      it('leaves delivered and parked rows as they are', async () => {
        const { store } = await setup();
        const [a, b] = [event(1), event(2)] as [ModEvent, ModEvent];
        await store.commit(batch([a, b], [row(SUB, a), row(SUB, b)]));
        await store.markDelivered([row(SUB, a).id], NOW);
        await store.markFailedMany([row(SUB, b).id], T0, true);
        await store.rescheduleRows([row(SUB, a).id, row(SUB, b).id], '2026-09-19T13:00:00.000Z');
        expect(await store.takeDue('2099-01-01T00:00:00.000Z', 10)).toEqual([]);
      });

      it('handles more ids than one statement can bind', async () => {
        const { store } = await setup();
        const n = CLOUDFLARE.d1MaxBoundParams * 2 + 7;
        const events = Array.from({ length: n }, (_, i) => event(i));
        const outbox = events.map((e) => row(SUB, e));
        await store.commit(batch(events, outbox));
        await store.rescheduleRows(outbox.map((r) => r.id), '2026-09-19T13:00:00.000Z');
        expect(await store.takeDue(NOW, n)).toEqual([]);
        const due = await store.takeDue('2026-09-19T13:00:00.000Z', n);
        expect(due).toHaveLength(n);
        expect(due.every((d) => d.row.attempts === 0)).toBe(true);
      });
    });

    describe('existingEventIds', () => {
      it('returns the requested ids that exist and ignores the rest', async () => {
        const { store } = await setup();
        const [a, b, c] = [event(1), event(2), event(3)] as [ModEvent, ModEvent, ModEvent];
        await store.commit(batch([a, b], []));
        expect(await store.existingEventIds([a.id, b.id, c.id, 'missing'])).toEqual(new Set([a.id, b.id]));
      });

      it('returns an empty set for no ids', async () => {
        const { store } = await setup();
        expect((await store.existingEventIds([])).size).toBe(0);
      });

      it('still knows an event after its outbox rows were purged', async () => {
        const { store } = await setup();
        const a = event(1);
        await store.commit(batch([a], [row(SUB, a)]));
        await store.markDelivered([row(SUB, a).id], '2026-09-01T00:00:00.000Z');
        expect(await store.purgeDelivered('2026-09-10T00:00:00.000Z', 100)).toBe(1);
        expect(await store.existingEventIds([a.id])).toEqual(new Set([a.id]));
      });

      it('answers more ids than one statement can bind, duplicates included', async () => {
        const { store } = await setup();
        const n = CLOUDFLARE.d1MaxBoundParams * 2 + 5;
        const events = Array.from({ length: n }, (_, i) => event(i));
        await store.commit(batch(events, []));
        const ids = events.map((e) => e.id);
        const found = await store.existingEventIds([...ids, ids[0]!, 'missing']);
        expect(found.size).toBe(n);
        expect(found.has(ids[n - 1]!)).toBe(true);
      });
    });

    describe('markDelivered', () => {
      it('accepts an empty list and unknown ids', async () => {
        const { store } = await setup();
        await expect(store.markDelivered([], NOW)).resolves.toBeUndefined();
        await expect(store.markDelivered(['missing'], NOW)).resolves.toBeUndefined();
      });

      it('handles more ids than one statement can bind', async () => {
        const { store } = await setup();
        const n = CLOUDFLARE.d1MaxBoundParams * 2 + 7;
        const events = Array.from({ length: n }, (_, i) => event(i));
        const outbox = events.map((e) => row(SUB, e));
        await store.commit(batch(events, outbox));
        await store.markDelivered(outbox.map((r) => r.id), NOW);
        expect(await store.takeDue(NOW, n)).toEqual([]);
      });
    });

    describe('recentEventsByReleaseKeys', () => {
      const other = (n: number, store: 'hexium' | 'thunderstore', over: Parameters<typeof makeEvent>[0] = {}): ModEvent =>
        makeEvent({
          pkg: { store, source: `${store}:valheim`, packageId: `Owner${n}-Mod${n}`, owner: `Owner${n}`, name: `Mod${n}`, version: '1.0.0' },
          ...over,
        });

      it('groups events by release key across stores', async () => {
        const { store } = await setup();
        const ts = other(1, 'thunderstore', { createdAt: '2026-09-19T10:00:00.000Z' });
        const hx = other(1, 'hexium', { createdAt: '2026-09-19T10:05:00.000Z' });
        const unrelated = other(2, 'thunderstore', { createdAt: '2026-09-19T10:06:00.000Z' });
        await store.commit(batch([ts, unrelated], []));
        await store.commit({ ...batch([hx], []), source: 'hexium:valheim', state: { ...state, id: 'hexium:valheim' } });

        const key1 = releaseKey(ts.pkg, ts.versionTo);
        const key2 = releaseKey(unrelated.pkg, unrelated.versionTo);
        const found = await store.recentEventsByReleaseKeys([key1, key2, 'nope|nope|1'], '2026-09-19T00:00:00.000Z');
        expect(found.get(key1)!.map((e) => e.pkg.store)).toEqual(['thunderstore', 'hexium']);
        expect(found.get(key2)!.map((e) => e.id)).toEqual([unrelated.id]);
        expect(found.has('nope|nope|1')).toBe(false);
      });

      it('leaves out events created before the window', async () => {
        const { store } = await setup();
        const old = other(1, 'thunderstore', { createdAt: '2026-09-17T10:00:00.000Z' });
        const fresh = other(2, 'thunderstore', { createdAt: '2026-09-19T10:00:00.000Z' });
        await store.commit(batch([old, fresh], []));
        const keys = [releaseKey(old.pkg, old.versionTo), releaseKey(fresh.pkg, fresh.versionTo)];
        const found = await store.recentEventsByReleaseKeys(keys, '2026-09-18T00:00:00.000Z');
        expect([...found.keys()]).toEqual([keys[1]]);
      });

      it('returns an empty map for no keys', async () => {
        const { store } = await setup();
        expect((await store.recentEventsByReleaseKeys([], T0)).size).toBe(0);
      });

      it('answers more keys than one statement can bind', async () => {
        const { store } = await setup();
        const n = CLOUDFLARE.d1MaxBoundParams * 2 + 5;
        const events = Array.from({ length: n }, (_, i) => other(i, 'thunderstore', { createdAt: '2026-09-19T10:00:00.000Z' }));
        await store.commit(batch(events, []));
        const keys = events.map((e) => releaseKey(e.pkg, e.versionTo));
        const found = await store.recentEventsByReleaseKeys([...keys, keys[0]!], '2026-09-19T00:00:00.000Z');
        expect(found.size).toBe(n);
        expect(found.get(keys[n - 1]!)!.map((e) => e.id)).toEqual([events[n - 1]!.id]);
      });
    });

    describe('purgeDelivered', () => {
      it('removes only delivered rows older than the cutoff and reports how many', async () => {
        const { store } = await setup();
        const events = [event(1), event(2), event(3), event(4)];
        const [old, recent, pending, failed] = events as [ModEvent, ModEvent, ModEvent, ModEvent];
        await store.commit(batch(events, events.map((e) => row(SUB, e))));
        await store.markDelivered([row(SUB, old).id], new Date(Date.parse(NOW) - 10 * DAY_MS).toISOString());
        await store.markDelivered([row(SUB, recent).id], new Date(Date.parse(NOW) - DAY_MS).toISOString());
        await store.markFailedMany([row(SUB, failed).id], T0, true);

        const cutoff = new Date(Date.parse(NOW) - 7 * DAY_MS).toISOString();
        expect(await store.purgeDelivered(cutoff, 100)).toBe(1);
        expect(await store.purgeDelivered(cutoff, 100)).toBe(0);
        expect((await store.takeDue(NOW, 10)).map((d) => d.event.id)).toEqual([pending.id]);
      });

      it('lets a purged pair be recreated (retention has expired) but keeps guarding the retained ones', async () => {
        const { store } = await setup();
        const [old, recent] = [event(1), event(2)] as [ModEvent, ModEvent];
        await store.commit(batch([old, recent], [row(SUB, old), row(SUB, recent)]));
        await store.markDelivered([row(SUB, old).id], '2026-09-01T00:00:00.000Z');
        await store.markDelivered([row(SUB, recent).id], NOW);
        await store.purgeDelivered('2026-09-10T00:00:00.000Z', 100);
        await store.commit(batch([old, recent], [row(SUB, old), row(SUB, recent)]));
        expect((await store.takeDue(NOW, 10)).map((d) => d.event.id)).toEqual([old.id]);
      });

      it('deletes at most `limit` rows per call', async () => {
        const { store } = await setup();
        const events = Array.from({ length: 5 }, (_, i) => event(i));
        const outbox = events.map((e) => row(SUB, e));
        await store.commit(batch(events, outbox));
        await store.markDelivered(outbox.map((r) => r.id), '2026-09-01T00:00:00.000Z');
        expect(await store.purgeDelivered('2026-09-10T00:00:00.000Z', 2)).toBe(2);
        expect(await store.purgeDelivered('2026-09-10T00:00:00.000Z', 2)).toBe(2);
        expect(await store.purgeDelivered('2026-09-10T00:00:00.000Z', 2)).toBe(1);
      });
    });

    describe('listSubscriptions', () => {
      it('returns enabled subscriptions only', async () => {
        const env = await setup([makeSubscription({ id: 'a' }), makeSubscription({ id: 'b', webhookUrl: 'https://discord.invalid/api/webhooks/2/t' })]);
        await env.setSubscriptionEnabled('b', false);
        expect((await env.store.listSubscriptions()).map((s) => s.id)).toEqual(['a']);
      });
    });
  });
}
