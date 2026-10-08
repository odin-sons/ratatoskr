// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DISCORD } from '../../core/constants.ts';
import type { DiscordContainer, DiscordMessage, DiscordSeparator, ModEvent } from '../../core/types.ts';
import { makeEvent } from '../../testing/fakes.ts';
import { buildActionRow } from '../components.ts';
import { makeCtx, type Ctx, type RenderSettings } from '../context.ts';
import { buildParts } from '../detailed.ts';
import { SECTION_EMOJI, sourceSubtext } from '../layout.ts';
import { assertWithinLimits } from '../limits.ts';
import { renderEvent } from './build.ts';
import { parseTemplate } from './parse.ts';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const ctxOf = (over: RenderSettings = {}): Ctx => makeCtx(over);

type Child = DiscordContainer['components'][number];

const container = (message: DiscordMessage): DiscordContainer => message.components![0] as DiscordContainer;
const texts = (message: DiscordMessage): string[] =>
  container(message).components.flatMap((child) => (child.type === 10 ? [child.content] : child.type === 9 ? child.components.map((c) => c.content) : []));
const render = (template: string | null, event: ModEvent, ctx: Ctx = ctxOf()) => renderEvent(template === null ? null : parseTemplate(template), event, NOW, ctx);

const rich = (over: Partial<ModEvent['pkg']> = {}, eventOver: Partial<ModEvent> = {}): ModEvent =>
  makeEvent({
    kind: 'update',
    versionFrom: '1.0.0',
    versionTo: '1.1.0',
    changelog: '- fixed the sword\n- added a shield\n- reworked the bow\n- removed the axe\n- tuned the helm',
    changelogUrl: 'https://example.com/changes',
    pkg: { owner: 'Bob', name: 'Warfare', description: 'Does many things in the world of Valheim.', categories: ['Tools', 'Misc'], iconUrl: 'https://example.com/icon.png', ...over },
    ...eventOver,
  });

/** The immediate message as it was built before templates existed, kept here to prove the default template changes nothing. */
function legacyImmediate(event: ModEvent, now: Date, ctx: Ctx): DiscordMessage {
  const parts = buildParts(event, now, ctx);
  const separator: DiscordSeparator = { type: 14, divider: true, spacing: 1 };
  const header = { type: 10 as const, content: parts.header };
  const blocks: Child[] = [parts.icon === null ? header : { type: 9, components: [header], accessory: { type: 11, media: { url: parts.icon } } }];
  const push = (block: Child): void => {
    blocks.push({ ...separator }, block);
  };
  if (parts.changelog !== null) push({ type: 10, content: `**${ctx.messages.changelog}**\n${parts.changelog}` });
  if (parts.categories !== null) push({ type: 10, content: `**${SECTION_EMOJI.categories} ${ctx.messages.categories}**\n${parts.categories}` });
  const row = buildActionRow(event, ctx);
  if (row !== null) push(row);
  return { flags: DISCORD.componentsV2Flag, allowed_mentions: { parse: [] }, components: [{ type: 17, accent_color: parts.color, components: blocks }, sourceSubtext(ctx.ratatoskrEmoji)] };
}

describe('the default template', () => {
  const events: [string, ModEvent][] = [
    ['an update with everything', rich({ downloadUrl: 'https://example.com/dl', websiteUrl: 'https://example.com/site', sizeBytes: 2_500_000, downloads: 1234, likes: 5 })],
    ['a new mod', rich({}, { kind: 'new', versionFrom: null, changelog: null })],
    ['a mod without icon, description and categories', rich({ iconUrl: null, description: '', categories: [] })],
    ['a mod without a page, owner or changelog', rich({ url: '', owner: '' }, { changelog: null, changelogUrl: null })],
    ['a mod from another store with an also-on line', rich({}, { alsoOn: [{ store: 'hexium', url: 'https://hexium.example/p' }] })],
    ['hostile text', rich({ name: '@everyone __x__ [a](b) `c`', owner: '<@123> *y*', description: '# head\n@here' }, { changelog: '@everyone\n[Full changelog](https://evil.example)' })],
  ];

  it.each(events)('renders %s exactly as before', (_label, event) => {
    for (const settings of [{}, { optionalButtons: false }, { includeChangelog: false }, { locale: 'ru' as const }, { storeEmojis: { thunderstore: '<:ts:123456789012345678>' } }]) {
      const ctx = ctxOf(settings);
      expect(render(null, event, ctx).message).toEqual(legacyImmediate(event, NOW, ctx));
    }
  });
});

describe('a custom template', () => {
  it('lays out the text it is given and nothing else', () => {
    const { message, step, fellBack } = render('{name:link} {versions}\n---\n{owner}', rich({ url: 'https://example.com/mod' }));
    expect(texts(message)).toEqual(['[Warfare](https://example.com/mod) 1.0.0 → 1.1.0', 'Bob']);
    expect(container(message).components.map((c) => c.type)).toEqual([10, 14, 10]);
    expect(step).toBe(0);
    expect(fellBack).toBe(false);
  });

  it('always ends with the source notice and never allows mentions', () => {
    const { message } = render('{name}', rich());
    expect(message.components!.at(-1)).toEqual(sourceSubtext(null));
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.flags).toBe(DISCORD.componentsV2Flag);
  });

  it('makes the changelog short, medium or full and cuts it to the limits written next to it', () => {
    const event = rich({}, { changelog: Array.from({ length: 40 }, (_, i) => `- change number ${i} with some words`).join('\n') });
    const length = (template: string): number => texts(render(template, event).message)[0]!.length;
    expect(length('{changelog:short}')).toBeLessThanOrEqual(150);
    expect(length('{changelog:medium}')).toBeLessThanOrEqual(500);
    expect(length('{changelog:full}')).toBeLessThanOrEqual(1000);
    expect(length('{changelog:full}')).toBeGreaterThan(length('{changelog:medium}'));
    expect(length('{changelog}')).toBe(length('{changelog:medium}'));
    expect(length('{changelog:full:300}')).toBeLessThanOrEqual(300);
    expect(texts(render('{changelog:medium:l3}', event).message)[0]!.split('\n').length).toBeLessThanOrEqual(3);
  });

  it('ignores a form the variable does not have and takes the other arguments anyway', () => {
    const event = rich();
    expect(texts(render('{owner:nonsense}', event).message)).toEqual(['Bob']);
    expect(texts(render('{changelog:nonsense:l2}', event).message)).toEqual(texts(render('{changelog:l2}', event).message));
  });

  it('treats an unknown variable as empty, which drops its line', () => {
    expect(texts(render('{nothing}\nkept {nothing}\n---\nplain', rich()).message)).toEqual(['plain']);
  });

  it('keeps a line without variables and drops a line whose variables are all empty', () => {
    const event = rich({}, { changelog: null });
    expect(texts(render('top\n{changelog}\n{owner}', event).message)).toEqual(['top\nBob']);
  });

  it('drops a block that shows none of its variables, with its divider', () => {
    const event = rich({}, { changelog: null });
    const { message } = render('{owner}\n---\n**Changelog**\n{changelog}\n---\n{versions}', event);
    expect(texts(message)).toEqual(['Bob', '1.0.0 → 1.1.0']);
    expect(container(message).components.map((c) => c.type)).toEqual([10, 14, 10]);
  });

  it('drops an optional part with the value it belongs to', () => {
    expect(texts(render('{name}(? by {owner}?)(? [{size}]?)', rich({ sizeBytes: null })).message)).toEqual(['Warfare by Bob']);
    expect(texts(render('{name}(? by {owner}?)', rich({ owner: '' })).message)).toEqual(['Warfare']);
  });

  it('prints literal braces for {{ and }}', () => {
    expect(texts(render('{{name}} is {name}', rich()).message)).toEqual(['{name} is Warfare']);
  });

  it('puts a row of buttons where the template says and leaves out buttons that have no link', () => {
    const event = rich({ url: 'https://example.com/mod', downloadUrl: 'https://example.com/dl' });
    const row = container(render('{owner}\n---\n{page_button} {download_button}', event).message).components.at(-1);
    expect(row).toMatchObject({ type: 1 });
    expect((row as { components: unknown[] }).components).toHaveLength(2);
    const none = render('{owner}\n---\n{website_button}', event).message;
    expect(texts(none)).toEqual(['Bob']);
    expect(container(none).components.map((c) => c.type)).toEqual([10]);
  });

  it('leaves the optional buttons out when the context asks, as in the retry after a 400', () => {
    const event = rich({ url: 'https://example.com/mod', downloadUrl: 'https://example.com/dl', websiteUrl: 'https://example.com/site' });
    const row = container(render('{buttons}', event, ctxOf({ optionalButtons: false })).message).components.at(-1) as { components: unknown[] };
    expect(row.components).toHaveLength(1);
  });

  it('attaches the thumbnail to the block that has the marker, when the mod has an icon', () => {
    const withIcon = container(render('{icon}{name}\n---\n{owner}', rich()).message).components;
    expect(withIcon[0]).toMatchObject({ type: 9, accessory: { type: 11 } });
    const without = container(render('{icon}{name}', rich({ iconUrl: null })).message).components;
    expect(without[0]).toMatchObject({ type: 10 });
  });

  it('never lets a name, an owner or a changelog bring a mention or a raw link into the message', () => {
    const event = rich({ name: '@everyone <@&123> [x](https://evil.example)', owner: '@here' }, { changelog: '@everyone and <@1>' });
    const out = texts(render('{name} {owner} {changelog}', event).message).join('\n');
    expect(out).not.toMatch(new RegExp(`(^|[^${String.fromCharCode(0x200b)}])@everyone`));
    expect(out).not.toContain('<@&123>');
    expect(out).not.toContain('<@1>');
    expect(out).not.toContain('](https://evil.example)');
  });
});

describe('degradation', () => {
  const longChangelog = Array.from({ length: 80 }, (_, i) => `- change number ${i} with a few words in it`).join('\n');
  const event = rich({ description: 'word '.repeat(300) }, { changelog: longChangelog });

  it('goes to the medium forms when the message is too long as written', () => {
    const template = `${'{changelog:full}\n---\n'.repeat(5)}{owner}`;
    const asWritten = renderEvent(parseTemplate(template), event, NOW, ctxOf());
    expect(asWritten.step).toBe(1);
    expect(assertWithinLimits(asWritten.message)).toEqual([]);
  });

  it('goes to the short forms when medium is still too long', () => {
    const template = `${'{changelog:full}\n---\n'.repeat(9)}{owner}`;
    const result = renderEvent(parseTemplate(template), event, NOW, ctxOf());
    expect(result.step).toBe(2);
    expect(assertWithinLimits(result.message)).toEqual([]);
  });

  it('drops the optional values when even the short forms are too long', () => {
    const template = `${'{description:full}\n{changelog:full}\n---\n'.repeat(16)}{owner}`;
    const result = renderEvent(parseTemplate(template), event, NOW, ctxOf());
    expect(result.step).toBe(3);
    expect(texts(result.message)).toEqual(['Bob']);
  });

  it('falls back to the default template when nothing fits or nothing is shown', () => {
    const tooMany = renderEvent(parseTemplate(`${'{name}\n---\n'.repeat(30)}x`), event, NOW, ctxOf());
    expect(tooMany.fellBack).toBe(true);
    expect(tooMany.message).toEqual(legacyImmediate(event, NOW, ctxOf()));
    const empty = renderEvent(parseTemplate('{nothing}'), event, NOW, ctxOf());
    expect(empty.fellBack).toBe(true);
    expect(renderEvent(parseTemplate(''), event, NOW, ctxOf()).fellBack).toBe(true);
  });
});

describe('any template', () => {
  const pieces = ['{name:link}', '{versions}', '{changelog:full}', '{changelog:short:l2}', '{description:full:50}', '{categories}', '{owner}', '{icon}', '{buttons}', '{info_button}', '{nothing}', '(?', '?)', '---', '\n', ' · ', '{{', '}}', 'text', '{title}', '{kind_line}', '{info_line}', '{also_on}'];

  it('always renders a message within the Discord limits, whatever is written', () => {
    const event = rich({ url: 'https://example.com/mod', downloadUrl: 'https://example.com/dl', sizeBytes: 123456 }, { alsoOn: [{ store: 'hexium', url: 'https://hexium.example/p' }] });
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...pieces), { maxLength: 120 }), (list) => {
        const { message } = renderEvent(parseTemplate(list.join('')), event, NOW, ctxOf());
        expect(assertWithinLimits(message)).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });

  it('never throws on random text either', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2500 }), (source) => {
        expect(() => renderEvent(parseTemplate(source), rich(), NOW, ctxOf())).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });
});

describe('the Info button', () => {
  const lastRow = (message: DiscordMessage) => container(message).components.at(-1) as { type: number; components: { label: string; custom_id?: string; url?: string }[] };
  const event = rich({ url: 'https://example.com/mod' });

  it('is the last button of the default message of a bot, and only there', () => {
    const asBot = lastRow(render(null, event, ctxOf({ infoButton: true })).message);
    expect(asBot.components.at(-1)).toMatchObject({ type: 2, style: 2, label: 'Info', custom_id: `info:${event.pkg.source}:${event.pkg.packageId}` });
    const asWebhook = lastRow(render(null, event, ctxOf()).message);
    expect(asWebhook.components.every((button) => button.url !== undefined)).toBe(true);
  });

  it('stays when the optional buttons are left out, and is localized', () => {
    const reduced = lastRow(render(null, event, ctxOf({ infoButton: true, optionalButtons: false })).message);
    expect(reduced.components.map((button) => button.label)).toEqual(['Mod page', 'Info']);
    expect(lastRow(render(null, event, ctxOf({ infoButton: true, locale: 'ru' })).message).components.at(-1)!.label).toBe('Инфо');
  });

  it('can be placed anywhere by a template, and is left out when the mod id is too long for a custom_id', () => {
    const custom = lastRow(render('{owner}\n---\n{info_button}', event, ctxOf({ infoButton: true })).message);
    expect(custom.components).toHaveLength(1);
    const long = rich({ packageId: `Owner-${'x'.repeat(120)}`, url: 'https://example.com/mod' });
    const row = lastRow(render(null, long, ctxOf({ infoButton: true })).message);
    expect(row.components.some((button) => button.custom_id !== undefined)).toBe(false);
    expect(assertWithinLimits(render(null, long, ctxOf({ infoButton: true })).message)).toEqual([]);
  });

  it('is not part of a message from a template without {info_button} or when the context says no', () => {
    const none = render('{owner}\n---\n{buttons}', event, ctxOf({ infoButton: true })).message;
    expect(lastRow(none).components.some((button) => button.custom_id !== undefined)).toBe(false);
  });
});
