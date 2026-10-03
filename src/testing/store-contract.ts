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
        const { store } = await setup([makeSubscription({ id: SUB, mode: 'digest', filter: { allowNsfw: true }, digestIntervalMin: 15, threadId: '222233334444555566' })]);
        const e = event(1, { kind: 'update', versionFrom: '0.9.0', changelog: 'notes', changelogUrl: 'https://cl.invalid/x' });
        await store.commit(batch([e], [row(SUB, e)]));
        const [due] = await store.takeDue(NOW, 10);
        expect(due!.subscription).toMatchObject({ id: SUB, mode: 'digest', filter: { allowNsfw: true }, digestIntervalMin: 15, enabled: true, threadId: '222233334444555566' });
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
        await store.setEventDetails(e.id, { changelog: 'notes', changelogUrl: 'https://cl.invalid/x', websiteUrl: null });
        const [due] = await store.takeDue(NOW, 10);
        expect(due!.event).toMatchObject({ changelog: 'notes', changelogUrl: 'https://cl.invalid/x' });
      });
    });

    describe('package download url', () => {
      const DL1 = 'https://cdn.example/download/a-1.0.0.zip';
      const DL2 = 'https://cdn.example/download/a-2.0.0.zip';
      const release = (version: string, downloadUrl: string | null | undefined): ModEvent =>
        makeEvent({ versionTo: version, pkg: { packageId: 'Owner-Mod', owner: 'Owner', name: 'Mod', ...(downloadUrl === undefined ? {} : { downloadUrl }) } });

      it('stores the download url with the package and returns it with the due event', async () => {
        const { store } = await setup();
        const e = release('1.0.0', DL1);
        await store.commit(batch([e], [row(SUB, e)]));
        const [due] = await store.takeDue(NOW, 10);
        expect(due!.event.pkg.downloadUrl).toBe(DL1);
      });

      it('reads a package without a download url as null', async () => {
        const { store } = await setup();
        const [a, b] = [release('1.0.0', undefined), release('1.0.1', null)] as [ModEvent, ModEvent];
        await store.commit(batch([a, b], [row(SUB, a), row(SUB, b)]));
        expect((await store.takeDue(NOW, 10)).map((d) => d.event.pkg.downloadUrl)).toEqual([null, null]);
      });

      it('keeps the stored url for the same version when a later snapshot has none', async () => {
        const { store } = await setup();
        const first = release('1.0.0', DL1);
        await store.commit(batch([first], [row(SUB, first)]));
        const again = release('1.0.0', null);
        await store.commit(batch([again], []));
        expect((await store.takeDue(NOW, 10)).map((d) => d.event.pkg.downloadUrl)).toEqual([DL1]);
      });

      it('never keeps the url of an older version: a new version without a url has none', async () => {
        const { store } = await setup();
        const first = release('1.0.0', DL1);
        await store.commit(batch([first], [row(SUB, first)]));
        const second = release('1.1.0', null);
        await store.commit(batch([second], [row(SUB, second)]));
        expect((await store.takeDue(NOW, 10)).map((d) => d.event.pkg.downloadUrl)).toEqual([null, null]);
        const third = release('2.0.0', DL2);
        await store.commit(batch([third], [row(SUB, third)]));
        expect((await store.takeDue(NOW, 10)).map((d) => d.event.pkg.downloadUrl)).toEqual([DL2, DL2, DL2]);
      });

      it('returns the url with events found by release key', async () => {
        const { store } = await setup();
        const e = release('1.0.0', DL1);
        await store.commit(batch([e], []));
        const found = await store.recentEventsByReleaseKeys([releaseKey(e.pkg, e.versionTo)], T0);
        expect([...found.values()].flat().map((x) => x.pkg.downloadUrl)).toEqual([DL1]);
      });
    });

    describe('package downloads', () => {
      const release = (version: string, downloads: number | null | undefined): ModEvent =>
        makeEvent({ versionTo: version, pkg: { packageId: 'Owner-Mod', owner: 'Owner', name: 'Mod', ...(downloads === undefined ? {} : { downloads }) } });
      const counts = async (store: Store): Promise<(number | null | undefined)[]> => (await store.takeDue(NOW, 10)).map((d) => d.event.pkg.downloads);

      it('stores the download count with the package, zero included, and returns it with the due event', async () => {
        const { store } = await setup();
        const zero = release('1.0.0', 0);
        await store.commit(batch([zero], [row(SUB, zero)]));
        expect(await counts(store)).toEqual([0]);
      });

      it('reads a package without a count as null', async () => {
        const { store } = await setup();
        const [a, b] = [release('1.0.0', undefined), release('1.0.1', null)] as [ModEvent, ModEvent];
        await store.commit(batch([a, b], [row(SUB, a), row(SUB, b)]));
        expect(await counts(store)).toEqual([null, null]);
      });

      it('lets the latest non-null count win and keeps the stored one when a snapshot has none', async () => {
        const { store } = await setup();
        const first = release('1.0.0', 100);
        await store.commit(batch([first], [row(SUB, first)]));
        const second = release('1.1.0', null);
        await store.commit(batch([second], [row(SUB, second)]));
        expect(await counts(store)).toEqual([100, 100]);
        const third = release('2.0.0', 250);
        await store.commit(batch([third], [row(SUB, third)]));
        expect(await counts(store)).toEqual([250, 250, 250]);
        const lower = release('2.0.1', 40);
        await store.commit(batch([lower], [row(SUB, lower)]));
        expect((await counts(store)).at(-1)).toBe(40);
      });

      it('returns the count with events found by release key', async () => {
        const { store } = await setup();
        const e = release('1.0.0', 77);
        await store.commit(batch([e], []));
        const found = await store.recentEventsByReleaseKeys([releaseKey(e.pkg, e.versionTo)], T0);
        expect([...found.values()].flat().map((x) => x.pkg.downloads)).toEqual([77]);
      });
    });

    describe('package likes', () => {
      const release = (version: string, likes: number | null | undefined): ModEvent =>
        makeEvent({ versionTo: version, pkg: { packageId: 'Owner-Mod', owner: 'Owner', name: 'Mod', ...(likes === undefined ? {} : { likes }) } });
      const counts = async (store: Store): Promise<(number | null | undefined)[]> => (await store.takeDue(NOW, 10)).map((d) => d.event.pkg.likes);

      it('stores the like count with the package, zero included, and returns it with the due event', async () => {
        const { store } = await setup();
        const zero = release('1.0.0', 0);
        await store.commit(batch([zero], [row(SUB, zero)]));
        expect(await counts(store)).toEqual([0]);
      });

      it('reads a package without a like count as null', async () => {
        const { store } = await setup();
        const [a, b] = [release('1.0.0', undefined), release('1.0.1', null)] as [ModEvent, ModEvent];
        await store.commit(batch([a, b], [row(SUB, a), row(SUB, b)]));
        expect(await counts(store)).toEqual([null, null]);
      });

      it('lets the latest non-null count win and keeps the stored one when a snapshot has none', async () => {
        const { store } = await setup();
        const first = release('1.0.0', 100);
        await store.commit(batch([first], [row(SUB, first)]));
        const second = release('1.1.0', null);
        await store.commit(batch([second], [row(SUB, second)]));
        expect(await counts(store)).toEqual([100, 100]);
        const lower = release('2.0.0', 40);
        await store.commit(batch([lower], [row(SUB, lower)]));
        expect((await counts(store)).at(-1)).toBe(40);
      });

      it('returns the count with events found by release key', async () => {
        const { store } = await setup();
        const e = release('1.0.0', 77);
        await store.commit(batch([e], []));
        const found = await store.recentEventsByReleaseKeys([releaseKey(e.pkg, e.versionTo)], T0);
        expect([...found.values()].flat().map((x) => x.pkg.likes)).toEqual([77]);
      });
    });

    describe('package website', () => {
      const SITE1 = 'https://github.com/owner/mod';
      const SITE2 = 'https://discord.gg/abc';
      const release = (version: string, websiteUrl: string | null | undefined): ModEvent =>
        makeEvent({ versionTo: version, pkg: { packageId: 'Owner-Mod', owner: 'Owner', name: 'Mod', ...(websiteUrl === undefined ? {} : { websiteUrl }) } });
      const sites = async (store: Store): Promise<(string | null | undefined)[]> => (await store.takeDue(NOW, 10)).map((d) => d.event.pkg.websiteUrl);

      it('stores the website with the package and returns it with the due event', async () => {
        const { store } = await setup();
        const e = release('1.0.0', SITE1);
        await store.commit(batch([e], [row(SUB, e)]));
        expect(await sites(store)).toEqual([SITE1]);
      });

      it('reads a package without a website as null', async () => {
        const { store } = await setup();
        const [a, b] = [release('1.0.0', undefined), release('1.0.1', null)] as [ModEvent, ModEvent];
        await store.commit(batch([a, b], [row(SUB, a), row(SUB, b)]));
        expect(await sites(store)).toEqual([null, null]);
      });

      it('lets the latest non-null website win across versions and keeps it when a snapshot has none', async () => {
        const { store } = await setup();
        const first = release('1.0.0', SITE1);
        await store.commit(batch([first], [row(SUB, first)]));
        const second = release('1.1.0', null);
        await store.commit(batch([second], [row(SUB, second)]));
        expect(await sites(store)).toEqual([SITE1, SITE1]);
        const third = release('2.0.0', SITE2);
        await store.commit(batch([third], [row(SUB, third)]));
        expect(await sites(store)).toEqual([SITE2, SITE2, SITE2]);
      });

      it('returns the website with events found by release key', async () => {
        const { store } = await setup();
        const e = release('1.0.0', SITE1);
        await store.commit(batch([e], []));
        const found = await store.recentEventsByReleaseKeys([releaseKey(e.pkg, e.versionTo)], T0);
        expect([...found.values()].flat().map((x) => x.pkg.websiteUrl)).toEqual([SITE1]);
      });
    });

    describe('setEventDetails', () => {
      it('updates the event and the package website, which every event of the package then shows', async () => {
        const { store } = await setup();
        const [a, b] = [event(1, { versionTo: '1.0.0' }), event(1, { versionTo: '1.1.0' })] as [ModEvent, ModEvent];
        await store.commit(batch([a, b], [row(SUB, a), row(SUB, b)]));
        await store.setEventDetails(b.id, { changelog: 'notes', changelogUrl: 'https://cl.invalid/x', websiteUrl: 'https://site.invalid/m' });
        const due = await store.takeDue(NOW, 10);
        const byId = new Map(due.map((d) => [d.event.id, d.event]));
        expect(byId.get(b.id)).toMatchObject({ changelog: 'notes', changelogUrl: 'https://cl.invalid/x' });
        expect(byId.get(a.id)).toMatchObject({ changelog: null, changelogUrl: null });
        expect([...byId.values()].map((e) => e.pkg.websiteUrl)).toEqual(['https://site.invalid/m', 'https://site.invalid/m']);
      });

      it('leaves the package website alone when the details carry none', async () => {
        const { store } = await setup();
        const e = event(1, { pkg: { packageId: 'Owner1-Mod1', owner: 'Owner1', name: 'Mod1', websiteUrl: 'https://kept.invalid/' } });
        await store.commit(batch([e], [row(SUB, e)]));
        await store.setEventDetails(e.id, { changelog: 'notes', changelogUrl: null, websiteUrl: null });
        const [due] = await store.takeDue(NOW, 10);
        expect(due!.event.pkg.websiteUrl).toBe('https://kept.invalid/');
        expect(due!.event.changelog).toBe('notes');
      });

      it('replaces a stored website with a new one', async () => {
        const { store } = await setup();
        const e = event(1, { pkg: { packageId: 'Owner1-Mod1', owner: 'Owner1', name: 'Mod1', websiteUrl: 'https://old.invalid/' } });
        await store.commit(batch([e], [row(SUB, e)]));
        await store.setEventDetails(e.id, { changelog: null, changelogUrl: null, websiteUrl: 'https://new.invalid/' });
        expect((await store.takeDue(NOW, 10))[0]!.event.pkg.websiteUrl).toBe('https://new.invalid/');
      });

      it('touches no other package and ignores an unknown event id', async () => {
        const { store } = await setup();
        const [a, b] = [event(1), event(2)] as [ModEvent, ModEvent];
        await store.commit(batch([a, b], [row(SUB, a), row(SUB, b)]));
        await store.setEventDetails('no-such-event', { changelog: 'x', changelogUrl: null, websiteUrl: 'https://x.invalid/' });
        await store.setEventDetails(a.id, { changelog: null, changelogUrl: null, websiteUrl: 'https://a.invalid/' });
        const sitesById = new Map((await store.takeDue(NOW, 10)).map((d) => [d.event.id, d.event.pkg.websiteUrl]));
        expect(sitesById.get(a.id)).toBe('https://a.invalid/');
        expect(sitesById.get(b.id)).toBeNull();
      });

      it('shows the stored website in events found by release key', async () => {
        const { store } = await setup();
        const e = event(1);
        await store.commit(batch([e], []));
        await store.setEventDetails(e.id, { changelog: null, changelogUrl: null, websiteUrl: 'https://found.invalid/' });
        const found = await store.recentEventsByReleaseKeys([releaseKey(e.pkg, e.versionTo)], T0);
        expect([...found.values()].flat().map((x) => x.pkg.websiteUrl)).toEqual(['https://found.invalid/']);
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

    describe('alert state', () => {
      const T1 = '2026-10-04T10:00:00.000Z';
      const T2 = '2026-10-05T10:00:00.000Z';

      it('returns an empty map for no keys and for keys never set', async () => {
        const { store } = await setup();
        expect((await store.getAlertStates([])).size).toBe(0);
        expect((await store.getAlertStates(['hexium:valheim:index-lines'])).size).toBe(0);
      });

      it('round-trips level and time and returns only the keys that exist', async () => {
        const { store } = await setup();
        await store.setAlertState('a:one', { level: 2, notifiedAt: T1 });
        await store.setAlertState('a:two', { level: 4, notifiedAt: T2 });
        const found = await store.getAlertStates(['a:one', 'a:two', 'a:missing']);
        expect([...found.keys()].sort()).toEqual(['a:one', 'a:two']);
        expect(found.get('a:one')).toEqual({ level: 2, notifiedAt: T1 });
        expect(found.get('a:two')).toEqual({ level: 4, notifiedAt: T2 });
      });

      it('replaces the stored state when set again', async () => {
        const { store } = await setup();
        await store.setAlertState('a:one', { level: 3, notifiedAt: T1 });
        await store.setAlertState('a:one', { level: 0, notifiedAt: T2 });
        expect((await store.getAlertStates(['a:one'])).get('a:one')).toEqual({ level: 0, notifiedAt: T2 });
      });

      it('answers for more keys than one query can bind', async () => {
        const { store } = await setup();
        await store.setAlertState('k-7', { level: 1, notifiedAt: T1 });
        await store.setAlertState('k-150', { level: 2, notifiedAt: T2 });
        const keys = Array.from({ length: 200 }, (_, i) => `k-${i}`);
        const found = await store.getAlertStates(keys);
        expect([...found.keys()].sort()).toEqual(['k-150', 'k-7']);
      });
    });
  });
}
