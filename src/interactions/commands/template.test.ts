// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TEMPLATE_MAX_CHARS } from '../../core/constants.ts';
import { en } from '../../i18n/en.ts';
import { ru } from '../../i18n/ru.ts';
import { DEFAULT_DIGEST_LINE_SOURCE, defaultImmediateSource } from '../../render/template/defaults.ts';
import { makeEvent } from '../../testing/fakes.ts';
import { command, harness, interaction, NOW, PARENT_ID, subscription, USER_ID, type Harness } from './harness.ts';

const denied = { member: { permissions: '0', user: { id: USER_ID } } };

function seed(h: Harness): void {
  h.store.addSubscription(subscription({ id: 'kg', label: 'KG', filter: { packages: ['KG'] } }));
  h.store.addSubscription(subscription({ id: 'elsewhere', label: 'Elsewhere', channelId: PARENT_ID }));
  h.store.addSubscription(subscription({ id: 'foreign', label: 'Foreign', guildId: '999999999999999999' }));
}

const submit = (customId: string, value: unknown, over: Record<string, unknown> = {}) =>
  interaction({ type: 5, data: { custom_id: customId, components: [{ type: 1, components: [{ type: 4, custom_id: 'body', value }] }] }, ...over });

const text = (response: { data?: Record<string, unknown> }): string => JSON.stringify(response.data);
const stored = (h: Harness) => h.store.getTemplates(['kg', 'elsewhere', 'foreign']);

async function seedMod(h: Harness, owner = 'Bob', name = 'Warfare'): Promise<string> {
  const event = makeEvent({ kind: 'update', versionFrom: '1.0.0', versionTo: '2.0.0', pkg: { owner, name, packageId: `${owner}-${name}` } });
  await h.store.commit({
    source: event.pkg.source,
    packages: [event.pkg],
    events: [event],
    outbox: [],
    state: { id: event.pkg.source, cursor: null, etag: null, bootstrapped: true, lastOkAt: null },
  });
  return event.pkg.packageId;
}

describe('/template edit', () => {
  it('opens a modal with the default template of the message and a limit of 2000 characters', async () => {
    const h = harness();
    seed(h);
    const response = await h.run(command('template', { subscription: 'kg', action: 'edit' }));
    expect(response.type).toBe(9);
    expect(response.data).toMatchObject({ custom_id: 'template:kg:immediate', title: en.templateModalTitle(en.templateKindMessage) });
    const input = ((response.data?.components as { components: Record<string, unknown>[] }[])[0]!).components[0]!;
    expect(input).toMatchObject({ type: 4, custom_id: 'body', style: 2, min_length: 1, max_length: TEMPLATE_MAX_CHARS, required: true, value: defaultImmediateSource(en) });
    expect(defaultImmediateSource(en).length).toBeLessThan(TEMPLATE_MAX_CHARS);
  });

  it('prefills the saved template, and the default line for the digest line', async () => {
    const h = harness();
    seed(h);
    await h.store.setTemplate({ subscriptionId: 'kg', kind: 'immediate', body: 'custom {name}', updatedAt: NOW.toISOString() });
    const message = await h.run(command('template', { subscription: 'kg', action: 'edit' }));
    expect(text(message)).toContain('custom {name}');
    const line = await h.run(command('template', { subscription: 'kg', action: 'edit', target: 'digest_line' }));
    expect(line.data).toMatchObject({ custom_id: 'template:kg:digest_line' });
    expect(text(line)).toContain(DEFAULT_DIGEST_LINE_SOURCE.replaceAll('\\', '\\\\').replaceAll('"', '\\"'));
  });

  it('is for members who may manage the channel, about subscriptions of this place only', async () => {
    const h = harness();
    seed(h);
    expect((await h.run(command('template', { subscription: 'kg', action: 'edit' }, denied))).type).toBe(4);
    for (const id of ['elsewhere', 'foreign', 'nothing']) {
      const response = await h.run(command('template', { subscription: id, action: 'edit' }));
      expect(response).toMatchObject({ type: 4, data: { content: en.subscriptionNotFound, flags: 64 } });
    }
  });

  it('speaks the language of the deployment', async () => {
    const h = harness({ messages: ru });
    seed(h);
    const response = await h.run(command('template', { subscription: 'kg', action: 'edit' }));
    expect(response.data).toMatchObject({ title: ru.templateModalTitle(ru.templateKindMessage) });
    expect(text(response)).toContain('**Изменения**');
  });
});

describe('/template submit', () => {
  const id = 'template:kg:immediate';

  it('saves the template and shows how the message looks, with the notes', async () => {
    const h = harness();
    seed(h);
    const response = await h.run(submit(id, '{name:link} {versions}\n---\n{buttons}'));
    expect(response).toMatchObject({ type: 4, data: { flags: 64 | 32768 } });
    expect(await h.store.getTemplates(['kg'])).toEqual([{ subscriptionId: 'kg', kind: 'immediate', body: '{name:link} {versions}\n---\n{buttons}', updatedAt: NOW.toISOString() }]);
    expect(text(response)).toContain(en.templateSaved('KG', en.templateKindMessage));
    expect(text(response)).toContain(en.templateNoNotes);
    expect(text(response)).toContain('Example Mod');
  });

  it('saves a template even with notes, and lists them', async () => {
    const h = harness();
    seed(h);
    const response = await h.run(submit(id, '{owner} {nothing} {changelog:tiny}'));
    expect(await h.store.getTemplates(['kg'])).toHaveLength(1);
    expect(text(response)).toContain(en.warnUnknownVariable('nothing'));
    expect(text(response)).toContain(JSON.stringify(en.warnIgnoredForm('changelog', 'tiny')).slice(1, -1));
    expect(text(response)).toContain(en.warnNoModLink);
  });

  it('says so when the template shows nothing and the default message is used instead', async () => {
    const h = harness();
    seed(h);
    const response = await h.run(submit(id, '{nothing}'));
    expect(text(response)).toContain(en.warnFellBack);
    expect(text(response)).toContain('Example Mod');
  });

  it('saves and previews the line of a digest, and tells which variables a line does not have', async () => {
    const h = harness();
    seed(h);
    const response = await h.run(submit('template:kg:digest_line', '{name} => {version} {changelog}'));
    expect((await h.store.getTemplates(['kg']))[0]).toMatchObject({ kind: 'digest_line', body: '{name} => {version} {changelog}' });
    expect(text(response)).toContain('Example Mod => 1.3.0');
    expect(text(response)).toContain(en.warnUnavailableInLine('changelog'));
  });

  it('replaces the template of the same subscription and kind', async () => {
    const h = harness();
    seed(h);
    await h.run(submit(id, 'first {name}'));
    await h.run(submit(id, 'second {name}'));
    expect(await h.store.getTemplates(['kg'])).toMatchObject([{ body: 'second {name}' }]);
  });

  it.each([
    ['an empty template', ''],
    ['a template of blanks', '  \n \n'],
    ['no field at all', undefined],
  ])('refuses %s and keeps the old one', async (_label, value) => {
    const h = harness();
    seed(h);
    await h.store.setTemplate({ subscriptionId: 'kg', kind: 'immediate', body: 'old {name}', updatedAt: NOW.toISOString() });
    const response = await h.run(value === undefined ? interaction({ type: 5, data: { custom_id: id, components: [] } }) : submit(id, value));
    expect(response.data).toMatchObject({ content: en.templateEmptyBody, flags: 64 });
    expect(await h.store.getTemplates(['kg'])).toMatchObject([{ body: 'old {name}' }]);
  });

  it('refuses a template over the limit', async () => {
    const h = harness();
    seed(h);
    const response = await h.run(submit(id, 'x'.repeat(TEMPLATE_MAX_CHARS + 1)));
    expect(response.data).toMatchObject({ content: en.templateTooLong(TEMPLATE_MAX_CHARS) });
    expect(await stored(h)).toEqual([]);
  });

  it('checks the permission and the subscription again, whatever the custom_id says', async () => {
    const h = harness();
    seed(h);
    expect((await h.run(submit(id, '{name}', denied))).data?.flags).toBe(64);
    for (const forged of ['template:foreign:immediate', 'template:elsewhere:immediate', 'template:nothing:immediate']) {
      expect((await h.run(submit(forged, '{name}'))).data).toMatchObject({ content: en.subscriptionNotFound });
    }
    expect(await stored(h)).toEqual([]);
  });

  it.each(['template', 'template:kg', 'template:kg:other', 'template:bad id:immediate', 'template::immediate'])('answers %j with the generic message and stores nothing', async (customId) => {
    const h = harness();
    seed(h);
    expect((await h.run(submit(customId, '{name}'))).data).toMatchObject({ content: en.unknownCommand });
    expect(await stored(h)).toEqual([]);
  });
});

describe('/template show, reset and preview', () => {
  it('shows the default and the saved template, whose backticks cannot close the code block', async () => {
    const h = harness();
    seed(h);
    expect(text(await h.run(command('template', { subscription: 'kg', action: 'show' })))).toContain(en.templateShowDefault('KG', en.templateKindMessage));
    await h.store.setTemplate({ subscriptionId: 'kg', kind: 'immediate', body: 'a ``` b {name}', updatedAt: NOW.toISOString() });
    const shown = (await h.run(command('template', { subscription: 'kg', action: 'show' }))).data?.content as string;
    expect(shown).toContain(en.templateShowCurrent('KG', en.templateKindMessage));
    expect(shown.split('```')).toHaveLength(3);
  });

  it('resets one kind of one subscription and says when there was nothing to reset', async () => {
    const h = harness();
    seed(h);
    await h.store.setTemplate({ subscriptionId: 'kg', kind: 'immediate', body: 'a {name}', updatedAt: NOW.toISOString() });
    await h.store.setTemplate({ subscriptionId: 'kg', kind: 'digest_line', body: 'b {name}', updatedAt: NOW.toISOString() });
    expect((await h.run(command('template', { subscription: 'kg', action: 'reset' }))).data?.content).toBe(en.templateReset('KG', en.templateKindMessage));
    expect((await h.run(command('template', { subscription: 'kg', action: 'reset' }))).data?.content).toBe(en.templateNothingToReset('KG', en.templateKindMessage));
    expect(await h.store.getTemplates(['kg'])).toMatchObject([{ kind: 'digest_line' }]);
  });

  it('previews the saved template with a sample, or with a real mod', async () => {
    const h = harness();
    seed(h);
    await h.store.setTemplate({ subscriptionId: 'kg', kind: 'immediate', body: '{name} by {owner}', updatedAt: NOW.toISOString() });
    const sample = await h.run(command('template', { subscription: 'kg', action: 'preview' }));
    expect(sample.data?.flags).toBe(64 | 32768);
    expect(text(sample)).toContain('Example Mod by Example');
    const mod = await seedMod(h);
    expect(text(await h.run(command('template', { subscription: 'kg', action: 'preview', mod })))).toContain('Warfare by Bob');
  });

  it('previews the default template when none is saved, without notes', async () => {
    const h = harness();
    seed(h);
    const response = await h.run(command('template', { subscription: 'kg', action: 'preview' }));
    expect(text(response)).toContain(en.templateNoNotes);
    expect(text(response)).toContain('Example Mod');
  });

  it('refuses an unknown action and anyone without the permission', async () => {
    const h = harness();
    seed(h);
    expect((await h.run(command('template', { subscription: 'kg', action: 'explode' }))).data).toMatchObject({ content: en.unknownCommand });
    expect((await h.run(command('template', { subscription: 'kg', action: 'reset' }, denied))).data?.flags).toBe(64);
    expect(await stored(h)).toEqual([]);
  });
});
