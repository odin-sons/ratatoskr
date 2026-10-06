// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DISCORD } from '../../core/constants.ts';
import { en } from '../../i18n/en.ts';
import { ru } from '../../i18n/ru.ts';
import { component, CHANNEL_ID, command, GUILD_ID, harness, type Harness, inThread, PARENT_ID, subscription, THREAD_ID, USER_ID } from './harness.ts';
import { paginate } from './list.ts';

const content = (response: { data?: Record<string, unknown> }): string => String(response.data?.content);

describe('/list', () => {
  it('answers inline and ephemerally with label, id, mode, interval, thread flag, destination and filter', async () => {
    const h = harness();
    h.store.addSubscription(
      subscription({ id: 'a1', label: 'Epic loot', mode: 'digest', digestIntervalMin: 45, filter: { packages: ['RandyKnapp'], includeCategories: ['Tools'], sources: ['hexium:valheim'], kinds: ['new'] } }),
    );
    h.store.addSubscription(subscription({ id: 'b2', label: 'Per mod', mode: 'immediate', threadPerMod: true, filter: {} }));
    const response = await h.run(command('list'));
    expect(response.type).toBe(4);
    expect(response.data?.flags).toBe(64);
    expect(content(response)).toBe(
      [
        'Subscriptions here',
        `**Epic loot** \`a1\` · digest every 45 min · <#${CHANNEL_ID}> · mods or owners RandyKnapp, categories Tools, sources hexium:valheim, new only`,
        `**Per mod** \`b2\` · immediate · thread per mod · <#${CHANNEL_ID}> · everything`,
      ].join('\n'),
    );
    expect(h.finished).toEqual([]);
  });

  it('shows only this channel by default, and the whole server, webhooks included, with all', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'here', label: 'Here' }));
    h.store.addSubscription(subscription({ id: 'there', label: 'There', channelId: PARENT_ID }));
    h.store.addSubscription(subscription({ id: 'foreign', label: 'Foreign', guildId: '999999999999999999' }));
    h.store.addSubscription({ ...subscription({ id: 'hook', label: 'Hook' }), transport: 'webhook', channelId: null, webhookUrl: 'https://discord.com/api/webhooks/1/x' });
    const here = content(await h.run(command('list')));
    expect(here).toContain('Here');
    expect(here).not.toContain('There');
    const all = content(await h.run(command('list', { all: true })));
    expect(all.startsWith('Subscriptions in this server\n')).toBe(true);
    expect(all).toContain('**Here**');
    expect(all).toContain(`**There** \`there\` · digest every 30 min · <#${PARENT_ID}>`);
    expect(all).toContain('**Hook** `hook` · digest every 30 min · webhook');
    expect(all).not.toContain('Foreign');
  });

  it('shows a subscription of a thread at the thread destination', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 't', label: 'T', threadId: THREAD_ID }));
    expect(content(await h.run(command('list')))).toContain(`<#${THREAD_ID}>`);
  });

  it('in a thread shows the thread own and its parent channel ones only', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'parent', label: 'Parent' }));
    h.store.addSubscription(subscription({ id: 'mine', label: 'Mine', threadId: THREAD_ID }));
    h.store.addSubscription(subscription({ id: 'sibling', label: 'Sibling', threadId: PARENT_ID }));
    const text = content(await h.run(command('list', {}, { channel: inThread().channel })));
    expect(text).toContain('**Parent**');
    expect(text).toContain('**Mine**');
    expect(text).not.toContain('Sibling');
  });

  it('says so when there is nothing to list', async () => {
    const h = harness();
    expect(content(await h.run(command('list')))).toBe(`${en.listChannelTitle}\n${en.listEmpty}`);
    expect(content(await h.run(command('list', { all: true })))).toBe(`${en.listGuildTitle}\n${en.listEmpty}`);
  });

  it('escapes labels and filter values, and shows no ping', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'x', label: '*@everyone* <@123>', filter: { packages: ['_a_'] } }));
    const text = content(await h.run(command('list')));
    expect(text).toContain('\\*@\u200beveryone\\*');
    expect(text).not.toContain('<@123>');
    expect(text).toContain('\\_a\\_');
  });

  it('needs Manage Channel, and is guild only', async () => {
    const h = harness();
    h.store.addSubscription(subscription());
    expect((await h.run(command('list', {}, { member: { permissions: '0', user: { id: USER_ID } } }))).data?.content).toBe(en.missingManageChannel);
    expect((await h.run(command('list', {}, { guild_id: undefined }))).data?.content).toBe(en.guildOnly);
  });

  it('speaks the configured language', async () => {
    const h = harness({ messages: ru });
    h.store.addSubscription(subscription({ id: 'a', label: 'A', mode: 'immediate', threadPerMod: true }));
    expect(content(await h.run(command('list')))).toBe(`${ru.listChannelTitle}\n**A** \`a\` · сразу · ветка на мод · <#${CHANNEL_ID}> · всё`);
  });
});

describe('/list paging', () => {
  const many = (h: Harness, count = 40) => {
    for (let i = 0; i < count; i++) {
      h.store.addSubscription(subscription({ id: `sub-${String(i).padStart(3, '0')}`, label: `Subscription number ${String(i).padStart(3, '0')}`, filter: { packages: [`Owner${i}`], includeCategories: ['Tools'] } }));
    }
  };

  const buttons = (response: { data?: Record<string, unknown> }): { label: string; custom_id: string; disabled: boolean }[] =>
    ((response.data?.components as { components: never[] }[] | undefined)?.[0]?.components ?? []) as never;

  it('splits a long listing into pages within the message limit, with a counter and buttons', async () => {
    const h = harness();
    many(h);
    const first = await h.run(command('list'));
    expect(content(first).length).toBeLessThanOrEqual(DISCORD.contentMax);
    expect(content(first)).toMatch(/\n\(1\/\d+\)$/);
    expect(content(first)).toContain('sub-000');
    const [previous, next] = buttons(first);
    expect(previous).toMatchObject({ label: 'Previous', custom_id: 'list:c:-1', disabled: true });
    expect(next).toMatchObject({ label: 'Next', custom_id: 'list:c:1', disabled: false });
  });

  it('shows every subscription exactly once across the pages, in order', async () => {
    const h = harness();
    many(h);
    const seen: string[] = [];
    let customId: string | undefined = 'list:c:0';
    let first = true;
    while (customId !== undefined) {
      const response = first ? await h.run(command('list')) : await h.run(component(customId));
      if (!first) expect(response.type).toBe(7);
      first = false;
      expect(content(response).length).toBeLessThanOrEqual(DISCORD.contentMax);
      seen.push(...[...content(response).matchAll(/`(sub-\d+)`/g)].map((m) => m[1]!));
      const [, next] = buttons(response);
      customId = next?.disabled === false ? next.custom_id : undefined;
    }
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => `sub-${String(i).padStart(3, '0')}`));
  });

  it('serves a page from the signed payload, recomputing the listing, with no state kept', async () => {
    const h = harness();
    many(h);
    const response = await h.run(component('list:c:1'));
    expect(response.type).toBe(7);
    expect(content(response)).toMatch(/\n\(2\/\d+\)$/);
    expect(buttons(response)[0]).toMatchObject({ custom_id: 'list:c:0', disabled: false });
  });

  it('clears the buttons when the listing shrank to one page or to nothing', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'only' }));
    expect(await h.run(component('list:c:3'))).toMatchObject({ type: 7, data: { components: [] } });
    h.store.subscriptions.clear();
    expect(await h.run(component('list:c:0'))).toMatchObject({ type: 7, data: { components: [], content: `${en.listChannelTitle}
${en.listEmpty}` } });
  });

  it('clamps a page past the end to the last one', async () => {
    const h = harness();
    many(h);
    const response = await h.run(component('list:c:999'));
    expect(content(response)).toMatch(/\((\d+)\/\1\)$/);
    expect(buttons(response)[1]).toMatchObject({ disabled: true });
  });

  it('pages the whole-server scope with the g scope', async () => {
    const h = harness();
    many(h);
    h.store.addSubscription(subscription({ id: 'zz-other-channel', label: 'zz other', channelId: PARENT_ID }));
    const first = await h.run(command('list', { all: true }));
    expect(buttons(first)[1]!.custom_id).toBe('list:g:1');
    const last = await h.run(component('list:g:999'));
    expect(content(last)).toContain('zz-other-channel');
  });

  it('checks the clicker: Manage Channel, the guild and the channel come from the payload', async () => {
    const h = harness();
    many(h);
    h.store.addSubscription(subscription({ id: 'foreign-guild', label: 'AAA foreign', guildId: '999999999999999999', channelId: PARENT_ID }));
    expect((await h.run(component('list:c:0', { member: { permissions: '0', user: { id: USER_ID } } }))).data?.content).toBe(en.missingManageChannel);
    expect((await h.run(component('list:g:0', { guild_id: undefined }))).data?.content).toBe(en.guildOnly);
    const channelScope = content(await h.run(component('list:c:0', { channel: { id: PARENT_ID, type: 0 } })));
    expect(channelScope).not.toContain('sub-000');
    expect(channelScope).not.toContain('foreign-guild');
    const guildScope = content(await h.run(component('list:g:0')));
    expect(guildScope).not.toContain('foreign-guild');
    expect(GUILD_ID).not.toBe('999999999999999999');
  });

  it.each(['list', 'list:c', 'list:x:1', 'list:c:-1', 'list:c:1.5', 'list:c:abc', 'list:c:1:2', 'list:c:99999'])('rejects the custom id %s', async (customId) => {
    const h = harness();
    many(h);
    const response = await h.run(component(customId));
    expect(response.type).toBe(4);
    expect(response.data?.content).toBe(en.unknownCommand);
  });
});

describe('paginate', () => {
  it('keeps every line, in order, and every page within the limit (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 300 }), { maxLength: 60 }), fc.integer({ min: 50, max: 2000 }), (lines, limit) => {
        const pages = paginate(lines, limit);
        for (const page of pages) expect(page.join('\n').length).toBeLessThanOrEqual(limit);
        expect(pages.flat().map((l) => l.length)).toEqual(lines.map((l) => Math.min(l.length, limit)));
      }),
    );
  });
});
