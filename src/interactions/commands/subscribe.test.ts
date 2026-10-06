// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUTOCOMPLETE_MAX_RESULTS,
  MAX_SUBSCRIPTIONS_PER_CHANNEL,
  MAX_SUBSCRIPTIONS_PER_GUILD,
  MAX_SUBSCRIPTIONS_TOTAL,
  SUBSCRIPTION_LABEL_MAX,
} from '../../core/constants.ts';
import { SUBSCRIPTION_ID_RE, validateSubscriptionFilter } from '../../core/validation.ts';
import { en } from '../../i18n/en.ts';
import { ru } from '../../i18n/ru.ts';
import { CHANNEL_TYPE, PERMISSION } from '../constants.ts';
import { canonicalFilter } from './subscribe.ts';
import {
  ALL_BOT_PERMISSIONS,
  autocompleteOf,
  CHANNEL_ID,
  command,
  GUILD_ID,
  harness,
  type Harness,
  inThread,
  interaction,
  PARENT_ID,
  subscription,
  THREAD_ID,
  USER_ID,
} from './harness.ts';

const stored = (h: Harness) => [...h.store.subscriptions.values()];

describe('/subscribe', () => {
  it('defers ephemerally, stores a bot subscription of the invoking user in this channel and confirms', async () => {
    const h = harness({ ids: ['abc123'] });
    const response = await h.run(command('subscribe', { owner: 'RandyKnapp' }));
    expect(response).toEqual({ type: 5, data: { flags: 64 } });
    expect(stored(h)).toEqual([
      {
        id: 'abc123',
        guildId: GUILD_ID,
        transport: 'bot',
        channelId: CHANNEL_ID,
        threadId: null,
        label: 'RandyKnapp',
        createdBy: USER_ID,
        threadPerMod: false,
        channelKind: 'text',
        filter: { packages: ['RandyKnapp'] },
        mode: 'digest',
        digestIntervalMin: 30,
        enabled: true,
        pausedUntil: 0,
        webhookUrl: null,
      },
    ]);
    expect(h.followUp()).toBe(`Subscribed: RandyKnapp in <#${CHANNEL_ID}> (digest every 30 min · mods or owners RandyKnapp)
ID: \`abc123\``);
  });

  it('builds the filter from owner, mod, category, source and kind; source maps to the enabled sources of that store', async () => {
    const h = harness();
    h.store.seedPackages('hexium:valheim', { 'Owner-Mod': '1.0.0' });
    await h.run(command('subscribe', { mod: 'Owner-Mod', category: 'Tools', source: 'hexium', kind: 'update', mode: 'immediate' }));
    expect(stored(h)[0]).toMatchObject({
      filter: { packages: ['Owner-Mod'], includeCategories: ['Tools'], sources: ['hexium:valheim'], kinds: ['update'] },
      mode: 'immediate',
    });
  });

  it('treats kind both as no restriction', async () => {
    const h = harness();
    await h.run(command('subscribe', { category: 'Tools', kind: 'both' }));
    expect(stored(h)[0]!.filter).toEqual({ includeCategories: ['Tools'] });
  });

  it('refuses a source this deployment does not poll', async () => {
    const h = harness();
    const response = await h.run(command('subscribe', { source: 'nexus' }));
    expect(response.data?.content).toBe('This bot does not poll nexus.');
    expect(stored(h)).toEqual([]);
  });

  it('refuses to subscribe to everything: at least one of owner, mod, category or source is required', async () => {
    const h = harness();
    for (const options of <Record<string, string | boolean>[]>[{}, { kind: 'new' }, { mode: 'immediate', label: 'All' }, { owner: '   ' }]) {
      const response = await h.run(command('subscribe', options));
      expect(response.type).toBe(4);
      expect(response.data?.content).toBe(en.subscribeNeedsFilter);
    }
    expect(stored(h)).toEqual([]);
  });

  it('accepts a source alone, which is the way to mean everything from one store', async () => {
    const h = harness();
    await h.run(command('subscribe', { source: 'thunderstore' }));
    expect(stored(h)[0]!.filter).toEqual({ sources: ['thunderstore:valheim'] });
  });

  it('needs Manage Channel and writes nothing without it', async () => {
    const h = harness();
    const response = await h.run(command('subscribe', { owner: 'a' }, { member: { permissions: '0', user: { id: USER_ID } } }));
    expect(response.data?.content).toBe(en.missingManageChannel);
    expect(stored(h)).toEqual([]);
  });

  it('names every permission the bot lacks and writes nothing', async () => {
    const h = harness();
    const granted = String(BigInt(ALL_BOT_PERMISSIONS) & ~PERMISSION.embedLinks & ~PERMISSION.createPublicThreads);
    const response = await h.run(command('subscribe', { owner: 'a' }, { app_permissions: granted }));
    expect(response.data?.content).toBe('I am missing permissions in this channel: Embed Links, Create Public Threads.');
    expect(stored(h)).toEqual([]);
  });

  it('refuses outside a server and in a channel kind it cannot post to', async () => {
    const h = harness();
    expect((await h.run(command('subscribe', { owner: 'a' }, { guild_id: undefined }))).data?.content).toBe(en.guildOnly);
    const voice = await h.run(command('subscribe', { owner: 'a' }, { channel: { id: CHANNEL_ID, type: 2 } }));
    expect(voice.data?.content).toBe(en.unsupportedChannel);
    expect(stored(h)).toEqual([]);
  });

  describe('where it subscribes', () => {
    it('inside a thread or forum post, delivers into that thread of the parent channel', async () => {
      const h = harness();
      await h.run(command('subscribe', { owner: 'a' }, { channel: inThread().channel }));
      expect(stored(h)[0]).toMatchObject({ channelId: CHANNEL_ID, threadId: THREAD_ID, threadPerMod: false });
      expect(h.followUp()).toContain(`<#${THREAD_ID}>`);
    });

    it('with thread_per_mod inside a thread, subscribes the parent channel itself', async () => {
      const h = harness();
      await h.run(command('subscribe', { owner: 'a', mode: 'immediate', thread_per_mod: true }, { channel: inThread().channel }));
      expect(stored(h)[0]).toMatchObject({ channelId: CHANNEL_ID, threadId: null, threadPerMod: true });
      expect(h.followUp()).toContain(`<#${CHANNEL_ID}> (immediate, thread per mod ·`);
    });

    describe('channel kind', () => {
      it('is text without asking Discord when the command ran in a text channel', async () => {
        const asked: string[] = [];
        const h = harness({ channelKind: async (id) => (asked.push(id), 'forum') });
        await h.run(command('subscribe', { owner: 'a' }));
        expect(stored(h)[0]).toMatchObject({ channelKind: 'text' });
        expect(asked).toEqual([]);
      });

      it('is what Discord says about the parent when the command ran in a thread', async () => {
        const asked: string[] = [];
        const h = harness({ channelKind: async (id) => (asked.push(id), 'forum') });
        await h.run(command('subscribe', { owner: 'a', mode: 'immediate', thread_per_mod: true }, { channel: inThread().channel }));
        expect(stored(h)[0]).toMatchObject({ channelId: CHANNEL_ID, channelKind: 'forum', threadPerMod: true });
        expect(asked).toEqual([CHANNEL_ID]);
      });

      it.each([
        ['cannot tell', async () => null],
        ['fails', async () => Promise.reject(new Error('offline'))],
      ])('refuses thread_per_mod in a thread when Discord %s, and stores nothing', async (_name, channelKind) => {
        const h = harness({ channelKind });
        await h.run(command('subscribe', { owner: 'a', mode: 'immediate', thread_per_mod: true }, { channel: inThread().channel }));
        expect(h.followUp()).toBe(en.subscribeChannelKindUnknown);
        expect(stored(h)).toEqual([]);
      });

      it('still binds a plain subscription to a thread when Discord cannot tell, storing text', async () => {
        const h = harness({ channelKind: async () => null });
        await h.run(command('subscribe', { owner: 'a' }, { channel: inThread().channel }));
        expect(stored(h)[0]).toMatchObject({ threadId: THREAD_ID, channelKind: 'text' });
      });
    });

    it('uses the parent from the signed payload, never an option', async () => {
      const h = harness();
      await h.run(command('subscribe', { owner: 'a', channel: PARENT_ID, guild_id: PARENT_ID }));
      expect(stored(h)[0]).toMatchObject({ channelId: CHANNEL_ID, guildId: GUILD_ID });
    });

    it('supports an announcement channel', async () => {
      const h = harness();
      await h.run(command('subscribe', { owner: 'a' }, { channel: { id: CHANNEL_ID, type: CHANNEL_TYPE.guildAnnouncement } }));
      expect(stored(h)).toHaveLength(1);
    });
  });

  describe('owner and mod', () => {
    it('refuses owner together with mod, since an owner entry already matches all of that author mods', async () => {
      const h = harness();
      h.store.seedPackages('thunderstore:valheim', { 'Randy-Epic': '1.0.0' });
      const response = await h.run(command('subscribe', { owner: 'Randy', mod: 'Randy-Epic' }));
      expect(response.type).toBe(4);
      expect(response.data?.content).toBe(en.subscribeOwnerAndMod);
      expect(stored(h)).toEqual([]);
    });

    it('subscribes to a mod that exists in the store', async () => {
      const h = harness();
      h.store.seedPackages('thunderstore:valheim', { 'Randy-Epic': '1.0.0' });
      await h.run(command('subscribe', { mod: 'Randy-Epic' }));
      expect(stored(h)[0]!.filter).toEqual({ packages: ['Randy-Epic'] });
    });

    it.each(['Randy-Missing', 'randy-epic', 'Randy', 'Epic'])('replies that the mod %s was not found and stores nothing', async (mod) => {
      const h = harness();
      h.store.seedPackages('thunderstore:valheim', { 'Randy-Epic': '1.0.0' });
      await h.run(command('subscribe', { mod }));
      expect(h.followUp()).toBe(en.modNotFound(mod));
      expect(stored(h)).toEqual([]);
    });

    it('looks the mod up only in the chosen source', async () => {
      const h = harness();
      h.store.seedPackages('thunderstore:valheim', { 'Randy-Epic': '1.0.0' });
      await h.run(command('subscribe', { mod: 'Randy-Epic', source: 'hexium' }));
      expect(h.followUp()).toBe(en.modNotFound('Randy-Epic'));
      await h.run(command('subscribe', { mod: 'Randy-Epic', source: 'thunderstore' }));
      expect(stored(h)).toHaveLength(1);
    });

    it('accepts exactly what the mod autocomplete offers', async () => {
      const h = harness();
      h.store.seedPackages('thunderstore:valheim', { 'Randy-Epic': '1.0.0', 'Zed-Epic': '1.0.0' });
      const choices = (await h.run(autocompleteOf('subscribe', 'mod', 'epic'))).data?.choices as { value: string }[];
      expect(choices).toHaveLength(2);
      for (const [i, choice] of choices.entries()) {
        await h.run(command('subscribe', { mod: choice.value }));
        expect(stored(h)).toHaveLength(i + 1);
      }
    });
  });

  describe('mode, interval and thread_per_mod', () => {
    it('refuses thread_per_mod with digest mode, given or defaulted, with a clear message', async () => {
      const h = harness();
      for (const options of <Record<string, string | boolean>[]>[{ owner: 'a', thread_per_mod: true }, { owner: 'a', mode: 'digest', thread_per_mod: true }]) {
        const response = await h.run(command('subscribe', options));
        expect(response.type).toBe(4);
        expect(response.data?.content).toBe(en.subscribeThreadPerModDigest);
      }
      expect(stored(h)).toEqual([]);
    });

    it('takes a digest interval within 5 to 1440 minutes', async () => {
      const h = harness();
      await h.run(command('subscribe', { owner: 'a', interval: 5 }));
      await h.run(command('subscribe', { owner: 'b', interval: 1440 }));
      expect(stored(h).map((s) => s.digestIntervalMin)).toEqual([5, 1440]);
    });

    it.each([4, 1441, 0, -5])('refuses the interval %d', async (interval) => {
      const h = harness();
      const response = await h.run(command('subscribe', { owner: 'a', interval }));
      expect(response.data?.content).toContain('interval: must be an integer between 5 and 1440');
      expect(stored(h)).toEqual([]);
    });

    it('refuses an interval together with immediate mode', async () => {
      const h = harness();
      const response = await h.run(command('subscribe', { owner: 'a', mode: 'immediate', interval: 10 }));
      expect(response.data?.content).toBe(en.subscribeIntervalImmediate);
    });

    it('refuses an unknown mode or kind', async () => {
      const h = harness();
      expect((await h.run(command('subscribe', { owner: 'a', mode: 'hourly' }))).data?.content).toContain('mode: must be one of');
      expect((await h.run(command('subscribe', { owner: 'a', kind: 'everything' }))).data?.content).toContain('kind: must be');
      expect(stored(h)).toEqual([]);
    });
  });

  describe('label', () => {
    it('uses the given label, cleaned and cut to the maximum', async () => {
      const h = harness();
      await h.run(command('subscribe', { owner: 'a', label: `  News${String.fromCharCode(0x200b)}\n  feed ${'x'.repeat(200)}` }));
      const label = stored(h)[0]!.label!;
      expect(label.startsWith('News feed x')).toBe(true);
      expect(label).toHaveLength(SUBSCRIPTION_LABEL_MAX);
    });

    it('is generated from the options when absent', async () => {
      const h = harness();
      h.store.seedPackages('hexium:valheim', { 'A-B': '1.0.0' });
      await h.run(command('subscribe', { mod: 'A-B', category: 'Tools', source: 'hexium' }));
      expect(stored(h)[0]!.label).toBe('A-B, Tools, hexium');
    });

    it('is shown escaped and without mentions', async () => {
      const h = harness();
      await h.run(command('subscribe', { owner: 'a', label: '**@everyone** <#123>' }));
      expect(h.followUp()).not.toContain('@everyone');
      expect(h.followUp()).toContain(`\\*\\*@${String.fromCharCode(0x200b)}everyone\\*\\*`);
    });
  });

  describe('duplicates and caps', () => {
    it('refuses an identical subscription in the same place and keeps the first', async () => {
      const h = harness();
      await h.run(command('subscribe', { owner: 'a', category: 'Tools' }));
      await h.run(command('subscribe', { category: 'Tools', owner: 'a', label: 'again' }));
      expect(h.followUp()).toBe(en.subscribeDuplicate);
      expect(stored(h)).toHaveLength(1);
    });

    it('allows the same filter in another channel, another thread or another mode', async () => {
      const h = harness();
      await h.run(command('subscribe', { owner: 'a' }));
      await h.run(command('subscribe', { owner: 'a' }, { channel: { id: PARENT_ID, type: 0 } }));
      await h.run(command('subscribe', { owner: 'a' }, { channel: inThread().channel }));
      await h.run(command('subscribe', { owner: 'a', mode: 'immediate' }));
      expect(stored(h)).toHaveLength(4);
    });

    it(`refuses the ${MAX_SUBSCRIPTIONS_PER_CHANNEL + 1}th subscription of a channel, threads under it included`, async () => {
      const h = harness();
      for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CHANNEL - 1; i++) h.store.addSubscription(subscription({ id: `s${i}`, filter: { packages: [`o${i}`] } }));
      h.store.addSubscription(subscription({ id: 'in-thread', threadId: THREAD_ID, filter: { packages: ['t'] } }));
      await h.run(command('subscribe', { owner: 'new' }));
      expect(h.followUp()).toBe(en.subscribeLimitChannel(MAX_SUBSCRIPTIONS_PER_CHANNEL));
      expect(stored(h)).toHaveLength(MAX_SUBSCRIPTIONS_PER_CHANNEL);
    });

    it('still accepts the last one under the channel limit', async () => {
      const h = harness();
      for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CHANNEL - 1; i++) h.store.addSubscription(subscription({ id: `s${i}`, filter: { packages: [`o${i}`] } }));
      await h.run(command('subscribe', { owner: 'new' }));
      expect(stored(h)).toHaveLength(MAX_SUBSCRIPTIONS_PER_CHANNEL);
    });

    it(`refuses the ${MAX_SUBSCRIPTIONS_PER_GUILD + 1}th subscription of a server`, async () => {
      const h = harness();
      for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_GUILD; i++) h.store.addSubscription(subscription({ id: `s${i}`, channelId: String(100 + Math.floor(i / 5)) }));
      await h.run(command('subscribe', { owner: 'new' }));
      expect(h.followUp()).toBe(en.subscribeLimitGuild(MAX_SUBSCRIPTIONS_PER_GUILD));
      expect(stored(h)).toHaveLength(MAX_SUBSCRIPTIONS_PER_GUILD);
    });

    it(`refuses the ${MAX_SUBSCRIPTIONS_TOTAL + 1}th subscription overall, however many servers hold them`, async () => {
      const h = harness();
      for (let i = 0; i < MAX_SUBSCRIPTIONS_TOTAL; i++) {
        h.store.addSubscription(subscription({ id: `s${i}`, guildId: String(1000 + Math.floor(i / 10)), channelId: String(2000 + Math.floor(i / 5)) }));
      }
      await h.run(command('subscribe', { owner: 'new' }));
      expect(h.followUp()).toBe(en.subscribeLimitTotal(MAX_SUBSCRIPTIONS_TOTAL));
      expect(stored(h)).toHaveLength(MAX_SUBSCRIPTIONS_TOTAL);
    });
  });

  it('answers in the configured language', async () => {
    const h = harness({ messages: ru });
    expect((await h.run(command('subscribe', {}))).data?.content).toBe(ru.subscribeNeedsFilter);
    await h.run(command('subscribe', { owner: 'a' }));
    expect(h.followUp().startsWith('Подписка создана: a в')).toBe(true);
  });

  it('fails visibly and stores nothing when the generated id is malformed', async () => {
    const h = harness({ ids: ['bad id!'] });
    await h.run(command('subscribe', { owner: 'a' }));
    expect(h.followUp()).toBe(en.somethingWrong);
    expect(stored(h)).toEqual([]);
  });

  it('generates ids that match the subscription id pattern', async () => {
    const { randomSubscriptionId } = await import('./deps.ts');
    for (let i = 0; i < 50; i++) expect(randomSubscriptionId()).toMatch(SUBSCRIPTION_ID_RE);
  });

  it('never throws and only stores filters the validator accepts, whatever the options hold (property)', async () => {
    const text = fc.option(fc.string({ maxLength: 160 }), { nil: undefined });
    await fc.assert(
      fc.asyncProperty(
        fc.record({ owner: text, mod: text, category: text, label: text, source: fc.option(fc.constantFrom('thunderstore', 'hexium', 'nexus', 'x'), { nil: undefined }), kind: text, mode: text }),
        fc.option(fc.integer({ min: -10, max: 2000 }), { nil: undefined }),
        async (strings, interval) => {
          const h = harness();
          const options: Record<string, string | number> = {};
          for (const [key, value] of Object.entries(strings)) if (value !== undefined) options[key] = value;
          if (interval !== undefined) options.interval = interval;
          await h.run(command('subscribe', options));
          for (const sub of stored(h)) {
            expect(validateSubscriptionFilter(sub.filter).ok).toBe(true);
            expect(sub.label!.length).toBeLessThanOrEqual(SUBSCRIPTION_LABEL_MAX);
            expect(sub.id).toMatch(SUBSCRIPTION_ID_RE);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('/subscribe autocomplete', () => {
  const seeded = () => {
    const h = harness();
    h.store.seedPackages('thunderstore:valheim', { 'RandyKnapp-EpicLoot': '1.0.0', 'RandyKnapp-Other': '1.0.0', 'Ramp-Thing': '1.0.0', 'Zed-Epic': '1.0.0' });
    h.store.seedPackages('hexium:valheim', { 'RandyKnapp-EpicLoot': '1.0.0' });
    return h;
  };

  it('suggests owners from two characters on, by prefix', async () => {
    const h = seeded();
    expect((await h.run(autocompleteOf('subscribe', 'owner', 'ra'))).data?.choices).toEqual([
      { name: 'Ramp', value: 'Ramp' },
      { name: 'RandyKnapp', value: 'RandyKnapp' },
    ]);
    expect((await h.run(autocompleteOf('subscribe', 'owner', 'r'))).data?.choices).toEqual([]);
  });

  it('suggests mods by name prefix with the owner shown, one choice per package id', async () => {
    const h = seeded();
    expect((await h.run(autocompleteOf('subscribe', 'mod', 'epic'))).data?.choices).toEqual([
      { name: 'Epic (Zed)', value: 'Zed-Epic' },
      { name: 'EpicLoot (RandyKnapp)', value: 'RandyKnapp-EpicLoot' },
    ]);
  });

  it('returns at most 25 choices', async () => {
    const h = harness();
    h.store.seedPackages('thunderstore:valheim', Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Owner${String(i).padStart(2, '0')}-Mod`, '1.0.0'])));
    expect((await h.run(autocompleteOf('subscribe', 'owner', 'ow'))).data?.choices).toHaveLength(AUTOCOMPLETE_MAX_RESULTS);
  });

  it('suggests nothing to someone without Manage Channel', async () => {
    const h = seeded();
    const member = { permissions: '0', user: { id: USER_ID } };
    expect((await h.run(autocompleteOf('subscribe', 'owner', 'ra', { member }))).data?.choices).toEqual([]);
    expect((await h.run(autocompleteOf('subscribe', 'mod', 'epic', { member }))).data?.choices).toEqual([]);
  });

  it('suggests nothing for other options', async () => {
    const h = seeded();
    expect((await h.run(autocompleteOf('subscribe', 'category', 'to'))).data?.choices).toEqual([]);
  });
});

describe('canonicalFilter', () => {
  it('ignores key and list order', () => {
    expect(canonicalFilter({ packages: ['b', 'a'], kinds: ['new'] })).toBe(canonicalFilter({ kinds: ['new'], packages: ['a', 'b'] }));
    expect(canonicalFilter({ packages: ['a'] })).not.toBe(canonicalFilter({ includeCategories: ['a'] }));
  });
});

describe('a thread invocation', () => {
  it('checks the bot permissions of the thread payload', async () => {
    const h = harness();
    const response = await h.run(interaction({ channel: inThread().channel, data: { name: 'subscribe', options: [{ name: 'owner', type: 3, value: 'a' }] }, app_permissions: '0' }));
    expect(response.data?.content).toContain('I am missing permissions');
  });
});
