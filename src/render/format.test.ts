// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DISCORD, PROJECT } from '../core/constants.ts';
import type { DiscordMessage } from '../core/types.ts';
import { endsWithProjectField, makeEvent, NOW, realisticUpdates, unixSeconds } from './__fixtures__/events.ts';
import { countItems } from './count.ts';
import { planDigest } from './digest.ts';
import { renderDigest, renderImmediate } from './index.ts';
import { KIND_EMOJI, PROJECT_FIELD, PROJECT_LINE, ZERO_WIDTH_SPACE } from './layout.ts';
import { assertWithinLimits } from './limits.ts';
import { formatCount } from './text.ts';
import { bestOf } from '../testing/timing.ts';

const TS_EMOJI = '<:thunderstore:123456789012345678>';
const HX_EMOJI = '<:hexium:123456789012345679>';
const PAGE = 'https://thunderstore.io/c/valheim/p/Bob/Alpha/';
const UPDATED = '2026-09-19T11:30:00Z';
const CREATED = '2026-09-19T11:45:00Z';
const noDetail = { detailed: () => false, now: NOW };

function unescapedCount(text: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === ch) n += 1;
  }
  return n;
}

const lines = (msg: DiscordMessage, embed = 0): string[] => msg.embeds![embed]!.description!.split('\n');
const NEW = `${KIND_EMOJI.new} New mod`;
const UPD = `${KIND_EMOJI.update} Updated mod`;
const projectFields = (msg: DiscordMessage): number => (msg.embeds ?? []).flatMap((e) => e.fields ?? []).filter((f) => f.value === PROJECT_LINE).length;

describe('project link', () => {
  it('is spelled from the project constant', () => {
    expect(PROJECT_LINE).toBe(`-# [${PROJECT.name} v${PROJECT.version}](${PROJECT.repoUrl})`);
  });

  it('is the zero-width-space named last field, not inline, with the constants in one place', () => {
    expect(PROJECT_FIELD).toEqual({ name: '\u200b', value: PROJECT_LINE });
    expect(ZERO_WIDTH_SPACE).toBe('\u200b');
    expect(KIND_EMOJI).toEqual({ new: '🆕', update: '\u2b06\ufe0f' });
  });

  it('is the last field of the last embed of every kind of message, once, and nowhere else', () => {
    const detailed = makeEvent({ kind: 'new', name: 'Alpha', owner: 'Bob', url: PAGE, description: 'Does things', changelog: '- x', changelogUrl: 'https://x.io/c' });
    const messages: DiscordMessage[] = [
      renderImmediate(detailed, { now: NOW }),
      ...renderDigest([detailed], noDetail),
      ...renderDigest(realisticUpdates(5), noDetail),
      ...renderDigest([...realisticUpdates(30), detailed], noDetail),
      ...renderDigest(realisticUpdates(700), noDetail),
    ];
    expect(messages.length).toBeGreaterThan(4);
    for (const msg of messages) {
      expect(endsWithProjectField(msg)).toBe(true);
      expect(projectFields(msg)).toBe(1);
      for (const embed of msg.embeds!) expect(embed.description).not.toContain(PROJECT_LINE);
    }
  });

  it('survives pathological digests within every limit, however many pages they span', () => {
    const emoji = `<a:${'e'.repeat(32)}:${'9'.repeat(20)}>`;
    const storeEmojis = { thunderstore: emoji, hexium: emoji, nexus: emoji };
    const huge = 'N'.repeat(5000);
    const inputs = [
      realisticUpdates(2000),
      Array.from({ length: 300 }, (_, i) => makeEvent({ name: huge, owner: huge, versionTo: huge, versionFrom: huge, url: `https://x.io/${'a'.repeat(400)}` }, i)),
      Array.from({ length: 120 }, (_, i) => makeEvent({ kind: 'new', name: huge, owner: huge, description: huge, changelog: huge, changelogUrl: `https://x.io/${'a'.repeat(400)}`, alsoOn: [{ store: 'hexium', url: PAGE }, { store: 'nexus', url: PAGE }] }, i)),
    ];
    for (const events of inputs) {
      for (const detailed of [false, true]) {
        const plan = planDigest(events, { detailed: () => detailed, now: NOW, storeEmojis });
        expect(countItems(plan.messages)).toBe(events.length);
        for (const msg of plan.messages) {
          expect(assertWithinLimits(msg)).toEqual([]);
          expect(endsWithProjectField(msg)).toBe(true);
          expect(projectFields(msg)).toBe(1);
        }
      }
    }
  });

  it('puts the page counter in the last embed footer and only there', () => {
    const messages = renderDigest(realisticUpdates(700), noDetail);
    expect(messages.length).toBeGreaterThan(2);
    messages.forEach((msg, i) => {
      expect(msg.embeds!.at(-1)!.footer).toEqual({ text: `(${i + 1}/${messages.length})` });
      for (const embed of msg.embeds!.slice(0, -1)) expect(embed.footer).toBeUndefined();
    });
    const detailedPages = renderDigest(realisticUpdates(30).map((e) => ({ ...e, kind: 'new' as const })), noDetail);
    expect(detailedPages.length).toBeGreaterThan(1);
    expect(detailedPages.at(-1)!.embeds!.at(-1)!.footer!.text).toBe(`Thunderstore · (${detailedPages.length}/${detailedPages.length})`);
  });
});

describe('detailed embed layout', () => {
  const event = (over: Parameters<typeof makeEvent>[0] = {}) =>
    makeEvent({ name: 'Alpha', owner: 'Bob', url: PAGE, updatedAt: UPDATED, createdAt: CREATED, ...over });
  const render = (over: Parameters<typeof makeEvent>[0] = {}, storeEmojis?: Record<string, string>) =>
    renderImmediate(event(over), { now: NOW, ...(storeEmojis ? { storeEmojis } : {}) });

  it('renders the h1 link, info line, blank line and excerpt for an update, with the project field last', () => {
    const msg = render({ description: 'Does things', sizeBytes: 98_784_247 });
    const embed = msg.embeds![0]!;
    expect(embed.description).toBe(
      [
        `# [Alpha 1.2.3 → 1.2.4](${PAGE})`,
        `${UPD} by Bob · 94.2 MB · <t:${unixSeconds(UPDATED)}:R>`,
        '',
        'Does things',
      ].join('\n'),
    );
    expect(embed.fields).toEqual([PROJECT_FIELD]);
    expect(embed.title).toBeUndefined();
    expect(embed.url).toBeUndefined();
    expect(embed.footer).toEqual({ text: 'Thunderstore' });
    expect('timestamp' in embed).toBe(false);
    expect(embed.thumbnail).toBeDefined();
    expect(embed.color).toBeDefined();
  });

  it('renders a new package without the version arrow', () => {
    const msg = render({ kind: 'new', versionFrom: null, versionTo: '1.0.0', sizeBytes: null });
    expect(lines(msg).slice(0, 2)).toEqual([`# [Alpha 1.0.0](${PAGE})`, `${NEW} by Bob · <t:${unixSeconds(UPDATED)}:R>`]);
  });

  it('marks new packages and updates with their own emoji, after the store emoji when there is one', () => {
    expect(lines(render({ kind: 'new' }))[1]!.startsWith('🆕 New mod by Bob')).toBe(true);
    expect(lines(render({ kind: 'update' }))[1]!.startsWith('\u2b06\ufe0f Updated mod by Bob')).toBe(true);
    expect(lines(render({ kind: 'new' }, { thunderstore: TS_EMOJI }))[1]!.startsWith(`${TS_EMOJI} 🆕 New mod by Bob`)).toBe(true);
    expect(lines(render({ kind: 'update' }, { thunderstore: TS_EMOJI }))[1]!.startsWith(`${TS_EMOJI} \u2b06\ufe0f Updated mod by Bob`)).toBe(true);
  });

  it('puts the store emoji at the start of the info line only when configured for that store', () => {
    const withEmoji = render({}, { thunderstore: TS_EMOJI, hexium: HX_EMOJI });
    expect(lines(withEmoji)[1]).toBe(`${TS_EMOJI} ${UPD} by Bob · 2.4 MB · <t:${unixSeconds(UPDATED)}:R>`);
    const other = renderImmediate(event({ store: 'nexus' }), { now: NOW, storeEmojis: { thunderstore: TS_EMOJI } });
    expect(lines(other)[1]!.startsWith(`${UPD} by Bob`)).toBe(true);
    const none = render({});
    expect(lines(none)[1]!.startsWith(`${UPD} by Bob`)).toBe(true);
  });

  it('ignores malformed emoji markup instead of emitting it', () => {
    const bad = render({}, { thunderstore: '<:x:1> @everyone' });
    expect(lines(bad)[1]!.startsWith(`${UPD} by Bob`)).toBe(true);
    expect(bad.embeds![0]!.description).not.toContain('@everyone');
  });

  it('omits missing parts of the info line', () => {
    expect(lines(render({ owner: '', sizeBytes: null }))[1]).toBe(`${UPD} · <t:${unixSeconds(UPDATED)}:R>`);
    expect(lines(render({ sizeBytes: null }))[1]).toBe(`${UPD} by Bob · <t:${unixSeconds(UPDATED)}:R>`);
  });

  it('uses the package update time, then the event time, then the render time for the timestamp', () => {
    expect(lines(render({ updatedAt: UPDATED, createdAt: CREATED }))[1]).toContain(`<t:${unixSeconds(UPDATED)}:R>`);
    expect(lines(render({ updatedAt: 'garbage', createdAt: CREATED }))[1]).toContain(`<t:${unixSeconds(CREATED)}:R>`);
    expect(lines(render({ updatedAt: '', createdAt: CREATED }))[1]).toContain(`<t:${unixSeconds(CREATED)}:R>`);
    expect(lines(render({ updatedAt: 'garbage', createdAt: 'also garbage' }))[1]).toContain(`<t:${Math.floor(NOW.getTime() / 1000)}:R>`);
    const noClock = renderImmediate(event({ updatedAt: 'x', createdAt: 'y' }), { now: new Date(Number.NaN) });
    expect(lines(noClock)[1]).toBe(`${UPD} by Bob · 2.4 MB`);
    expect(lines(render({ updatedAt: '1969-12-31T00:00:00Z', createdAt: CREATED }))[1]).toContain(`<t:${unixSeconds(CREATED)}:R>`);
  });

  it('separates the header block from the excerpt with exactly one blank line, and only when there is an excerpt', () => {
    const withExcerpt = lines(render({ description: 'Body text' }));
    expect(withExcerpt).toEqual([expect.any(String), expect.any(String), '', 'Body text']);
    const without = lines(render({ description: null }));
    expect(without).toHaveLength(2);
    expect(without).not.toContain('');
  });

  it('keeps the also-on line in the header block, before the blank line', () => {
    const msg = render({ description: 'Body', alsoOn: [{ store: 'hexium', url: 'https://hexium.example/p' }] });
    expect(lines(msg)).toEqual([expect.any(String), expect.any(String), 'Also on [Hexium](https://hexium.example/p)', '', 'Body']);
  });

  it('links the heading only when the url is usable', () => {
    const msg = render({ url: 'javascript:alert(1)' });
    expect(lines(msg)[0]).toBe('# Alpha 1.2.3 → 1.2.4');
  });

  it('keeps the changelog field, thumbnail and colour as before', () => {
    const embed = render({ changelog: '- fixed', changelogUrl: 'https://x.io/c' }).embeds![0]!;
    expect(embed.fields).toEqual([{ name: 'Changelog', value: '- fixed\n[Full changelog](https://x.io/c)' }, PROJECT_FIELD]);
  });

  describe('hostile text', () => {
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

    it.each(hostile)('cannot break out of the h1 link or add lines: %j', (name) => {
      const msg = render({ name, owner: name, versionTo: name, versionFrom: name, description: name, kind: 'update' });
      const all = lines(msg);
      const heading = all[0]!;
      expect(heading.startsWith('# [')).toBe(true);
      expect(heading.endsWith(`](${PAGE})`)).toBe(true);
      const text = heading.slice(3, heading.length - `](${PAGE})`.length);
      expect(unescapedCount(text, '[')).toBe(0);
      expect(unescapedCount(text, ']')).toBe(0);
      expect(unescapedCount(text, '(')).toBe(0);
      expect(unescapedCount(text, ')')).toBe(0);
      expect(unescapedCount(text, '|')).toBe(0);
      expect(unescapedCount(text, '<')).toBe(0);
      expect(all[1]!.startsWith(`${UPD} by `)).toBe(true);
      expect(all[2]).toBe('');
      expect(all).toHaveLength(4);
      const excerpt = all[3]!;
      expect(excerpt.startsWith('#')).toBe(false);
      expect(excerpt.startsWith('-')).toBe(false);
      expect(excerpt.startsWith('>')).toBe(false);
      expect(msg.embeds![0]!.description).not.toMatch(/@(everyone|here)/);
      expect(msg.embeds![0]!.description).not.toMatch(/<[@#][!&]?\d+>/);
      expect(assertWithinLimits(msg)).toEqual([]);
    });

    it('never lets an excerpt or name start a heading or subtext line (property)', () => {
      const bits = fc.constantFrom('#', '-#', '- ', '1.', '>', '\n', '\r\n', '@everyone', '[', ']', '(', ')', ' ', 'a', '`', '|', '~', '*', '_');
      fc.assert(
        fc.property(fc.array(bits, { maxLength: 30 }).map((p) => p.join('')), (text) => {
          const all = lines(render({ name: text, owner: text, description: text, versionTo: text, versionFrom: text }));
          for (const [i, line] of all.entries()) {
            if (i === 0) continue;
            expect(line.startsWith('#') || line.startsWith('-#'), `line ${i}: ${line}`).toBe(false);
          }
          expect(all.filter((line) => line.startsWith('# '))).toHaveLength(1);
        }),
        { numRuns: 400 },
      );
    });
  });

  it('keeps the description far below the Discord cap even when every part is at its cap', () => {
    const huge = 'N'.repeat(5000);
    const msg = render(
      { name: huge, owner: huge, versionTo: huge, versionFrom: huge, description: huge, url: `https://x.io/${'a'.repeat(480)}`, alsoOn: [{ store: 'hexium', url: `https://x.io/${'b'.repeat(400)}` }] },
      { thunderstore: `<a:${'e'.repeat(32)}:${'9'.repeat(20)}>` },
    );
    expect(msg.embeds![0]!.description!.length).toBeLessThan(DISCORD.embedDescriptionMax - 1000);
  });
});

describe('compact digest layout', () => {
  it('starts every list embed with the store heading and count, and gives it no footer', () => {
    const messages = renderDigest(realisticUpdates(20), noDetail);
    expect(messages).toHaveLength(1);
    const embed = messages[0]!.embeds![0]!;
    expect(lines(messages[0]!)[0]).toBe('**Thunderstore** · 20 updates');
    expect(embed.footer).toBeUndefined();
    expect(embed.title).toBeUndefined();
    expect(countItems(messages)).toBe(20);
  });

  it('uses the singular for one update and the store emoji when configured', () => {
    const [msg] = renderDigest([makeEvent({ store: 'hexium' })], { ...noDetail, storeEmojis: { hexium: HX_EMOJI } });
    expect(lines(msg!)[0]).toBe(`${HX_EMOJI} **Hexium** · 1 update`);
  });

  it('counts each list embed of a split store separately and keeps every mod', () => {
    const events = realisticUpdates(700);
    const messages = renderDigest(events, noDetail);
    let total = 0;
    for (const msg of messages) {
      for (const embed of msg.embeds!) {
        const heading = embed.description!.split('\n')[0]!;
        const shown = Number(/· (\d+) updates?$/.exec(heading)![1]);
        const body = embed.description!.split('\n').slice(1);
        expect(shown).toBe(body.length);
        total += shown;
      }
    }
    expect(total).toBe(events.length);
  });

  it('keeps the per-store colours', () => {
    const messages = renderDigest([...realisticUpdates(2, 'thunderstore'), ...realisticUpdates(2, 'hexium'), ...realisticUpdates(2, 'nexus')], noDetail);
    const colors = messages.flatMap((m) => m.embeds!).map((e) => e.color);
    expect(new Set(colors).size).toBe(3);
  });

  it('counts detailed embeds, list lines and grouped entries but not headings', () => {
    const detailed = makeEvent({ kind: 'new', name: 'Alpha' });
    const messages = renderDigest([detailed, ...realisticUpdates(6)], noDetail);
    expect(countItems(messages)).toBe(7);
    expect(countItems([{ embeds: [{ description: `**Nexus Mods** · 3 updates\n[a](https://x.io/a) 1 | [b](https://x.io/b) 2` }], allowed_mentions: { parse: [] } }])).toBe(2);
  });
});

describe('link buttons', () => {
  const DL = 'https://thunderstore.io/package/download/Bob/Alpha/1.2.4/';

  it('adds one row with a page and a download button to an immediate message', () => {
    const msg = renderImmediate(makeEvent({ name: 'Alpha', url: PAGE, downloadUrl: DL }), { now: NOW });
    expect(msg.components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: 'Mod page', url: PAGE },
          { type: 2, style: 5, label: 'Download', url: DL },
        ],
      },
    ]);
  });

  it('has no download button without a download url and no components field without any valid url', () => {
    const noDownload = renderImmediate(makeEvent({ url: PAGE, downloadUrl: null }), { now: NOW });
    expect(noDownload.components![0]!.components.map((b) => b.label)).toEqual(['Mod page']);
    const none = renderImmediate(makeEvent({ url: 'nope', downloadUrl: 'javascript:1' }), { now: NOW });
    expect('components' in none).toBe(false);
  });

  it('never puts buttons on digest messages', () => {
    const events = [makeEvent({ kind: 'new', url: PAGE, downloadUrl: DL }), ...realisticUpdates(5)];
    for (const msg of renderDigest(events, { detailed: () => true, now: NOW })) expect('components' in msg).toBe(false);
  });
});

describe('assertWithinLimits on components', () => {
  const base = { embeds: [{ description: 'x' }], allowed_mentions: { parse: [] as [] } };
  const button = (over: Record<string, unknown> = {}) => ({ type: 2 as const, style: 5 as const, label: 'Mod page', url: PAGE, ...over });

  it('accepts a valid row', () => {
    expect(assertWithinLimits({ ...base, components: [{ type: 1, components: [button()] }] })).toEqual([]);
  });

  it('reports too many buttons, over-long labels and urls, empty rows and non-http urls', () => {
    const tooMany = { ...base, components: [{ type: 1 as const, components: Array.from({ length: 6 }, () => button()) }] };
    expect(assertWithinLimits(tooMany).join()).toContain('components[0].components: 6 > 5');
    expect(assertWithinLimits({ ...base, components: [{ type: 1, components: [button({ label: 'x'.repeat(81) })] }] }).join()).toContain('label: 81 > 80');
    expect(assertWithinLimits({ ...base, components: [{ type: 1, components: [button({ url: `https://a.io/${'x'.repeat(600)}` })] }] }).join()).toContain('url: 613 > 512');
    expect(assertWithinLimits({ ...base, components: [{ type: 1, components: [] }] }).join()).toContain('is empty');
    expect(assertWithinLimits({ ...base, components: [{ type: 1, components: [button({ url: 'javascript:1' })] }] }).join()).toContain('must be http(s)');
    expect(assertWithinLimits({ ...base, components: Array.from({ length: 6 }, () => ({ type: 1 as const, components: [button()] })) }).join()).toContain('components: 6 > 5');
  });
});

describe('cost', () => {
  const storeEmojis = { thunderstore: TS_EMOJI, hexium: HX_EMOJI };

  it('renders an immediate message with buttons and emoji far below the CPU budget', () => {
    const event = makeEvent({ kind: 'new', description: 'A description', changelog: '- a\n- b', changelogUrl: 'https://x.io/c', downloadUrl: 'https://x.io/d.zip' });
    expect(bestOf(20, () => renderImmediate(event, { now: NOW, storeEmojis }))).toBeLessThan(2);
  });

  it('renders 400 compact and 400 detailed events with emoji well inside the budget', () => {
    const events = realisticUpdates(400).map((e) => ({ ...e, pkg: { ...e.pkg, downloads: 12_345, categories: ['Tools', 'Misc', 'Client & Server'] } }));
    expect(bestOf(5, () => renderDigest(events, { ...noDetail, storeEmojis }))).toBeLessThan(30);
    expect(bestOf(5, () => renderDigest(events, { detailed: () => true, now: NOW, storeEmojis }))).toBeLessThan(60);
  });
});

describe('detailed fields', () => {
  const render = (over: Parameters<typeof makeEvent>[0] = {}) => renderImmediate(makeEvent({ name: 'Alpha', owner: 'Bob', url: PAGE, ...over }), { now: NOW });
  const fields = (over: Parameters<typeof makeEvent>[0] = {}) => render(over).embeds![0]!.fields!;

  it('omits the Changelog field when there is a changelog link but no excerpt', () => {
    for (const changelog of [null, '', '   \n ']) {
      const message = renderImmediate(makeEvent({ kind: 'new', changelog, changelogUrl: 'https://x.io/c' }), { now: NOW });
      const names = (message.embeds![0]!.fields ?? []).map((f) => f.name);
      expect(names).not.toContain('Changelog');
    }
  });

  it('orders Changelog, Total downloads, Categories, then the project field', () => {
    const all = fields({ changelog: '- fixed', changelogUrl: 'https://x.io/c', downloads: 12_345, categories: ['Tools', 'Misc'] });
    expect(all).toEqual([
      { name: 'Changelog', value: '- fixed\n[Full changelog](https://x.io/c)' },
      { name: 'Total downloads', value: '12,345', inline: true },
      { name: 'Categories', value: 'Tools, Misc', inline: true },
      PROJECT_FIELD,
    ]);
    expect(all[0]!.inline).toBeUndefined();
    expect(PROJECT_FIELD).not.toHaveProperty('inline');
  });

  it('shows zero downloads and omits unknown, negative, fractional-free and non-finite counts', () => {
    expect(fields({ downloads: 0 })[0]).toEqual({ name: 'Total downloads', value: '0', inline: true });
    for (const downloads of [null, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e30]) {
      expect(fields({ downloads }).map((f) => f.name), String(downloads)).toEqual([ZERO_WIDTH_SPACE]);
    }
    expect(fields({ downloads: 1234.9 })[0]!.value).toBe('1,234');
  });

  it('omits the categories field when there is nothing to show', () => {
    expect(fields({ categories: [] }).map((f) => f.name)).toEqual([ZERO_WIDTH_SPACE]);
    expect(fields({ categories: ['', '   ', String.fromCharCode(0x200b)] }).map((f) => f.name)).toEqual([ZERO_WIDTH_SPACE]);
  });

  it('escapes and neutralises category names like any upstream text', () => {
    const value = fields({ categories: ['@everyone', '[x](https://evil.example)', '<@123456789012345678>', '**b**', 'a|b'] })[0]!.value;
    expect(value).not.toMatch(/@(everyone|here)/);
    expect(value).not.toMatch(/<[@#][!&]?\d+>/);
    expect(unescapedCount(value, '[')).toBe(0);
    expect(unescapedCount(value, '(')).toBe(0);
    expect(unescapedCount(value, '*')).toBe(0);
    expect(unescapedCount(value, '|')).toBe(0);
    expect(unescapedCount(value, '<')).toBe(0);
  });

  it('caps the number and the total length of categories and ends a cut list with an ellipsis', () => {
    const many = Array.from({ length: 30 }, (_, i) => 'Category' + i);
    const cutByCount = fields({ categories: many })[0]!;
    expect(cutByCount.value.endsWith('…')).toBe(true);
    expect(cutByCount.value.split(', ')).toHaveLength(8);
    const long = Array.from({ length: 8 }, (_, i) => String(i) + 'x'.repeat(60));
    const cutByLength = fields({ categories: long })[0]!;
    expect(cutByLength.value.length).toBeLessThanOrEqual(200);
    expect(cutByLength.value.endsWith('…')).toBe(true);
    expect(fields({ categories: ['A', 'B'] })[0]!.value.endsWith('…')).toBe(false);
  });

  it('is also part of detailed embeds inside a digest, and compact lists carry only the project field', () => {
    const detailed = makeEvent({ kind: 'new', downloads: 5, categories: ['Tools'] });
    const messages = renderDigest([detailed, ...realisticUpdates(3)], noDetail);
    const [first, list] = messages[0]!.embeds!;
    expect(first!.fields!.map((f) => f.name)).toEqual(['Total downloads', 'Categories']);
    expect(list!.fields).toEqual([PROJECT_FIELD]);
  });

  it('keeps every limit and every mod for hostile counts and categories (property)', () => {
    const cat = fc.string({ maxLength: 300 });
    fc.assert(
      fc.property(fc.array(cat, { maxLength: 40 }), fc.oneof(fc.nat(), fc.double(), fc.constant(null)), (categories, downloads) => {
        const events = Array.from({ length: 30 }, (_, i) => makeEvent({ kind: 'new', categories, downloads }, i));
        const messages = renderDigest(events, noDetail);
        expect(countItems(messages)).toBe(30);
        for (const msg of messages) {
          expect(assertWithinLimits(msg)).toEqual([]);
          expect(endsWithProjectField(msg)).toBe(true);
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('formatCount', () => {
  it('groups thousands with commas by hand', () => {
    const cases: [number, string][] = [[0, '0'], [7, '7'], [999, '999'], [1000, '1,000'], [12_345, '12,345'], [123_456, '123,456'], [1_234_567, '1,234,567'], [1_000_000_000, '1,000,000,000'], [Number.MAX_SAFE_INTEGER, '9,007,199,254,740,991']];
    for (const [n, text] of cases) expect(formatCount(n), String(n)).toBe(text);
  });

  it('returns null for values that are not a non-negative safe count', () => {
    for (const bad of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e30, Number.MAX_SAFE_INTEGER + 1]) expect(formatCount(bad)).toBeNull();
    expect(formatCount(12.9)).toBe('12');
  });

  it('agrees with a plain digit string and groups of three (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (n) => {
        const text = formatCount(n)!;
        expect(text.replaceAll(',', '')).toBe(String(n));
        const groups = text.split(',');
        expect(groups[0]!.length).toBeGreaterThanOrEqual(1);
        expect(groups[0]!.length).toBeLessThanOrEqual(3);
        for (const g of groups.slice(1)) expect(g).toHaveLength(3);
      }),
      { numRuns: 500 },
    );
  });
});
