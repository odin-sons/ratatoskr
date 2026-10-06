// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { D1Store } from '../../cloudflare/d1-store.ts';
import { D1Shim } from '../../cloudflare/testing/d1-shim.ts';
import type { Store } from '../../core/ports.ts';
import type { PackageSnapshot } from '../../core/types.ts';
import { en } from '../../i18n/en.ts';
import { ru } from '../../i18n/ru.ts';
import { makeEvent, makeSnapshot } from '../../testing/fakes.ts';
import { autocompleteOf, CHANNEL_ID, command, harness, inThread, interaction, THREAD_ID, type Harness } from './harness.ts';

const THUNDERSTORE = 'thunderstore:valheim';
const HEXIUM = 'hexium:valheim';
const MESSAGE_ID = '923456789012345670';
const NOBODY = { member: { permissions: '0', user: { id: '323456789012345678' } } };
const EPHEMERAL_V2 = 64 | 32768;
const state = (id: string) => ({ id, cursor: 'c', etag: null, bootstrapped: true, lastOkAt: null });

type Options = NonNullable<Parameters<typeof harness>[0]>;
type Create = (options?: Pick<Options, 'messages' | 'sources'>) => Harness<Store>;

const modInfo = (targetId: string | undefined) =>
  interaction({ data: { name: 'Mod info', type: 3, ...(targetId === undefined ? {} : { target_id: targetId }) }, ...NOBODY });
const info = (options: Record<string, string> = {}, over: Record<string, unknown> = {}) => command('info', options, { ...NOBODY, ...over });

const body = (response: { data?: Record<string, unknown> }): string => JSON.stringify(response.data?.components);

async function seedMod(store: Store, over: Partial<PackageSnapshot> = {}, changelog: string | null = 'Fixed the sword'): Promise<string> {
  const owner = over.owner ?? 'Bob';
  const name = over.name ?? 'Warfare';
  const first = makeEvent({ kind: 'new', createdAt: '2026-09-10T00:00:00.000Z', pkg: { owner, name, ...over, version: '1.0.0' } });
  const latest = makeEvent({
    kind: 'update',
    versionFrom: '1.0.0',
    versionTo: '1.1.0',
    createdAt: '2026-09-12T00:00:00.000Z',
    changelog,
    changelogUrl: 'https://thunderstore.invalid/changelog',
    pkg: {
      owner,
      name,
      categories: ['Weapons', 'Tools'],
      downloads: 12_345,
      likes: 7,
      downloadUrl: 'https://thunderstore.invalid/dl',
      websiteUrl: 'https://site.invalid/',
      ...over,
      version: '1.1.0',
    },
  });
  await store.commit({ source: latest.pkg.source, packages: [first.pkg, latest.pkg], events: [first, latest], outbox: [], state: state(latest.pkg.source) });
  return latest.pkg.packageId;
}

const ID = makeSnapshot({ owner: 'Bob', name: 'Warfare' }).packageId;

function suites(name: string, create: Create): void {
  describe(`/info (${name})`, () => {
    it('answers inline, ephemerally, as a Components V2 message with the facts of the mod', async () => {
      const h = create();
      await seedMod(h.store);
      const response = await h.run(info({ mod: ID }));
      expect(response.type).toBe(4);
      expect(response.data?.flags).toBe(EPHEMERAL_V2);
      expect(response.data?.allowed_mentions).toEqual({ parse: [] });
      expect(h.finished).toEqual([]);
      const text = body(response);
      expect(text).toContain('Warfare');
      expect(text).toContain('Bob');
      expect(text).toContain('1.0.0 → 1.1.0');
      expect(text).toContain('Downloaded 12,345 times');
      expect(text).toContain('7 likes');
      expect(text).toContain('Weapons, Tools');
      expect(text).toContain('Fixed the sword');
      expect(text).toContain('[Full changelog](https://thunderstore.invalid/changelog)');
      expect(text).toContain(`https://thunderstore.invalid/${ID}/`);
      expect(text).toContain('https://thunderstore.invalid/dl');
      expect(text).toContain('https://site.invalid/');
    });

    it('says a mod is unknown instead of guessing', async () => {
      const h = create();
      await seedMod(h.store);
      const response = await h.run(info({ mod: 'Nobody-Nothing' }));
      expect(response.data).toMatchObject({ content: expect.stringContaining('was not found'), flags: 64 });
    });

    it('does not pass the mod option through unescaped', async () => {
      const h = create();
      const response = await h.run(info({ mod: '@everyone [x](http://a) **b**' }));
      const text = String(response.data?.content);
      expect(text).not.toContain('@everyone');
      expect(text).not.toContain('**b**');
      expect(response.data?.allowed_mentions).toEqual({ parse: [] });
    });

    it('does not know a mod of a source this deployment does not poll', async () => {
      const h = create({ sources: [{ id: HEXIUM, store: 'hexium', community: 'valheim', enabled: true }] });
      await seedMod(h.store);
      expect(String((await h.run(info({ mod: ID }))).data?.content)).toContain('was not found');
    });

    it('never shows an NSFW mod, and falls through to a safe package of the same id in another source', async () => {
      const h = create();
      await seedMod(h.store, { isNsfw: true });
      expect(String((await h.run(info({ mod: ID }))).data?.content)).toContain('was not found');
      await seedMod(h.store, { source: HEXIUM, store: 'hexium', description: 'The safe twin' });
      expect(body(await h.run(info({ mod: ID })))).toContain('The safe twin');
    });

    it('shows a mod that has no event yet, without a changelog', async () => {
      const h = create();
      const bare = makeSnapshot({ owner: 'Ann', name: 'Axe', downloads: 5 });
      await h.store.commit({ source: THUNDERSTORE, packages: [bare], events: [], outbox: [], state: state(THUNDERSTORE) });
      const text = body(await h.run(info({ mod: bare.packageId })));
      expect(text).toContain('Axe');
      expect(text).toContain('Downloaded 5 times');
      expect(text).not.toContain('Changelog');
    });

    it('leaves out a changelog that belongs to an older version than the stored one', async () => {
      const h = create();
      const id = await seedMod(h.store);
      const newer = makeSnapshot({ owner: 'Bob', name: 'Warfare', version: '1.2.0', updatedAt: '2026-09-15T00:00:00.000Z' });
      await h.store.commit({ source: THUNDERSTORE, packages: [newer], events: [], outbox: [], state: state(THUNDERSTORE) });
      const text = body(await h.run(info({ mod: id })));
      expect(text).toContain('1.2.0');
      expect(text).not.toContain('Fixed the sword');
    });

    it('treats upstream text as untrusted: no pings, no markdown injection, no unsafe links', async () => {
      const h = create();
      const id = await seedMod(
        h.store,
        { packageId: 'Mallory-Evil', name: '@everyone **Evil** [x](http://a)', owner: 'Mallory', websiteUrl: 'javascript:alert(1)', downloadUrl: 'ftp://x/y', description: '@here ping' },
        'Fixed @everyone and <@&123456789012345678>',
      );
      const response = await h.run(info({ mod: id }));
      const text = body(response);
      expect(response.data?.allowed_mentions).toEqual({ parse: [] });
      expect(text).not.toMatch(/@everyone|@here|<@&?\d/);
      expect(text).not.toContain('javascript:');
      expect(text).not.toContain('ftp://');
      expect(text).not.toContain('**Evil**');
    });

    it('answers in the language of the deployment', async () => {
      const h = create({ messages: ru });
      await seedMod(h.store);
      const text = body(await h.run(info({ mod: ID })));
      expect(text).toContain('Скачан 12 345 раз');
      expect(text).toContain('Изменения');
      expect(text).toContain('Скачать');
    });

    describe('without a mod option', () => {
      const bind = async (h: Harness<Store>): Promise<void> => {
        await seedMod(h.store);
        await h.store.putModThread({ channelId: CHANNEL_ID, source: THUNDERSTORE, packageId: ID, threadId: THREAD_ID, anchorMessageId: null, createdAt: '2026-09-12T00:00:00.000Z' });
      };

      it('asks for a mod in a channel', async () => {
        const h = create();
        expect((await h.run(info())).data?.content).toBe(en.infoNeedsMod);
        expect((await h.run(info({ mod: '   ' }))).data?.content).toBe(en.infoNeedsMod);
      });

      it('asks for a mod in a thread no mod owns', async () => {
        const h = create();
        await seedMod(h.store);
        expect((await h.run(info({}, { channel: inThread().channel }))).data?.content).toBe(en.infoNeedsMod);
      });

      it('takes the mod of the thread or forum post it runs in', async () => {
        const h = create();
        await bind(h);
        for (const type of [10, 11, 12]) {
          expect(body(await h.run(info({}, { channel: { id: THREAD_ID, type, parent_id: CHANNEL_ID } })))).toContain('Warfare');
        }
      });

      it('does not mistake a channel for a thread, even one with the id of a thread', async () => {
        const h = create();
        await bind(h);
        expect((await h.run(info({}, { channel: { id: THREAD_ID, type: 0 } }))).data?.content).toBe(en.infoNeedsMod);
      });

      it('does not resolve a thread of another parent channel, or one without a parent', async () => {
        const h = create();
        await bind(h);
        expect((await h.run(info({}, { channel: { id: THREAD_ID, type: 11, parent_id: '923456789012345678' } }))).data?.content).toBe(en.infoNeedsMod);
        expect((await h.run(info({}, { channel: { id: THREAD_ID, type: 11 } }))).data?.content).toBe(en.infoNeedsMod);
      });

      it('prefers the mod option over the thread', async () => {
        const h = create();
        await bind(h);
        const other = await seedMod(h.store, { owner: 'Ann', name: 'Axe' });
        expect(body(await h.run(info({ mod: other }, { channel: inThread().channel })))).toContain('Axe');
      });
    });
  });

  describe(`Mod info (${name})`, () => {
    const record = { messageId: MESSAGE_ID, channelId: CHANNEL_ID, source: THUNDERSTORE, packageId: ID, eventId: null, createdAt: '2026-09-12T00:00:00.000Z' };

    it('shows the mod behind a message of the message map, to a member without any permission', async () => {
      const h = create();
      await seedMod(h.store);
      await h.store.putMessage(record);
      const response = await h.run(modInfo(MESSAGE_ID));
      expect(response.data?.flags).toBe(EPHEMERAL_V2);
      expect(body(response)).toContain('Warfare');
      expect(body(response)).toContain('Fixed the sword');
    });

    it.each([
      ['a message that is not in the map (too old, several mods or not mine)', MESSAGE_ID],
      ['no target message at all', undefined],
    ])('asks for /info on %s', async (_label, target) => {
      const h = create();
      await seedMod(h.store);
      expect((await h.run(modInfo(target))).data).toMatchObject({ content: en.infoMessageUnknown, flags: 64 });
    });

    it('says the mod is unknown when the record outlived the mod', async () => {
      const h = create();
      await h.store.putMessage(record);
      expect(String((await h.run(modInfo(MESSAGE_ID))).data?.content)).toContain('was not found');
    });

    it('does not show an NSFW mod behind a message either', async () => {
      const h = create();
      await seedMod(h.store, { isNsfw: true });
      await h.store.putMessage(record);
      expect(String((await h.run(modInfo(MESSAGE_ID))).data?.content)).toContain('was not found');
    });

    it('answers in the language of the deployment', async () => {
      const h = create({ messages: ru });
      await seedMod(h.store);
      await h.store.putMessage(record);
      expect(body(await h.run(modInfo(MESSAGE_ID)))).toContain('Изменения');
      expect((await h.run(modInfo('923456789012345671'))).data?.content).toBe(ru.infoMessageUnknown);
    });
  });

  describe(`/info autocomplete (${name})`, () => {
    it('suggests packages by name prefix with the package id as value, for any member', async () => {
      const h = create();
      await seedMod(h.store);
      expect((await h.run(autocompleteOf('info', 'mod', 'war', NOBODY))).data?.choices).toEqual([{ name: 'Warfare (Bob)', value: ID }]);
    });

    it('never suggests an NSFW mod, while /subscribe still does', async () => {
      const h = create();
      await seedMod(h.store, { isNsfw: true });
      await seedMod(h.store, { owner: 'Ann', name: 'Warden' });
      const names = (response: { data?: Record<string, unknown> }) => (response.data?.choices as { name: string }[]).map((c) => c.name);
      expect(names(await h.run(autocompleteOf('info', 'mod', 'war', NOBODY)))).toEqual(['Warden (Ann)']);
      expect(names(await h.run(autocompleteOf('subscribe', 'mod', 'war')))).toEqual(['Warden (Ann)', 'Warfare (Bob)']);
    });

    it('suggests nothing for a short prefix or another option', async () => {
      const h = create();
      await seedMod(h.store);
      expect((await h.run(autocompleteOf('info', 'mod', 'w'))).data?.choices).toEqual([]);
      expect((await h.run(autocompleteOf('info', 'other', 'war'))).data?.choices).toEqual([]);
    });
  });
}

const SCHEMA = readFileSync(join(import.meta.dirname, '../../../schema.sql'), 'utf8');

suites('memory store', (options) => harness<Store>(options));
suites('D1 store', (options) => {
  const shim = new D1Shim();
  shim.db.exec(SCHEMA);
  return harness<Store>({ ...options, store: new D1Store(shim as unknown as D1Database) });
});
