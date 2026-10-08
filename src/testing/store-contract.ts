// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AUTOCOMPLETE_MAX_RESULTS, AUTOCOMPLETE_MIN_PREFIX, AUTOCOMPLETE_OWNER_SCAN_LIMIT, CLOUDFLARE, OUTBOX_MAX_ATTEMPTS, TEMPLATE_MAX_CHARS } from '../core/constants.ts';
import { eventId, outboxId, releaseKey } from '../core/ids.ts';
import type { CommitBatch, Store } from '../core/ports.ts';
import type { ModEvent, ModThread, OutboxRow, PackageSnapshot, Subscription, SubscriptionTemplate } from '../core/types.ts';
import { makeEvent, makeSnapshot, makeSubscription } from './fakes.ts';

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

    describe('subscription writes', () => {
      const botSub = (over: Partial<Subscription> = {}): Subscription => ({
        id: 'bot-1',
        guildId: 'guild-1',
        transport: 'bot',
        channelId: 'chan-1',
        label: 'Valheim news',
        createdBy: 'user-1',
        threadPerMod: true,
        channelKind: 'forum',
        pausedUntil: 0,
        filter: { kinds: ['new'] },
        mode: 'immediate',
        digestIntervalMin: 30,
        enabled: true,
        ...over,
      });

      it('creates a bot subscription without a webhook and reads every field back', async () => {
        const { store } = await setup([]);
        await store.createSubscription(botSub({ threadId: 'thread-9', pausedUntil: 1_800_000_000 }));
        expect(await store.listSubscriptionsByChannel('chan-1')).toEqual([
          { ...botSub({ threadId: 'thread-9', pausedUntil: 1_800_000_000 }), webhookUrl: null },
        ]);
      });

      it('creates a webhook subscription with the defaults of an existing one', async () => {
        const { store } = await setup([]);
        await store.createSubscription(makeSubscription({ id: 'hook' }));
        expect(await store.listSubscriptions()).toEqual([
          {
            ...makeSubscription({ id: 'hook' }),
            transport: 'webhook',
            channelId: null,
            threadId: null,
            label: null,
            createdBy: null,
            threadPerMod: false,
            channelKind: 'text',
            pausedUntil: 0,
          },
        ]);
      });

      it('rejects a second subscription with the same id and keeps the first', async () => {
        const { store } = await setup([]);
        await store.createSubscription(botSub());
        await expect(store.createSubscription(botSub({ label: 'other' }))).rejects.toThrow();
        expect((await store.listSubscriptionsByChannel('chan-1'))[0]!.label).toBe('Valheim news');
      });

      it('updates only the fields present in the patch', async () => {
        const { store } = await setup([]);
        await store.createSubscription(botSub());
        expect(
          await store.updateSubscription('bot-1', {
            label: 'Renamed',
            mode: 'digest',
            digestIntervalMin: 60,
            filter: { kinds: ['update'] },
            threadPerMod: false,
            pausedUntil: Number.MAX_SAFE_INTEGER,
            threadId: 'thread-2',
          }),
        ).toBe(true);
        expect((await store.listSubscriptionsByChannel('chan-1'))[0]).toMatchObject({
          label: 'Renamed',
          mode: 'digest',
          digestIntervalMin: 60,
          filter: { kinds: ['update'] },
          threadPerMod: false,
          pausedUntil: Number.MAX_SAFE_INTEGER,
          threadId: 'thread-2',
          channelId: 'chan-1',
          createdBy: 'user-1',
          enabled: true,
        });
      });

      it('clears a nullable field when the patch sets it to null and leaves it alone when undefined', async () => {
        const { store } = await setup([]);
        await store.createSubscription(botSub({ threadId: 'thread-9' }));
        await store.updateSubscription('bot-1', { label: undefined, threadId: null });
        expect((await store.listSubscriptionsByChannel('chan-1'))[0]).toMatchObject({ label: 'Valheim news', threadId: null });
      });

      it('disabling through an update hides the subscription from listSubscriptions but not from the channel list', async () => {
        const { store } = await setup([]);
        await store.createSubscription(botSub());
        await store.updateSubscription('bot-1', { enabled: false });
        expect(await store.listSubscriptions()).toEqual([]);
        expect((await store.listSubscriptionsByChannel('chan-1'))[0]!.enabled).toBe(false);
      });

      it('reports whether the subscription existed, also for an empty patch', async () => {
        const { store } = await setup([]);
        await store.createSubscription(botSub());
        expect(await store.updateSubscription('missing', { label: 'x' })).toBe(false);
        expect(await store.updateSubscription('missing', {})).toBe(false);
        expect(await store.updateSubscription('bot-1', {})).toBe(true);
      });

      it('lists a paused subscription like any other enabled one', async () => {
        const { store } = await setup([]);
        await store.createSubscription(botSub({ pausedUntil: Number.MAX_SAFE_INTEGER }));
        expect((await store.listSubscriptions()).map((s) => s.id)).toEqual(['bot-1']);
      });

      it('deletes the subscription and its undelivered outbox rows, keeping delivered rows and other subscriptions', async () => {
        const { store } = await setup([makeSubscription({ id: 'other' })]);
        await store.createSubscription(botSub());
        const [e1, e2, e3] = [event(1), event(2), event(3)];
        await store.commit(batch([e1, e2, e3], [row('bot-1', e1), row('bot-1', e2), row('other', e1), row('other', e3)]));
        await store.markDelivered([row('bot-1', e2).id], NOW);

        expect(await store.deleteSubscription('bot-1')).toBe(true);

        expect(await store.listSubscriptionsByChannel('chan-1')).toEqual([]);
        expect((await store.takeDue(NOW, 10)).map((d) => d.row.subscriptionId)).toEqual(['other', 'other']);
        await store.commit(batch([e1, e2], [row('bot-1', e1), row('bot-1', e2)]));
        expect((await store.takeDue(NOW, 10)).map((d) => d.row.subscriptionId)).toEqual(['other', 'other']);
      });

      it('clears the undelivered rows of the given subscriptions only, keeping the subscriptions, delivered rows and the others', async () => {
        const { store } = await setup([makeSubscription({ id: 'other' })]);
        await store.createSubscription(botSub());
        const [e1, e2, e3] = [event(1), event(2), event(3)];
        await store.commit(batch([e1, e2, e3], [row('bot-1', e1), row('bot-1', e2), row('other', e1), row('other', e3)]));
        await store.markDelivered([row('bot-1', e2).id], NOW);

        await store.clearUndelivered(['bot-1', 'missing']);

        expect((await store.listSubscriptionsByChannel('chan-1')).map((s) => s.id)).toEqual(['bot-1']);
        expect((await store.takeDue(NOW, 10)).map((d) => d.row.subscriptionId)).toEqual(['other', 'other']);
        await store.commit(batch([e1, e2], [row('bot-1', e1), row('bot-1', e2)]));
        expect((await store.takeDue(NOW, 10)).map((d) => `${d.row.subscriptionId}:${d.row.eventId}`).sort()).toEqual(
          [`bot-1:${e1.id}`, `other:${e1.id}`, `other:${e3.id}`].sort(),
        );
      });

      it('sets pausedUntil of the given subscriptions only, ignoring unknown ids', async () => {
        const { store } = await setup([]);
        await store.createSubscription(botSub({ id: 'a' }));
        await store.createSubscription(botSub({ id: 'b' }));
        await store.setPausedUntil(['a', 'missing'], 1_800_000_000);
        await store.setPausedUntil([], 5);
        const until = async (): Promise<number[]> => (await store.listSubscriptionsByChannel('chan-1')).sort((x, y) => x.id.localeCompare(y.id)).map((s) => s.pausedUntil ?? 0);
        expect(await until()).toEqual([1_800_000_000, 0]);
        await store.setPausedUntil(['a'], 0);
        expect(await until()).toEqual([0, 0]);
      });

      it('holds the rows of a paused subscription back from takeDue and returns them once the pause has expired', async () => {
        const nowSeconds = Date.parse(NOW) / 1000;
        const { store } = await setup([makeSubscription({ id: 'p', pausedUntil: nowSeconds + 60 }), makeSubscription({ id: 'q', webhookUrl: 'https://discord.invalid/api/webhooks/2/token' })]);
        const e = event(1);
        await store.commit(batch([e], [row('p', e), row('q', e)]));
        expect((await store.takeDue(NOW, 10)).map((d) => d.row.subscriptionId)).toEqual(['q']);
        expect((await store.takeDue(new Date((nowSeconds + 59) * 1000).toISOString(), 10)).map((d) => d.row.subscriptionId)).toEqual(['q']);
        expect((await store.takeDue(new Date((nowSeconds + 60) * 1000).toISOString(), 10)).map((d) => d.row.subscriptionId).sort()).toEqual(['p', 'q']);
      });

      it('clears nothing for an empty list', async () => {
        const { store } = await setup([makeSubscription({ id: 'other' })]);
        const e = event(1);
        await store.commit(batch([e], [row('other', e)]));
        await store.clearUndelivered([]);
        expect(await store.takeDue(NOW, 10)).toHaveLength(1);
      });

      it('reports false and changes nothing when the subscription does not exist', async () => {
        const { store } = await setup([makeSubscription({ id: 'other' })]);
        const e = event(1);
        await store.commit(batch([e], [row('other', e)]));
        expect(await store.deleteSubscription('missing')).toBe(false);
        expect(await store.takeDue(NOW, 10)).toHaveLength(1);
      });

      it('lists by channel every subscription of that channel, disabled and paused ones included, and no other', async () => {
        const { store } = await setup([makeSubscription({ id: 'hook' })]);
        await store.createSubscription(botSub({ id: 'a' }));
        await store.createSubscription(botSub({ id: 'b', enabled: false }));
        await store.createSubscription(botSub({ id: 'c', pausedUntil: Number.MAX_SAFE_INTEGER }));
        await store.createSubscription(botSub({ id: 'd', channelId: 'chan-2' }));
        const ids = async (channelId: string): Promise<string[]> => (await store.listSubscriptionsByChannel(channelId)).map((s) => s.id).sort();
        expect(await ids('chan-1')).toEqual(['a', 'b', 'c']);
        expect(await ids('chan-2')).toEqual(['d']);
        expect(await ids('chan-none')).toEqual([]);
      });

      it('lists by guild the webhook and bot subscriptions of that guild, disabled ones included', async () => {
        const { store } = await setup([makeSubscription({ id: 'hook', guildId: 'guild-1' }), makeSubscription({ id: 'elsewhere', guildId: 'guild-2' })]);
        await store.createSubscription(botSub({ id: 'a' }));
        await store.createSubscription(botSub({ id: 'b', enabled: false }));
        await store.createSubscription(botSub({ id: 'c', guildId: 'guild-2' }));
        const ids = async (guildId: string): Promise<string[]> => (await store.listSubscriptionsByGuild(guildId)).map((s) => s.id).sort();
        expect(await ids('guild-1')).toEqual(['a', 'b', 'hook']);
        expect(await ids('guild-2')).toEqual(['c', 'elsewhere']);
        expect(await ids('guild-3')).toEqual([]);
      });
    });

    describe('countSubscriptions', () => {
      const botSub = (over: Partial<Subscription>): Subscription => ({ transport: 'bot', channelId: 'chan-1', guildId: 'guild-1', filter: {}, mode: 'immediate', digestIntervalMin: 30, enabled: true, ...over }) as Subscription;
      it('counts every subscription of every transport, disabled and paused ones included', async () => {
        const { store } = await setup([makeSubscription({ id: 'hook' })]);
        expect(await store.countSubscriptions()).toBe(1);
        await store.createSubscription(botSub({ id: 'a' }));
        await store.createSubscription(botSub({ id: 'b', enabled: false }));
        await store.createSubscription(botSub({ id: 'c', pausedUntil: Number.MAX_SAFE_INTEGER, guildId: 'guild-2' }));
        expect(await store.countSubscriptions()).toBe(4);
        await store.deleteSubscription('a');
        expect(await store.countSubscriptions()).toBe(3);
      });

      it('is zero without subscriptions', async () => {
        const { store } = await setup([]);
        expect(await store.countSubscriptions()).toBe(0);
      });
    });

    describe('takeDue with bot subscriptions', () => {
      it('returns the rows of a bot subscription next to webhook rows, oldest first', async () => {
        const { store } = await setup();
        await store.createSubscription({ id: 'bot-q', guildId: 'guild-1', transport: 'bot', channelId: 'chan-1', threadId: 'thread-1', channelKind: 'forum', filter: {}, mode: 'immediate', digestIntervalMin: 30, enabled: true });
        const botEvent = event(1);
        const hookEvent = event(2);
        await store.commit(batch([botEvent, hookEvent], [row('bot-q', botEvent), row(SUB, hookEvent, { nextAttemptAt: NOW })]));
        const due = await store.takeDue(NOW, 10);
        expect(due.map((d) => d.row.subscriptionId).sort()).toEqual(['bot-q', SUB].sort());
        expect(due.find((d) => d.row.subscriptionId === 'bot-q')!.subscription).toMatchObject({
          transport: 'bot',
          channelId: 'chan-1',
          threadId: 'thread-1',
          channelKind: 'forum',
        });
      });

      it('skips the rows of a disabled bot subscription', async () => {
        const { store } = await setup();
        await store.createSubscription({ id: 'bot-q', guildId: 'guild-1', transport: 'bot', channelId: 'chan-1', filter: {}, mode: 'immediate', digestIntervalMin: 30, enabled: false });
        const botEvent = event(1);
        await store.commit(batch([botEvent], [row('bot-q', botEvent)]));
        expect(await store.takeDue(NOW, 10)).toEqual([]);
      });
    });

    describe('mod threads', () => {
      const thread = (over: Partial<ModThread> = {}): ModThread => ({
        channelId: 'chan-1',
        source: SOURCE,
        packageId: 'Owner1-Mod1',
        threadId: 'thread-1',
        anchorMessageId: 'msg-1',
        createdAt: T0,
        ...over,
      });

      it('returns null for a mod without a thread', async () => {
        const { store } = await setup();
        expect(await store.getModThread('chan-1', SOURCE, 'Owner1-Mod1')).toBeNull();
      });

      it('round-trips a thread, with and without an anchor message', async () => {
        const { store } = await setup();
        await store.putModThread(thread());
        await store.putModThread(thread({ packageId: 'Owner2-Mod2', anchorMessageId: null }));
        expect(await store.getModThread('chan-1', SOURCE, 'Owner1-Mod1')).toEqual(thread());
        expect(await store.getModThread('chan-1', SOURCE, 'Owner2-Mod2')).toEqual(thread({ packageId: 'Owner2-Mod2', anchorMessageId: null }));
      });

      it('keeps one thread per channel, source and package, and put replaces it', async () => {
        const { store } = await setup();
        await store.putModThread(thread());
        await store.putModThread(thread({ threadId: 'thread-2', anchorMessageId: 'msg-2', createdAt: NOW }));
        await store.putModThread(thread({ channelId: 'chan-2', threadId: 'thread-other' }));
        await store.putModThread(thread({ source: 'hexium:valheim', threadId: 'thread-hexium' }));
        expect(await store.getModThread('chan-1', SOURCE, 'Owner1-Mod1')).toEqual(thread({ threadId: 'thread-2', anchorMessageId: 'msg-2', createdAt: NOW }));
        expect((await store.getModThread('chan-2', SOURCE, 'Owner1-Mod1'))!.threadId).toBe('thread-other');
        expect((await store.getModThread('chan-1', 'hexium:valheim', 'Owner1-Mod1'))!.threadId).toBe('thread-hexium');
      });

      it('deletes only the addressed thread and tolerates one that does not exist', async () => {
        const { store } = await setup();
        await store.putModThread(thread());
        await store.putModThread(thread({ channelId: 'chan-2' }));
        await store.deleteModThread('chan-1', SOURCE, 'Owner1-Mod1');
        await store.deleteModThread('chan-1', SOURCE, 'Owner1-Mod1');
        expect(await store.getModThread('chan-1', SOURCE, 'Owner1-Mod1')).toBeNull();
        expect(await store.getModThread('chan-2', SOURCE, 'Owner1-Mod1')).not.toBeNull();
      });
    });

    describe('templates', () => {
      const botSub = (over: Partial<Subscription> = {}): Subscription => ({
        id: 'bot-1',
        guildId: 'guild-1',
        transport: 'bot',
        channelId: 'chan-1',
        filter: {},
        mode: 'immediate',
        digestIntervalMin: 30,
        enabled: true,
        ...over,
      });
      const template =(over: Partial<SubscriptionTemplate> = {}): SubscriptionTemplate => ({
        subscriptionId: 'bot-1',
        kind: 'immediate',
        body: '{name:link} {versions}\n---\n{buttons}',
        updatedAt: T0,
        ...over,
      });

      it('returns nothing for subscriptions without a template, and for an empty list', async () => {
        const { store } = await setup();
        expect(await store.getTemplates(['bot-1', 'nobody'])).toEqual([]);
        expect(await store.getTemplates([])).toEqual([]);
      });

      it('round-trips both kinds of one subscription and keeps them apart', async () => {
        const { store } = await setup();
        await store.setTemplate(template());
        await store.setTemplate(template({ kind: 'digest_line', body: '{name} {version}' }));
        const found = await store.getTemplates(['bot-1']);
        expect(found).toHaveLength(2);
        expect(found).toContainEqual(template());
        expect(found).toContainEqual(template({ kind: 'digest_line', body: '{name} {version}' }));
      });

      it('replaces the template of the same subscription and kind', async () => {
        const { store } = await setup();
        await store.setTemplate(template());
        await store.setTemplate(template({ body: 'changed', updatedAt: NOW }));
        expect(await store.getTemplates(['bot-1'])).toEqual([template({ body: 'changed', updatedAt: NOW })]);
      });

      it('reads only the templates of the subscriptions asked for, in one call, however many', async () => {
        const { store } = await setup();
        for (let i = 0; i < 250; i += 1) await store.setTemplate(template({ subscriptionId: `sub-${i}`, body: `body ${i}` }));
        const ids = Array.from({ length: 200 }, (_, i) => `sub-${i + 25}`);
        const found = await store.getTemplates([...ids, ...ids]);
        expect(found).toHaveLength(200);
        expect(new Set(found.map((t) => t.subscriptionId))).toEqual(new Set(ids));
        expect(found.find((t) => t.subscriptionId === 'sub-30')!.body).toBe('body 30');
      });

      it('keeps a body of the maximum length and multi-line text intact', async () => {
        const { store } = await setup();
        const body = `${'line {name}\n'.repeat(160)}`.slice(0, TEMPLATE_MAX_CHARS);
        await store.setTemplate(template({ body }));
        expect((await store.getTemplates(['bot-1']))[0]!.body).toBe(body);
      });

      it('deletes one kind of one subscription and says whether there was one', async () => {
        const { store } = await setup();
        await store.setTemplate(template());
        await store.setTemplate(template({ kind: 'digest_line' }));
        await store.setTemplate(template({ subscriptionId: 'bot-2' }));
        expect(await store.deleteTemplate('bot-1', 'immediate')).toBe(true);
        expect(await store.deleteTemplate('bot-1', 'immediate')).toBe(false);
        expect(await store.deleteTemplate('nobody', 'immediate')).toBe(false);
        expect((await store.getTemplates(['bot-1', 'bot-2'])).map((t) => `${t.subscriptionId}:${t.kind}`).sort()).toEqual(['bot-1:digest_line', 'bot-2:immediate']);
      });

      it('goes away with its subscription and with nothing else', async () => {
        const { store } = await setup();
        await store.createSubscription(botSub());
        await store.createSubscription(botSub({ id: 'bot-2' }));
        await store.setTemplate(template());
        await store.setTemplate(template({ kind: 'digest_line' }));
        await store.setTemplate(template({ subscriptionId: 'bot-2' }));
        expect(await store.deleteSubscription('bot-1')).toBe(true);
        expect(await store.getTemplates(['bot-1', 'bot-2'])).toEqual([template({ subscriptionId: 'bot-2' })]);
      });
    });

    describe('mod lookup by thread', () => {
      const thread = (over: Partial<ModThread> = {}): ModThread => ({
        channelId: 'chan-1',
        source: SOURCE,
        packageId: 'Owner1-Mod1',
        threadId: 'thread-1',
        anchorMessageId: null,
        createdAt: T0,
        ...over,
      });

      it('finds the mod behind a thread of the channel and returns null for any other id or channel', async () => {
        const { store } = await setup();
        await store.putModThread(thread());
        await store.putModThread(thread({ packageId: 'Owner2-Mod2', threadId: 'thread-2', anchorMessageId: 'msg-2' }));
        await store.putModThread(thread({ channelId: 'chan-2', packageId: 'Owner3-Mod3', threadId: 'thread-3' }));
        expect(await store.getModThreadByThreadId('chan-1', 'thread-2')).toEqual(thread({ packageId: 'Owner2-Mod2', threadId: 'thread-2', anchorMessageId: 'msg-2' }));
        expect(await store.getModThreadByThreadId('chan-1', 'thread-1')).toEqual(thread());
        expect(await store.getModThreadByThreadId('chan-2', 'thread-3')).toEqual(thread({ channelId: 'chan-2', packageId: 'Owner3-Mod3', threadId: 'thread-3' }));
        expect(await store.getModThreadByThreadId('chan-1', 'thread-3')).toBeNull();
        expect(await store.getModThreadByThreadId('chan-3', 'thread-1')).toBeNull();
        expect(await store.getModThreadByThreadId('chan-1', '')).toBeNull();
      });

      it('follows a thread that was replaced and forgets a deleted one', async () => {
        const { store } = await setup();
        await store.putModThread(thread());
        await store.putModThread(thread({ threadId: 'thread-2' }));
        expect(await store.getModThreadByThreadId('chan-1', 'thread-1')).toBeNull();
        expect((await store.getModThreadByThreadId('chan-1', 'thread-2'))!.packageId).toBe('Owner1-Mod1');
        await store.deleteModThread('chan-1', SOURCE, 'Owner1-Mod1');
        expect(await store.getModThreadByThreadId('chan-1', 'thread-2')).toBeNull();
      });
    });

    describe('package and event lookup', () => {
      const HEXIUM = 'hexium:valheim';

      async function seedMod(store: Store): Promise<ModEvent[]> {
        const v1 = makeEvent({ kind: 'new', createdAt: '2026-09-10T00:00:00.000Z', pkg: { owner: 'Bob', name: 'Warfare', version: '1.0.0' } });
        const v2 = makeEvent({
          kind: 'update',
          versionFrom: '1.0.0',
          createdAt: '2026-09-12T00:00:00.000Z',
          changelog: 'Fixed the sword',
          changelogUrl: 'https://thunderstore.invalid/changelog',
          pkg: { owner: 'Bob', name: 'Warfare', version: '1.1.0', categories: ['Weapons'], downloads: 42, likes: 7, downloadUrl: 'https://thunderstore.invalid/dl', websiteUrl: 'https://site.invalid/' },
        });
        await store.commit(batch([v1, v2], [], { packages: [v1.pkg, v2.pkg] }));
        return [v1, v2];
      }

      it('returns the packages with this id in the order of the requested sources, with every stored field', async () => {
        const { store } = await setup();
        await seedMod(store);
        const hexium = makeSnapshot({ source: HEXIUM, owner: 'Bob', name: 'Warfare', version: '2.0.0' });
        await store.commit({ source: HEXIUM, packages: [hexium], events: [], outbox: [], state: { ...state, id: HEXIUM } });
        const found = await store.getPackagesById(hexium.packageId, [HEXIUM, SOURCE]);
        expect(found.map((p) => [p.source, p.version])).toEqual([[HEXIUM, '2.0.0'], [SOURCE, '1.1.0']]);
        expect(found[1]).toMatchObject({ owner: 'Bob', name: 'Warfare', categories: ['Weapons'], downloads: 42, likes: 7, downloadUrl: 'https://thunderstore.invalid/dl', websiteUrl: 'https://site.invalid/', isNsfw: false });
        expect((await store.getPackagesById(hexium.packageId, [SOURCE])).map((p) => p.source)).toEqual([SOURCE]);
      });

      it('returns nothing for an unknown id, a source without it, no sources, or a different letter case', async () => {
        const { store } = await setup();
        await seedMod(store);
        const id = makeSnapshot({ owner: 'Bob', name: 'Warfare' }).packageId;
        expect(await store.getPackagesById('Bob-Nothing', [SOURCE])).toEqual([]);
        expect(await store.getPackagesById(id, [HEXIUM])).toEqual([]);
        expect(await store.getPackagesById(id, [])).toEqual([]);
        expect(await store.getPackagesById(id.toLowerCase(), [SOURCE])).toEqual([]);
      });

      it('returns an event by its id, with its changelog, joined with the stored package', async () => {
        const { store } = await setup();
        const [, v2] = await seedMod(store);
        const found = await store.getEventById(v2!.id);
        expect(found).toMatchObject({ id: v2!.id, kind: 'update', versionFrom: '1.0.0', versionTo: '1.1.0', changelog: 'Fixed the sword', changelogUrl: 'https://thunderstore.invalid/changelog' });
        expect(found!.pkg).toMatchObject({ packageId: v2!.pkg.packageId, downloads: 42, likes: 7 });
      });

      it('returns null for an event that does not exist', async () => {
        const { store } = await setup();
        await seedMod(store);
        expect(await store.getEventById(eventId(SOURCE, 'Bob-Nothing', '1.0.0'))).toBeNull();
        expect(await store.getEventById('')).toBeNull();
      });
    });

    describe('autocomplete search', () => {
      async function seed(store: Store, packages: { owner: string; name: string; source?: string }[]): Promise<void> {
        const bySource = new Map<string, PackageSnapshot[]>();
        for (const p of packages) {
          const source = p.source ?? SOURCE;
          const list = bySource.get(source) ?? [];
          list.push(makeSnapshot({ source, owner: p.owner, name: p.name }));
          bySource.set(source, list);
        }
        for (const [source, list] of bySource) await store.commit({ source, packages: list, events: [], outbox: [], state: { ...state, id: source } });
      }

      it('knows a package by its exact id within the given sources only', async () => {
        const { store } = await setup();
        await seed(store, [{ owner: 'Bob', name: 'Warfare' }, { owner: 'Ann', name: 'Axe', source: 'hexium:valheim' }]);
        const id = makeSnapshot({ owner: 'Bob', name: 'Warfare' }).packageId;
        expect(await store.packageExists(id, [SOURCE])).toBe(true);
        expect(await store.packageExists(id, ['hexium:valheim', SOURCE])).toBe(true);
        expect(await store.packageExists(id, ['hexium:valheim'])).toBe(false);
        expect(await store.packageExists(id, [])).toBe(false);
        expect(await store.packageExists(id.slice(0, -1), [SOURCE])).toBe(false);
        expect(await store.packageExists(id.toLowerCase(), [SOURCE])).toBe(id === id.toLowerCase());
        expect(await store.packageExists('Bob', [SOURCE])).toBe(false);
      });

      it('returns nothing for a prefix shorter than the minimum', async () => {
        const { store } = await setup();
        await seed(store, [{ owner: 'Alpha', name: 'Axe' }]);
        for (const prefix of ['', 'a', 'A']) {
          expect(await store.searchPackages(prefix)).toEqual([]);
          expect(await store.searchOwners(prefix)).toEqual([]);
        }
        expect(AUTOCOMPLETE_MIN_PREFIX).toBe(2);
      });

      it('finds packages by name prefix ignoring case, ordered by name, and not by a substring', async () => {
        const { store } = await setup();
        await seed(store, [
          { owner: 'Bob', name: 'Warfare' },
          { owner: 'Ann', name: 'warp' },
          { owner: 'Cid', name: 'WARDEN' },
          { owner: 'Dee', name: 'Stewardship' },
          { owner: 'Eve', name: 'War' },
        ]);
        expect((await store.searchPackages('wAr')).map((p) => p.name)).toEqual(['War', 'WARDEN', 'Warfare', 'warp']);
        expect((await store.searchPackages('wa')).map((p) => p.name)).toEqual(['War', 'WARDEN', 'Warfare', 'warp']);
        expect(await store.searchPackages('zz')).toEqual([]);
      });

      it('leaves NSFW packages out only when asked to', async () => {
        const { store } = await setup();
        const nsfw = makeSnapshot({ owner: 'Eve', name: 'Warlock', isNsfw: true });
        await store.commit({ source: SOURCE, packages: [makeSnapshot({ owner: 'Bob', name: 'Warfare' }), nsfw], events: [], outbox: [], state });
        expect((await store.searchPackages('war')).map((p) => p.name)).toEqual(['Warfare', 'Warlock']);
        expect((await store.searchPackages('war', { sfwOnly: true })).map((p) => p.name)).toEqual(['Warfare']);
        expect((await store.searchPackages('war', { sfwOnly: false })).map((p) => p.name)).toEqual(['Warfare', 'Warlock']);
      });

      it('returns source, package id, owner and name of each match, across sources', async () => {
        const { store } = await setup();
        await seed(store, [
          { owner: 'Ann', name: 'Epic', source: SOURCE },
          { owner: 'Ann', name: 'Epic', source: 'hexium:valheim' },
        ]);
        const found = await store.searchPackages('Ep');
        expect(found.map((p) => ({ source: p.source, packageId: p.packageId, owner: p.owner, name: p.name })).sort((a, b) => a.source.localeCompare(b.source))).toEqual([
          { source: 'hexium:valheim', packageId: 'Ann-Epic', owner: 'Ann', name: 'Epic' },
          { source: SOURCE, packageId: 'Ann-Epic', owner: 'Ann', name: 'Epic' },
        ]);
      });

      it('treats LIKE wildcards in the prefix literally', async () => {
        const { store } = await setup();
        await seed(store, [
          { owner: 'Ann', name: 'a_b' },
          { owner: 'Bob', name: 'axb' },
          { owner: 'Cid', name: '100%' },
          { owner: 'Dee', name: '1000' },
        ]);
        expect((await store.searchPackages('a_')).map((p) => p.name)).toEqual(['a_b']);
        expect((await store.searchPackages('10')).map((p) => p.name).sort()).toEqual(['100%', '1000']);
        expect((await store.searchPackages('1%')).map((p) => p.name)).toEqual([]);
      });

      it('caps the package results', async () => {
        const { store } = await setup();
        await seed(store, Array.from({ length: AUTOCOMPLETE_MAX_RESULTS + 5 }, (_, i) => ({ owner: `Own${i}`, name: `Mod${String(i).padStart(2, '0')}` })));
        const found = await store.searchPackages('Mod');
        expect(found).toHaveLength(AUTOCOMPLETE_MAX_RESULTS);
        expect(found[0]!.name).toBe('Mod00');
        expect(found[AUTOCOMPLETE_MAX_RESULTS - 1]!.name).toBe(`Mod${AUTOCOMPLETE_MAX_RESULTS - 1}`);
      });

      it('finds distinct owners by prefix ignoring case, alphabetically', async () => {
        const { store } = await setup();
        await seed(store, [
          { owner: 'Randy', name: 'One' },
          { owner: 'Randy', name: 'Two' },
          { owner: 'randy', name: 'Three', source: 'hexium:valheim' },
          { owner: 'RaGnar', name: 'Four' },
          { owner: 'Zed', name: 'Five' },
          { owner: 'Bran', name: 'Six' },
        ]);
        const owners = await store.searchOwners('RA');
        expect(owners.map((o) => o.toLowerCase())).toEqual(['ragnar', 'randy']);
        expect(await store.searchOwners('qq')).toEqual([]);
      });

      it('caps the owner results', async () => {
        const { store } = await setup();
        await seed(store, Array.from({ length: AUTOCOMPLETE_MAX_RESULTS + 5 }, (_, i) => ({ owner: `Crew${String(i).padStart(2, '0')}`, name: `Mod${i}` })));
        const owners = await store.searchOwners('Cr');
        expect(owners).toHaveLength(AUTOCOMPLETE_MAX_RESULTS);
        expect(owners[0]).toBe('Crew00');
      });

      it('lists an owner with many packages once', async () => {
        const { store } = await setup();
        await seed(store, Array.from({ length: 40 }, (_, i) => ({ owner: 'Prolific', name: `Mod${i}` })));
        expect(await store.searchOwners('Pr')).toEqual(['Prolific']);
      });

      it('reads no more than the scan limit of entries to find owners', async () => {
        const { store } = await setup();
        const heavy = Array.from({ length: AUTOCOMPLETE_OWNER_SCAN_LIMIT }, (_, i) => ({ owner: 'Aaa', name: `Mod${i}` }));
        await seed(store, [...heavy, { owner: 'Aab', name: 'Late' }]);
        expect(await store.searchOwners('Aa')).toEqual(['Aaa']);
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
