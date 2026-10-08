// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHANGELOG_DISPLAY_MAX, DISCORD, PROJECT } from '../core/constants.ts';
import type { DiscordContainer, DiscordLinkButton, DiscordMessage, DiscordSection, EventKind, StoreKind } from '../core/types.ts';
import { makeEvent, NOW, unixSeconds } from './__fixtures__/events.ts';
import { renderImmediate } from './index.ts';
import { KIND_EMOJI } from './layout.ts';
import { assertWithinLimits, componentCount, componentText } from './limits.ts';

const TS_EMOJI = '<:thunderstore:123456789012345678>';
const HX_EMOJI = '<:hexium:123456789012345679>';
const RT_EMOJI = '<a:ratatoskr:123456789012345680>';
const PAGE = 'https://thunderstore.io/c/valheim/p/Bob/Alpha/';
const DL = 'https://thunderstore.io/package/download/Bob/Alpha/1.2.4/';
const ICON = 'https://gcdn.thunderstore.io/live/repository/icons/x.png';
const UPDATED = '2026-09-19T11:30:00Z';
const CREATED = '2026-09-19T11:45:00Z';
const TIME = `<t:${unixSeconds(UPDATED)}:R>`;
const UPD = `${KIND_EMOJI.update} Updated by Bob`;
const SQUIRREL = '\u{1f43f}\ufe0f';
const STORE_LIST: StoreKind[] = ['thunderstore', 'hexium', 'nexus'];
const KIND_LIST: EventKind[] = ['new', 'update'];

type Over = Parameters<typeof makeEvent>[0];
const event = (over: Over = {}) => makeEvent({ name: 'Alpha', owner: 'Bob', url: PAGE, updatedAt: UPDATED, createdAt: CREATED, ...over });
const render = (over: Over = {}, extra: Parameters<typeof renderImmediate>[1] = { now: NOW }) => renderImmediate(event(over), extra);

const container = (msg: DiscordMessage): DiscordContainer => msg.components![0] as DiscordContainer;
const blocks = (msg: DiscordMessage) => container(msg).components;
const displayTexts = (msg: DiscordMessage): string[] =>
  blocks(msg).flatMap((b) => (b.type === 10 ? [b.content] : b.type === 9 ? b.components.map((t) => t.content) : []));
const headerText = (msg: DiscordMessage): string => displayTexts(msg)[0]!;
const headerLines = (msg: DiscordMessage): string[] => headerText(msg).split('\n');
/** The action row's buttons, or `null` when the message has none (mod page, download and website were all invalid). */
const buttons = (msg: DiscordMessage): DiscordLinkButton[] | null => {
  const row = blocks(msg).at(-1)!;
  return row.type === 1 ? (row.components as DiscordLinkButton[]) : null;
};
/** The trailing subtext block: a top-level sibling of the container, outside its coloured bar. */
const sourceSubtext = (msg: DiscordMessage): string => (msg.components!.at(-1) as { type: 10; content: string }).content;

describe('renderImmediate payload', () => {
  it('is a Components V2 message: flag, one container, no content, no embeds, no mentions', () => {
    const msg = render({ description: 'x' });
    expect(msg.flags).toBe(32768);
    expect(msg.flags).toBe(DISCORD.componentsV2Flag);
    expect('content' in msg).toBe(false);
    expect('embeds' in msg).toBe(false);
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    expect(msg.components).toHaveLength(2);
    expect(container(msg).type).toBe(17);
    expect(assertWithinLimits(msg)).toEqual([]);
  });

  it('always ends with the source subtext, outside the container, with the repo link and the fallback emoji', () => {
    const msg = render();
    const last = msg.components!.at(-1)!;
    expect(last.type).toBe(10);
    expect(sourceSubtext(msg)).toBe(`-# 🐿️ [${PROJECT.name} v${PROJECT.version}](${PROJECT.repoUrl})`);
  });

  it('uses the configured ratatoskr emoji in the source subtext, else the squirrel fallback', () => {
    expect(sourceSubtext(render({}, { now: NOW, ratatoskrEmoji: RT_EMOJI }))).toContain(RT_EMOJI);
    expect(sourceSubtext(render({}, { now: NOW, ratatoskrEmoji: '<:x:1>' }))).toContain(SQUIRREL);
  });

  it('uses the store colour as the container accent', () => {
    const colours = STORE_LIST.map((store) => container(render({ store })).accent_color);
    expect(new Set(colours).size).toBe(3);
    expect(colours.every((c) => typeof c === 'number')).toBe(true);
  });

  it('separates the blocks with dividers and ends with the action row', () => {
    const msg = render({ description: 'd', changelog: '- x', categories: ['Tools'] });
    expect(blocks(msg).map((b) => b.type)).toEqual([9, 14, 10, 14, 10, 14, 1]);
    for (const sep of blocks(msg).filter((b) => b.type === 14)) expect(sep).toEqual({ type: 14, divider: true, spacing: 1 });
    const bare = render({ iconUrl: null });
    expect(blocks(bare).map((b) => b.type)).toEqual([10, 14, 1]);
  });
});

describe('header block', () => {
  it('renders title, kind line, info line and description for an update', () => {
    const msg = render(
      { description: 'Does things', sizeBytes: 98_784_247, downloads: 12_345, likes: 5 },
      { now: NOW, storeEmojis: { thunderstore: TS_EMOJI } },
    );
    expect(headerLines(msg)).toEqual([
      `## ${TS_EMOJI} [Alpha](${PAGE})`,
      `${UPD} · 1.2.3 → 1.2.4 · ${TIME}`,
      'ℹ️ 94.2 MB · Downloaded 12,345 times · 5 likes',
      '',
      'Does things',
    ]);
  });

  it('renders a new package with only the version it starts at', () => {
    const msg = render({ kind: 'new', versionFrom: null, versionTo: '1.0.0', sizeBytes: null });
    expect(headerLines(msg)).toEqual([`## [Alpha](${PAGE})`, `${KIND_EMOJI.new} New by Bob · 1.0.0 · ${TIME}`]);
  });

  it('has no fallback icon in the title when the store has no emoji', () => {
    expect(headerLines(render())[0]).toBe(`## [Alpha](${PAGE})`);
    const other = render({ store: 'nexus' }, { now: NOW, storeEmojis: { thunderstore: TS_EMOJI } });
    expect(headerLines(other)[0]).toBe(`## [Alpha](${PAGE})`);
    expect(headerLines(render({ store: 'hexium' }, { now: NOW, storeEmojis: { hexium: HX_EMOJI } }))[0]).toBe(`## ${HX_EMOJI} [Alpha](${PAGE})`);
  });

  it('ignores malformed store emoji markup instead of emitting it', () => {
    const msg = render({}, { now: NOW, storeEmojis: { thunderstore: '<:x:1> @everyone' } });
    expect(headerLines(msg)[0]).toBe(`## [Alpha](${PAGE})`);
    expect(JSON.stringify(msg)).not.toContain('@everyone');
  });

  it('drops the version arrow when an update has no earlier version', () => {
    expect(headerLines(render({ versionFrom: null }))[1]).toBe(`${UPD} · 1.2.4 · ${TIME}`);
  });

  it('omits the owner and the timestamp when unknown', () => {
    expect(headerLines(render({ owner: '' }))[1]).toBe(`${KIND_EMOJI.update} Updated · 1.2.3 → 1.2.4 · ${TIME}`);
    expect(headerLines(render({ owner: '', kind: 'new', versionFrom: null }))[1]).toBe(`${KIND_EMOJI.new} New · 1.2.4 · ${TIME}`);
    const noClock = renderImmediate(event({ updatedAt: 'x', createdAt: 'y' }), { now: new Date(Number.NaN) });
    expect(headerLines(noClock)[1]).toBe(`${UPD} · 1.2.3 → 1.2.4`);
  });

  it('uses the package update time, then the event time, then the render time', () => {
    expect(headerLines(render({ updatedAt: UPDATED, createdAt: CREATED }))[1]).toContain(`<t:${unixSeconds(UPDATED)}:R>`);
    expect(headerLines(render({ updatedAt: 'garbage', createdAt: CREATED }))[1]).toContain(`<t:${unixSeconds(CREATED)}:R>`);
    expect(headerLines(render({ updatedAt: 'garbage', createdAt: 'nope' }))[1]).toContain(`<t:${Math.floor(NOW.getTime() / 1000)}:R>`);
    expect(headerLines(render({ updatedAt: '1969-12-31T00:00:00Z', createdAt: CREATED }))[1]).toContain(`<t:${unixSeconds(CREATED)}:R>`);
  });

  it('shows only the known parts of the info line, downloads even at zero, likes only above zero', () => {
    const info = (over: Over) => headerLines(render(over)).find((line) => line.startsWith('ℹ️'));
    expect(info({ sizeBytes: null, downloads: null, likes: null })).toBeUndefined();
    expect(info({ sizeBytes: null, downloads: 0, likes: 0 })).toBe('ℹ️ Downloaded 0 times');
    expect(info({ sizeBytes: 1024, downloads: null, likes: 1 })).toBe('ℹ️ 1.0 KB · 1 like');
    expect(info({ sizeBytes: null, downloads: 1, likes: 1234 })).toBe('ℹ️ Downloaded 1 time · 1,234 likes');
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e30, 0.4]) {
      expect(info({ sizeBytes: null, downloads: bad === 0.4 ? null : bad, likes: bad }), String(bad)).toBeUndefined();
    }
    expect(info({ sizeBytes: null, downloads: 1234.9, likes: null })).toBe('ℹ️ Downloaded 1,234 times');
  });

  it('has no description section without an excerpt, and one blank line before it with one', () => {
    expect(headerLines(render({ description: null, sizeBytes: null }))).toHaveLength(2);
    expect(headerLines(render({ description: null, sizeBytes: null }))).not.toContain('');
    const lines = headerLines(render({ description: 'Body text', sizeBytes: null }));
    expect(lines.slice(-2)).toEqual(['', 'Body text']);
    expect(lines.filter((l) => l === '')).toHaveLength(1);
  });

  it('caps the description excerpt', () => {
    const excerpt = headerLines(render({ description: 'word '.repeat(500) })).at(-1)!;
    expect(excerpt.length).toBeLessThanOrEqual(350);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('keeps the also-on line in the header block, before the blank line', () => {
    const msg = render({ description: 'Body', sizeBytes: null, alsoOn: [{ store: 'hexium', url: 'https://hexium.example/p' }] });
    expect(headerLines(msg).slice(2)).toEqual(['Also on [Hexium](https://hexium.example/p)', '', 'Body']);
  });

  it('links the title only when the page url is usable', () => {
    expect(headerLines(render({ url: 'javascript:alert(1)' }))[0]).toBe('## Alpha');
  });

  it('names a nameless mod', () => {
    expect(headerLines(render({ name: '   ' }))[0]).toBe(`## [unnamed](${PAGE})`);
  });
});

describe('thumbnail', () => {
  it('goes to a section next to the header when the icon url is safe', () => {
    const first = blocks(render())[0] as DiscordSection;
    expect(first.type).toBe(9);
    expect(first.accessory).toEqual({ type: 11, media: { url: ICON } });
    expect(first.components).toHaveLength(1);
    expect(first.components[0]).toEqual({ type: 10, content: expect.stringContaining('## [Alpha]') });
  });

  it('is replaced by a plain text display without a usable icon', () => {
    for (const iconUrl of [null, '', 'nope', 'javascript:alert(1)', 'ftp://x.io/i.png', 'https://user:pw@x.io/i.png', `https://x.io/${'a'.repeat(600)}`]) {
      const first = blocks(render({ iconUrl }))[0]!;
      expect(first.type, String(iconUrl)).toBe(10);
    }
  });

  it('percent-encodes characters that would break out of the url', () => {
    const first = blocks(render({ iconUrl: 'https://x.io/a b"c.png' }))[0] as DiscordSection;
    expect(first.accessory.media.url).toBe('https://x.io/a%20b%22c.png');
  });
});

describe('changelog and categories blocks', () => {
  const texts = (over: Over) => displayTexts(render(over));

  it('adds a changelog block with its bold label only when there is an excerpt', () => {
    expect(texts({ changelog: '- fixed', changelogUrl: 'https://x.io/c' })[1]).toBe('**Changelog**\n- fixed\n[Full changelog](https://x.io/c)');
    for (const changelog of [null, '', '   \n ']) {
      expect(texts({ changelog, changelogUrl: 'https://x.io/c' })).toHaveLength(1);
    }
  });

  it('omits the changelog block entirely when the subscription opted out, even with a real excerpt', () => {
    const texts = displayTexts(render({ changelog: '- fixed', changelogUrl: 'https://x.io/c', categories: ['Tools'] }, { now: NOW, includeChangelog: false }));
    expect(texts.some((t) => t.startsWith('**Changelog**'))).toBe(false);
    expect(texts.some((t) => t.startsWith('**🗂️ Categories**'))).toBe(true);
  });

  it('shows one full-changelog link when the excerpt already ends with it', () => {
    const value = texts({ changelog: '- fixed\n[Full changelog](https://x.io/c)', changelogUrl: 'https://x.io/c' })[1]!;
    expect(value.match(/Full changelog/g)).toHaveLength(1);
  });

  it('caps the excerpt at the display limit, cut on a line boundary, link included', () => {
    const changelog = `${Array.from({ length: 80 }, (_, i) => `- fix number ${i}`).join('\n')}\n[Full changelog](https://x.io/c)`;
    const value = texts({ changelog, changelogUrl: 'https://x.io/c' })[1]!;
    const body = value.slice('**Changelog**\n'.length);
    expect(body.length).toBeLessThanOrEqual(CHANGELOG_DISPLAY_MAX);
    expect(body.endsWith('…\n[Full changelog](https://x.io/c)')).toBe(true);
    const kept = body.split('\n').slice(0, -1);
    expect(kept.slice(0, -1).every((line) => /^- fix number \d+$/.test(line))).toBe(true);
    expect(kept.at(-1)).toMatch(/^- fix number \d+…$/);
  });

  it('cuts a long line on a word boundary', () => {
    const value = texts({ changelog: 'lorem ipsum '.repeat(120) })[1]!;
    const body = value.slice('**Changelog**\n'.length);
    expect(body.length).toBeLessThanOrEqual(CHANGELOG_DISPLAY_MAX);
    expect(body).toMatch(/(?:lorem|ipsum)…$/);
  });

  it('never leaves half a link at the cut', () => {
    for (const pad of [200, 225, 230, 235, 240, 245, 250, 255]) {
      const changelog = `${'a '.repeat(pad)}[a link with text](https://example.com/some/long/path/that/goes/on) tail words`;
      const body = texts({ changelog })[1]!.slice('**Changelog**\n'.length);
      expect(body.length).toBeLessThanOrEqual(CHANGELOG_DISPLAY_MAX);
      expect(body, String(pad)).not.toMatch(/\[[^\]]*$/);
      expect(body, String(pad)).not.toMatch(/\]\([^)]*$/);
    }
  });

  it('adds the categories block with its emoji label, escaped and capped', () => {
    expect(texts({ categories: ['Tools', 'Misc'] })[1]).toBe('**🗂️ Categories**\nTools, Misc');
    expect(texts({ categories: [] })).toHaveLength(1);
    expect(texts({ categories: ['', '   '] })).toHaveLength(1);
    const many = texts({ categories: Array.from({ length: 30 }, (_, i) => `Category${i}`) })[1]!;
    expect(many.endsWith('…')).toBe(true);
    expect(many.split('\n')[1]!.split(', ')).toHaveLength(8);
    const hostile = texts({ categories: ['@everyone', '[x](https://evil.example)', '<@123456789012345678>', '**b**', 'a|b'] })[1]!;
    expect(hostile).not.toMatch(/@(everyone|here)/);
    expect(hostile).not.toMatch(/<[@#][!&]?\d+>/);
    expect(hostile).not.toContain('](');
  });

  it('puts the changelog before the categories', () => {
    expect(texts({ changelog: '- x', categories: ['Tools'] }).slice(1).map((t) => t.split('\n')[0])).toEqual(['**Changelog**', '**🗂️ Categories**']);
  });
});

describe('link buttons', () => {
  const WEBSITE = 'https://example.com/mod';

  it('carries mod page, download and website, in that order, with fallback emoji; the source link is not one of them', () => {
    const list = buttons(render({ downloadUrl: DL, websiteUrl: WEBSITE }));
    expect(list).toEqual([
      { type: 2, style: 5, label: 'Mod page', url: PAGE, emoji: { name: '⚡' } },
      { type: 2, style: 5, label: 'Download', url: DL, emoji: { name: '⬇️' } },
      { type: 2, style: 5, label: 'Website', url: WEBSITE, emoji: { name: '🌐' } },
    ]);
  });

  it('gives each store its own fallback emoji on the mod page button', () => {
    const emoji = STORE_LIST.map((store) => buttons(render({ store }))![0]!.emoji!.name);
    expect(emoji).toEqual(['⚡', '🟣', '🌀']);
  });

  it('uses the configured custom store emoji on the mod page button', () => {
    const list = buttons(render({}, { now: NOW, storeEmojis: { thunderstore: TS_EMOJI } }))!;
    expect(list[0]!.emoji).toEqual({ id: '123456789012345678', name: 'thunderstore', animated: false });
    const invalid = buttons(render({}, { now: NOW, storeEmojis: { thunderstore: 'nope' } }))!;
    expect(invalid[0]!.emoji).toEqual({ name: '⚡' });
  });

  it('omits download and website without valid urls, and drops invalid ones', () => {
    expect(buttons(render())!.map((b) => b.label)).toEqual(['Mod page']);
    for (const bad of ['nope', 'javascript:alert(1)', 'ftp://x.io/a', 'https://user:pw@x.io/a', `https://x.io/${'a'.repeat(600)}`, '']) {
      expect(buttons(render({ downloadUrl: bad, websiteUrl: bad }))!.map((b) => b.label), bad).toEqual(['Mod page']);
    }
  });

  it('has no action row, but keeps the source subtext, when nothing is valid', () => {
    const msg = render({ url: 'nope', downloadUrl: null, websiteUrl: null });
    expect(buttons(msg)).toBeNull();
    expect(blocks(msg).some((b) => b.type === 1)).toBe(false);
    expect(sourceSubtext(msg)).toContain(PROJECT.repoUrl);
  });

  it('never uses more than five buttons and only http(s) urls', () => {
    const list = buttons(render({ downloadUrl: DL, websiteUrl: WEBSITE }))!;
    expect(list.length).toBeLessThanOrEqual(5);
    for (const b of list) expect(b.url).toMatch(/^https?:\/\//);
  });
});

describe('injection', () => {
  const hostile = [
    'evil](https://evil.example) @everyone @here <@123456789> <@&99> <#5> **bold** [x](y) ||spoiler|| `code`',
    ']',
    ')',
    '](',
    '@everyone',
    '# not a heading\n-# not subtext\n> quote',
    'multi\nline\r\nname',
    '[a](b)',
    '\\](https://evil.example)',
  ];
  const unescapedCount = (text: string, ch: string): number => {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\\') i += 1;
      else if (text[i] === ch) n += 1;
    }
    return n;
  };

  it.each(hostile)('cannot break out of the title link or add lines: %j', (name) => {
    const msg = render({ name, owner: name, versionTo: name, versionFrom: name, description: name, kind: 'update', sizeBytes: null });
    const lines = headerLines(msg);
    const title = lines[0]!;
    expect(title.startsWith('## [')).toBe(true);
    expect(title.endsWith(`](${PAGE})`)).toBe(true);
    const text = title.slice(4, title.length - `](${PAGE})`.length);
    for (const ch of ['[', ']', '|', '<']) expect(unescapedCount(text, ch), ch).toBe(0);
    expect(text).not.toMatch(/(?<!\\)\]\(/);
    expect(lines[1]!.startsWith(`${KIND_EMOJI.update} Updated by `)).toBe(true);
    expect(lines[2]).toBe('');
    expect(lines).toHaveLength(4);
    const excerpt = lines[3]!;
    for (const start of ['#', '-', '>']) expect(excerpt.startsWith(start)).toBe(false);
    const all = JSON.stringify(msg);
    expect(all).not.toMatch(/@(everyone|here)/);
    expect(all).not.toMatch(/<[@#][!&]?\d+>/);
    expect(assertWithinLimits(msg)).toEqual([]);
  });

  it('never lets an excerpt or name start a heading or subtext line (property)', () => {
    const bits = fc.constantFrom('#', '-#', '- ', '1.', '>', '\n', '\r\n', '@everyone', '[', ']', '(', ')', ' ', 'a', '`', '|', '~', '*', '_');
    fc.assert(
      fc.property(fc.array(bits, { maxLength: 30 }).map((p) => p.join('')), (text) => {
        const lines = headerLines(render({ name: text, owner: text, description: text, versionTo: text, versionFrom: text }));
        for (const [i, line] of lines.entries()) {
          if (i === 0) continue;
          expect(line.startsWith('#') || line.startsWith('-#'), `line ${i}: ${line}`).toBe(false);
        }
        expect(lines.filter((line) => line.startsWith('## '))).toHaveLength(1);
      }),
      { numRuns: 300 },
    );
  });

  it('keeps hostile categories and changelogs out of the header block and inside their own display', () => {
    const msg = render({ categories: hostile, changelog: hostile.join('\n'), changelogUrl: 'https://x.io/c' });
    expect(displayTexts(msg)).toHaveLength(3);
    expect(headerText(msg)).not.toContain('evil');
    expect(JSON.stringify(msg)).not.toMatch(/@(everyone|here)/);
  });
});

describe('limits', () => {
  const unicode = fc
    .array(fc.oneof(fc.integer({ min: 0, max: 0xd7ff }), fc.integer({ min: 0xe000, max: 0x10ffff })), { maxLength: 60 })
    .map((codePoints) => String.fromCodePoint(...codePoints));
  const hostileSurrogates = fc
    .array(fc.constantFrom('\uD800', '\uDBFF', '\uDC00', '\uDFFF', 'a', ' ', '\n'), { maxLength: 60 })
    .map((parts) => parts.join(''));
  const trickyText = fc.oneof(
    { weight: 4, arbitrary: fc.string({ unit: 'grapheme', maxLength: 60 }) },
    { weight: 2, arbitrary: fc.oneof(unicode, hostileSurrogates) },
    { weight: 2, arbitrary: fc.constantFrom('@everyone', 'a]b(c)', '[x](http://evil)', '|', '\\', '- item', '<@123>', 'line\nbreak', '', '   ', '`code`', '> quote', '# head') },
    { weight: 1, arbitrary: fc.nat(700).map((n) => 'n'.repeat(n)) },
    { weight: 1, arbitrary: fc.constant('L'.repeat(8000)) },
  );
  const urlArb = fc.oneof(
    { weight: 4, arbitrary: fc.string({ maxLength: 120 }).map((s) => `https://thunderstore.io/c/valheim/p/${s}`) },
    { weight: 1, arbitrary: fc.constantFrom('not a url', 'javascript:alert(1)', '', 'https://a.io/x)y(z') },
    { weight: 1, arbitrary: fc.nat(1500).map((n) => `https://x.io/${'a'.repeat(n)}`) },
  );
  const num = fc.option(fc.oneof(fc.nat(), fc.constant(Number.NaN), fc.constant(-5), fc.constant(1e30), fc.double()), { nil: null });
  const seedArb = fc.record({
    store: fc.constantFrom(...STORE_LIST),
    kind: fc.constantFrom(...KIND_LIST),
    name: trickyText,
    owner: trickyText,
    url: urlArb,
    versionFrom: fc.option(trickyText, { nil: null }),
    versionTo: trickyText,
    sizeBytes: num,
    description: fc.option(trickyText, { nil: null }),
    changelog: fc.option(fc.oneof(trickyText, fc.constant('line one\n\n\n\nline two\r\n- x\n'.repeat(400))), { nil: null }),
    changelogUrl: fc.option(urlArb, { nil: null }),
    alsoOn: fc.array(fc.record({ store: fc.constantFrom(...STORE_LIST), url: urlArb }), { maxLength: 5 }),
    downloadUrl: fc.option(urlArb, { nil: null }),
    websiteUrl: fc.option(urlArb, { nil: null }),
    iconUrl: fc.option(urlArb, { nil: null }),
    downloads: num,
    likes: num,
    categories: fc.array(trickyText, { maxLength: 30 }),
    updatedAt: fc.oneof(fc.constant('2026-09-19T11:30:00Z'), trickyText),
    createdAt: fc.oneof(fc.constant('2026-09-19T11:30:00Z'), trickyText),
  });
  const WORST_EMOJI = `<a:${'e'.repeat(32)}:${'9'.repeat(20)}>`;

  const checkLimits = (seed: Over, locale: 'en' | 'ru', withEmoji: boolean): void => {
    const msg = renderImmediate(makeEvent(seed), {
      now: NOW,
      locale,
      ...(withEmoji ? { storeEmojis: { thunderstore: WORST_EMOJI, hexium: WORST_EMOJI, nexus: WORST_EMOJI }, ratatoskrEmoji: WORST_EMOJI } : {}),
    });
    expect(assertWithinLimits(msg)).toEqual([]);
    expect(componentText(msg)).toBeLessThanOrEqual(DISCORD.componentsV2TextMax);
    expect(componentCount(msg)).toBeLessThanOrEqual(DISCORD.componentsV2ComponentsMax);
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    expect('content' in msg || 'embeds' in msg).toBe(false);
    expect(msg.components!.at(-1)).toMatchObject({ type: 10 });
    expect(sourceSubtext(msg)).toContain(PROJECT.repoUrl);
    expect(JSON.stringify(msg)).not.toMatch(/@(everyone|here)/);
  };

  it('stays within every V2 limit for fixed hostile cases in both languages, with and without emoji', () => {
    const huge = 'N'.repeat(8000);
    const cases: Over[] = [
      { kind: 'new', name: huge, owner: huge, description: huge, changelog: huge, categories: [huge] },
      { kind: 'update', name: '@everyone [x](javascript:bad)', owner: '\uD800<owner>', url: 'javascript:bad', description: '# heading\n-# subtext', changelog: '```\n<@123>', categories: ['<@123>', huge] },
      { kind: 'update', name: huge, owner: huge, url: `https://x.io/${'a'.repeat(1500)}`, alsoOn: Array.from({ length: 5 }, () => ({ store: 'hexium' as const, url: `https://x.io/${'b'.repeat(1500)}` })), downloads: 1e30, likes: Number.NaN },
    ];
    for (const seed of cases) for (const locale of ['en', 'ru'] as const) for (const withEmoji of [false, true]) checkLimits(seed, locale, withEmoji);
  });

  it('stays within every V2 limit for varied small inputs (property)', () => {
    fc.assert(fc.property(seedArb, fc.constantFrom('en' as const, 'ru' as const), fc.boolean(), checkLimits), { numRuns: 80, seed: 20260928 });
  });

  it('fits the worst case with room to spare', () => {
    const huge = 'N'.repeat(8000);
    const msg = renderImmediate(
      makeEvent({
        kind: 'update',
        name: huge,
        owner: huge,
        versionTo: huge,
        versionFrom: huge,
        description: huge,
        url: `https://x.io/${'a'.repeat(480)}`,
        alsoOn: Array.from({ length: 5 }, () => ({ store: 'hexium' as const, url: `https://x.io/${'b'.repeat(400)}` })),
        changelog: huge,
        changelogUrl: `https://x.io/${'c'.repeat(150)}`,
        categories: Array.from({ length: 30 }, () => huge),
        sizeBytes: Number.MAX_SAFE_INTEGER,
        downloads: Number.MAX_SAFE_INTEGER,
        likes: Number.MAX_SAFE_INTEGER,
      }),
      { now: NOW, locale: 'ru', storeEmojis: { thunderstore: WORST_EMOJI } },
    );
    expect(assertWithinLimits(msg)).toEqual([]);
    expect(componentText(msg)).toBeLessThan(DISCORD.componentsV2TextMax - 800);
  });
});

describe('every text display', () => {
  it('is non-empty and within the per-display limit', () => {
    const msg = render({ description: 'd', changelog: '- x', categories: ['A'] });
    const all = displayTexts(msg);
    expect(all.length).toBe(3);
    for (const text of all) {
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(DISCORD.componentsV2TextMax);
    }
  });
});
