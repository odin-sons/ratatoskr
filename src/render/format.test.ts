// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DISCORD, MAX_DETAILED_PER_DIGEST, PROJECT } from '../core/constants.ts';
import type { DiscordEmbed, DiscordMessage, ModEvent } from '../core/types.ts';
import { endsWithProjectField, makeEvent, NOW, realisticUpdates, unixSeconds } from './__fixtures__/events.ts';
import { countItems } from './count.ts';
import { planDigest } from './digest.ts';
import { renderDigest, renderImmediate } from './index.ts';
import { KIND_EMOJI, PAGE_SUFFIX_RESERVE, PROJECT_FIELD, PROJECT_LINE, SECTION_EMOJI, TEXT_BUDGET, ZERO_WIDTH_SPACE } from './layout.ts';
import { assertWithinLimits } from './limits.ts';
import { formatBytes, formatCount } from './text.ts';
import { bestOf, bestOfPaired } from '../testing/timing.ts';
import { en } from '../i18n/en.ts';
import { ru } from '../i18n/ru.ts';

const TS_EMOJI = '<:thunderstore:123456789012345678>';
const HX_EMOJI = '<:hexium:123456789012345679>';
const PAGE = 'https://thunderstore.io/c/valheim/p/Bob/Alpha/';
const UPDATED = '2026-09-19T11:30:00Z';
const CREATED = '2026-09-19T11:45:00Z';
const noDetail = { detailed: () => false, now: NOW };
const allDetail = { detailed: () => true, now: NOW };

function unescapedCount(text: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === ch) n += 1;
  }
  return n;
}

const lines = (msg: DiscordMessage, embed = 0): string[] => msg.embeds![embed]!.description!.split('\n');
const projectFields = (msg: DiscordMessage): number => (msg.embeds ?? []).flatMap((e) => e.fields ?? []).filter((f) => f.value === PROJECT_LINE).length;
const TIME = `<t:${unixSeconds(UPDATED)}:R>`;

type Over = Parameters<typeof makeEvent>[0];
type Settings = Omit<Parameters<typeof renderDigest>[1], 'detailed' | 'now'>;
const digestOf = (over: Over = {}, settings: Settings = {}): DiscordMessage =>
  renderDigest([makeEvent({ name: 'Alpha', owner: 'Bob', url: PAGE, updatedAt: UPDATED, createdAt: CREATED, ...over })], { ...allDetail, ...settings })[0]!;
const embedOf = (over: Over = {}, settings: Settings = {}): DiscordEmbed => digestOf(over, settings).embeds![0]!;

describe('project link', () => {
  it('is spelled from the project constant', () => {
    expect(PROJECT_LINE).toBe(`-# [${PROJECT.name} v${PROJECT.version}](${PROJECT.repoUrl})`);
  });

  it('is the zero-width-space named last field, not inline, with the constants in one place', () => {
    expect(PROJECT_FIELD).toEqual({ name: '\u200b', value: PROJECT_LINE });
    expect(ZERO_WIDTH_SPACE).toBe('\u200b');
    expect(KIND_EMOJI).toEqual({ new: '🆕', update: '\u2b06\ufe0f' });
  });

  it('is the last field of the last embed of every digest message, once, and nowhere else', () => {
    const detailed = makeEvent({ kind: 'new', name: 'Alpha', owner: 'Bob', url: PAGE, description: 'Does things', changelog: '- x', changelogUrl: 'https://x.io/c' });
    const messages: DiscordMessage[] = [
      ...renderDigest([detailed], noDetail),
      ...renderDigest(realisticUpdates(5), noDetail),
      ...renderDigest([...realisticUpdates(30), detailed], noDetail),
      ...renderDigest(realisticUpdates(700), noDetail),
    ];
    expect(messages.length).toBeGreaterThan(3);
    for (const msg of messages) {
      expect(endsWithProjectField(msg)).toBe(true);
      expect(projectFields(msg)).toBe(1);
      for (const embed of msg.embeds!) expect(embed.description).not.toContain(PROJECT_LINE);
    }
  });

  it('is not in an immediate message: the trailing subtext replaces it', () => {
    const msg = renderImmediate(makeEvent({ kind: 'new' }), { now: NOW });
    expect(JSON.stringify(msg)).not.toContain(PROJECT_LINE);
    expect(msg.embeds).toBeUndefined();
  });

  it('survives pathological digests within every limit, however many pages they span, in every language', () => {
    const emoji = `<a:${'e'.repeat(32)}:${'9'.repeat(20)}>`;
    const storeEmojis = { thunderstore: emoji, hexium: emoji, nexus: emoji };
    const huge = 'N'.repeat(5000);
    const updateInputs = [
      realisticUpdates(300),
      Array.from({ length: 80 }, (_, i) => makeEvent({ name: huge, owner: huge, versionTo: huge, versionFrom: huge, url: `https://x.io/${'a'.repeat(400)}` }, i)),
    ];
    const newInput = Array.from({ length: 80 }, (_, i) =>
      makeEvent({ kind: 'new', name: huge, owner: huge, description: huge, changelog: huge, changelogUrl: `https://x.io/${'a'.repeat(400)}`, categories: [huge, huge], downloads: 1e15, likes: 1e15, alsoOn: [{ store: 'hexium', url: PAGE }, { store: 'nexus', url: PAGE }] }, i),
    );
    const check = (events: ModEvent[], detailed: boolean, locale: 'en' | 'ru'): void => {
      const plan = planDigest(events, { detailed: () => detailed, now: NOW, storeEmojis, locale });
      expect(countItems(plan.messages)).toBe(events.length);
      expect(plan.messages.length).toBeGreaterThan(1);
      for (const msg of plan.messages) {
        expect(assertWithinLimits(msg)).toEqual([]);
        expect(endsWithProjectField(msg)).toBe(true);
        expect(projectFields(msg)).toBe(1);
      }
    };
    for (const locale of ['en', 'ru'] as const) {
      for (const events of updateInputs) for (const detailed of [false, true]) check(events, detailed, locale);
      check(newInput, true, locale); // kind: 'new' is always detailed regardless of the flag — no point re-running with false
    }
  });

  it('puts the page counter alone in the footer of the last embed, and nowhere else', () => {
    const messages = renderDigest(realisticUpdates(700), noDetail);
    expect(messages.length).toBeGreaterThan(2);
    messages.forEach((msg, i) => {
      expect(msg.embeds!.at(-1)!.footer).toEqual({ text: `(${i + 1}/${messages.length})` });
      for (const embed of msg.embeds!.slice(0, -1)) expect(embed.footer).toBeUndefined();
    });
    const detailedPages = renderDigest(realisticUpdates(30).map((e) => ({ ...e, kind: 'new' as const })), noDetail);
    expect(detailedPages.length).toBeGreaterThan(1);
    expect(detailedPages.at(-1)!.embeds!.at(-1)!.footer).toEqual({ text: `(${detailedPages.length}/${detailedPages.length})` });
    for (const msg of detailedPages) for (const embed of msg.embeds!.slice(0, -1)) expect(embed.footer).toBeUndefined();
  });

  it('has no footer at all when the digest is one message', () => {
    for (const msg of [...renderDigest(realisticUpdates(5), noDetail), ...renderDigest([makeEvent({ kind: 'new' })], noDetail)]) {
      for (const embed of msg.embeds!) expect(embed.footer).toBeUndefined();
    }
  });

  it('spells the page counter in the catalog language and reserves room for it', () => {
    const ru3 = renderDigest(realisticUpdates(700), { ...noDetail, locale: 'ru' });
    expect(ru3[0]!.embeds!.at(-1)!.footer).toEqual({ text: ru.page(1, ru3.length) });
    for (const messages of [en, ru]) expect(messages.page(9999, 9999).length).toBeLessThanOrEqual(PAGE_SUFFIX_RESERVE);
    expect(TEXT_BUDGET + PROJECT_FIELD.name.length + PROJECT_FIELD.value.length + PAGE_SUFFIX_RESERVE).toBe(DISCORD.embedTotalTextMax);
  });
});

describe('detailed embed layout (digest)', () => {
  it('renders the h1 link, kind line, info line and description, with the project field last', () => {
    const msg = digestOf(
      { description: 'Does things', sizeBytes: 98_784_247, downloads: 12_345, likes: 5 },
      { storeEmojis: { thunderstore: TS_EMOJI } },
    );
    const embed = msg.embeds![0]!;
    expect(embed.description).toBe(
      [
        `## ${TS_EMOJI} [Alpha](${PAGE})`,
        `${KIND_EMOJI.update} Updated by Bob · 1.2.3 → 1.2.4 · ${TIME}`,
        'ℹ️ 94.2 MB · Downloaded 12,345 times · 5 likes',
        '',
        'Does things',
      ].join('\n'),
    );
    expect(embed.fields).toEqual([PROJECT_FIELD]);
    expect(embed.title).toBeUndefined();
    expect(embed.url).toBeUndefined();
    expect(embed.footer).toBeUndefined();
    expect('timestamp' in embed).toBe(false);
    expect(embed.thumbnail).toEqual({ url: 'https://gcdn.thunderstore.io/live/repository/icons/x.png' });
    expect(embed.color).toBeDefined();
  });

  it('shares its wording with the immediate message', () => {
    const over = { description: 'Does things', sizeBytes: 98_784_247, downloads: 12_345, likes: 5, kind: 'new' as const, versionFrom: null };
    const immediate = renderImmediate(makeEvent({ name: 'Alpha', owner: 'Bob', url: PAGE, updatedAt: UPDATED, createdAt: CREATED, ...over }), { now: NOW });
    const first = (immediate.components![0] as { components: { type: number; components?: { content: string }[] }[] }).components[0]!;
    expect(first.components![0]!.content).toBe(embedOf(over).description);
  });

  it('marks new packages and updates with their own emoji', () => {
    expect(lines(digestOf({ kind: 'new' }))[1]!.startsWith('🆕 New by Bob')).toBe(true);
    expect(lines(digestOf({ kind: 'update' }))[1]!.startsWith('\u2b06\ufe0f Updated by Bob')).toBe(true);
  });

  it('puts the store emoji only in the title and only when configured for that store', () => {
    expect(lines(digestOf({}, { storeEmojis: { thunderstore: TS_EMOJI, hexium: HX_EMOJI } }))[0]).toBe(`## ${TS_EMOJI} [Alpha](${PAGE})`);
    expect(lines(digestOf({ store: 'nexus' }, { storeEmojis: { thunderstore: TS_EMOJI } }))[0]).toBe(`## [Alpha](${PAGE})`);
    expect(lines(digestOf({}))[0]).toBe(`## [Alpha](${PAGE})`);
    expect(lines(digestOf({}, { storeEmojis: { thunderstore: TS_EMOJI } }))[1]!.startsWith(TS_EMOJI)).toBe(false);
  });

  it('ignores malformed emoji markup instead of emitting it', () => {
    const bad = digestOf({}, { storeEmojis: { thunderstore: '<:x:1> @everyone' } });
    expect(lines(bad)[0]).toBe(`## [Alpha](${PAGE})`);
    expect(bad.embeds![0]!.description).not.toContain('@everyone');
  });

  it('omits missing parts of the info lines', () => {
    expect(lines(digestOf({ owner: '', sizeBytes: null }))[1]).toBe(`${KIND_EMOJI.update} Updated · 1.2.3 → 1.2.4 · ${TIME}`);
    expect(lines(digestOf({ sizeBytes: null }))).toHaveLength(2);
    expect(lines(digestOf({ sizeBytes: null, downloads: 0 }))[2]).toBe('ℹ️ Downloaded 0 times');
    expect(lines(digestOf({ sizeBytes: null, likes: 0 }))).toHaveLength(2);
  });

  it('never shows a download count for a new package: it is always zero at that point', () => {
    expect(lines(digestOf({ kind: 'new', sizeBytes: null, downloads: 0 }))).toHaveLength(2);
    expect(lines(digestOf({ kind: 'new', sizeBytes: null, downloads: 12345 }))).toHaveLength(2);
    expect(lines(digestOf({ kind: 'new', sizeBytes: null, likes: 3 }))[2]).toBe('ℹ️ 3 likes');
  });

  it('uses the package update time, then the event time, then the render time for the timestamp', () => {
    expect(lines(digestOf({ updatedAt: UPDATED, createdAt: CREATED }))[1]).toContain(`<t:${unixSeconds(UPDATED)}:R>`);
    expect(lines(digestOf({ updatedAt: 'garbage', createdAt: CREATED }))[1]).toContain(`<t:${unixSeconds(CREATED)}:R>`);
    expect(lines(digestOf({ updatedAt: 'garbage', createdAt: 'also garbage' }))[1]).toContain(`<t:${Math.floor(NOW.getTime() / 1000)}:R>`);
  });

  it('separates the header block from the description with exactly one blank line, and only when there is an excerpt', () => {
    const withExcerpt = lines(digestOf({ description: 'Body text', sizeBytes: null }));
    expect(withExcerpt).toEqual([expect.any(String), expect.any(String), '', 'Body text']);
    const without = lines(digestOf({ description: null, sizeBytes: null }));
    expect(without).toHaveLength(2);
    expect(without).not.toContain('');
  });

  it('keeps the also-on line in the header block, before the blank line', () => {
    const msg = digestOf({ description: 'Body', sizeBytes: null, alsoOn: [{ store: 'hexium', url: 'https://hexium.example/p' }] });
    expect(lines(msg).slice(2)).toEqual(['Also on [Hexium](https://hexium.example/p)', '', 'Body']);
  });

  it('links the heading only when the url is usable', () => {
    expect(lines(digestOf({ url: 'javascript:alert(1)' }))[0]).toBe('## Alpha');
  });

  it('carries the changelog and categories fields, in that order, before the project field', () => {
    const all = embedOf({ changelog: '- fixed', changelogUrl: 'https://x.io/c', categories: ['Tools', 'Misc'], downloads: 5 }).fields!;
    expect(all).toEqual([
      { name: 'Changelog', value: '- fixed\n[Full changelog](https://x.io/c)' },
      { name: '🗂️ Categories', value: 'Tools, Misc' },
      PROJECT_FIELD,
    ]);
    expect(all[0]!.inline).toBeUndefined();
    expect(PROJECT_FIELD).not.toHaveProperty('inline');
    expect(all.map((f) => f.name)).not.toContain('Total downloads');
  });

  it('omits the changelog field entirely when the subscription opted out, even with a real excerpt', () => {
    const withIt = embedOf({ changelog: '- fixed', changelogUrl: 'https://x.io/c', categories: ['Tools'] });
    expect(withIt.fields!.map((f) => f.name)).toEqual(['Changelog', '🗂️ Categories', PROJECT_FIELD.name]);
    const without = embedOf({ changelog: '- fixed', changelogUrl: 'https://x.io/c', categories: ['Tools'] }, { includeChangelog: false });
    expect(without.fields!.map((f) => f.name)).toEqual(['🗂️ Categories', PROJECT_FIELD.name]);
  });

  it('omits the changelog field without an excerpt, even with a changelog link', () => {
    for (const changelog of [null, '', '   \n ']) {
      const names = (embedOf({ changelog, changelogUrl: 'https://x.io/c' }).fields ?? []).map((f) => f.name);
      expect(names).not.toContain('Changelog');
    }
  });

  it('caps the changelog field at the display limit', () => {
    const value = embedOf({ changelog: `${'- a fairly long changelog line\n'.repeat(60)}[Full changelog](https://x.io/c)`, changelogUrl: 'https://x.io/c' }).fields![0]!.value;
    expect(value.length).toBeLessThanOrEqual(500);
    expect(value.endsWith('\n[Full changelog](https://x.io/c)')).toBe(true);
  });

  it('omits the categories field when there is nothing to show', () => {
    expect(embedOf({ categories: [] }).fields!.map((f) => f.name)).toEqual([ZERO_WIDTH_SPACE]);
    expect(embedOf({ categories: ['', '   ', String.fromCharCode(0x200b)] }).fields!.map((f) => f.name)).toEqual([ZERO_WIDTH_SPACE]);
  });

  it('escapes and neutralises category names like any upstream text', () => {
    const value = embedOf({ categories: ['@everyone', '[x](https://evil.example)', '<@123456789012345678>', '**b**', 'a|b'] }).fields![0]!.value;
    expect(value).not.toMatch(/@(everyone|here)/);
    expect(value).not.toMatch(/<[@#][!&]?\d+>/);
    for (const ch of ['[', '(', '*', '|', '<']) expect(unescapedCount(value, ch), ch).toBe(0);
  });

  it('caps the number and the total length of categories and ends a cut list with an ellipsis', () => {
    const many = Array.from({ length: 30 }, (_, i) => `Category${i}`);
    const cutByCount = embedOf({ categories: many }).fields![0]!;
    expect(cutByCount.value.endsWith('…')).toBe(true);
    expect(cutByCount.value.split(', ')).toHaveLength(8);
    const long = Array.from({ length: 8 }, (_, i) => String(i) + 'x'.repeat(60));
    const cutByLength = embedOf({ categories: long }).fields![0]!;
    expect(cutByLength.value.length).toBeLessThanOrEqual(200);
    expect(cutByLength.value.endsWith('…')).toBe(true);
    expect(embedOf({ categories: ['A', 'B'] }).fields![0]!.value.endsWith('…')).toBe(false);
  });

  it('is part of detailed embeds inside a digest, and compact lists carry only the project field', () => {
    const detailed = makeEvent({ kind: 'new', downloads: 5, categories: ['Tools'] });
    const [first, list] = renderDigest([detailed, ...realisticUpdates(3)], noDetail)[0]!.embeds!;
    expect(first!.fields!.map((f) => f.name)).toEqual([`${SECTION_EMOJI.categories} Categories`]);
    expect(list!.fields).toEqual([PROJECT_FIELD]);
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
      const msg = digestOf({ name, owner: name, versionTo: name, versionFrom: name, description: name, kind: 'update', sizeBytes: null });
      const all = lines(msg);
      const heading = all[0]!;
      expect(heading.startsWith('## [')).toBe(true);
      expect(heading.endsWith(`](${PAGE})`)).toBe(true);
      const text = heading.slice(4, heading.length - `](${PAGE})`.length);
      for (const ch of ['[', ']', '|', '<']) expect(unescapedCount(text, ch), ch).toBe(0);
      expect(text).not.toMatch(/(?<!\\)\]\(/);
      expect(all[1]!.startsWith(`${KIND_EMOJI.update} Updated by `)).toBe(true);
      expect(all[2]).toBe('');
      expect(all).toHaveLength(4);
      const excerpt = all[3]!;
      for (const start of ['#', '-', '>']) expect(excerpt.startsWith(start)).toBe(false);
      expect(msg.embeds![0]!.description).not.toMatch(/@(everyone|here)/);
      expect(msg.embeds![0]!.description).not.toMatch(/<[@#][!&]?\d+>/);
      expect(assertWithinLimits(msg)).toEqual([]);
    });

    it('never lets an excerpt or name start a heading or subtext line (property)', () => {
      const bits = fc.constantFrom('#', '-#', '- ', '1.', '>', '\n', '\r\n', '@everyone', '[', ']', '(', ')', ' ', 'a', '`', '|', '~', '*', '_');
      fc.assert(
        fc.property(fc.array(bits, { maxLength: 30 }).map((p) => p.join('')), (text) => {
          const all = lines(digestOf({ name: text, owner: text, description: text, versionTo: text, versionFrom: text }));
          for (const [i, line] of all.entries()) {
            if (i === 0) continue;
            expect(line.startsWith('#') || line.startsWith('-#'), `line ${i}: ${line}`).toBe(false);
          }
          expect(all.filter((line) => line.startsWith('## '))).toHaveLength(1);
        }),
        { numRuns: 300 },
      );
    });
  });

  it('keeps the description far below the Discord cap even when every part is at its cap', () => {
    const huge = 'N'.repeat(5000);
    const msg = digestOf(
      { name: huge, owner: huge, versionTo: huge, versionFrom: huge, description: huge, url: `https://x.io/${'a'.repeat(480)}`, sizeBytes: 1e15, downloads: 1e15, likes: 1e15, alsoOn: [{ store: 'hexium', url: `https://x.io/${'b'.repeat(400)}` }] },
      { storeEmojis: { thunderstore: `<a:${'e'.repeat(32)}:${'9'.repeat(20)}>` }, locale: 'ru' },
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

  it('counts a Components V2 message as one mod', () => {
    expect(countItems([renderImmediate(makeEvent({ kind: 'new' }), { now: NOW })])).toBe(1);
  });

  it('never puts buttons on digest messages', () => {
    const events = [makeEvent({ kind: 'new', url: PAGE, downloadUrl: 'https://x.io/d' }), ...realisticUpdates(5)];
    for (const msg of renderDigest(events, allDetail)) {
      expect('components' in msg).toBe(false);
      expect('flags' in msg).toBe(false);
      expect('content' in msg).toBe(false);
    }
  });
});

describe('cost', () => {
  const storeEmojis = { thunderstore: TS_EMOJI, hexium: HX_EMOJI };

  it('renders an immediate message with buttons and emoji far below the CPU budget', () => {
    const event = makeEvent({ description: 'A description', changelog: '- a\n- b', changelogUrl: 'https://x.io/c', downloadUrl: 'https://x.io/d.zip', websiteUrl: 'https://x.io/w', categories: ['Tools'], likes: 3, downloads: 9 });
    expect(bestOf(20, () => renderImmediate(event, { now: NOW, storeEmojis }))).toBeLessThan(2);
  });

  it('renders 400 compact and 400 detailed events with emoji well inside the budget', () => {
    const events = realisticUpdates(400).map((e) => ({ ...e, pkg: { ...e.pkg, downloads: 12_345, likes: 7, categories: ['Tools', 'Misc', 'Client & Server'] } }));
    expect(bestOf(5, () => renderDigest(events, { ...noDetail, storeEmojis }))).toBeLessThan(30);
    expect(bestOf(5, () => renderDigest(events, { ...allDetail, storeEmojis }))).toBeLessThan(60);
  });
});

describe('cost in every language', () => {
  const links = Array.from({ length: 12 }, (_, i) => `- fixed [issue ${i}](https://github.com/x/y/issues/${i}) and [docs](https://example.com/d/${i})`).join('\n');
  const events = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      makeEvent({ description: 'Some description text. '.repeat(20), changelog: `${links}\n[Full changelog](https://thunderstore.io/x/${i}/changelog/)`, changelogUrl: `https://thunderstore.io/x/${i}/changelog/`, categories: ['Tools', 'Misc'], downloads: 1234, likes: 4 }, i),
    );

  // MAX_DETAILED_PER_DIGEST is the real worst case: drain.ts never hands renderDigest more detailed, changelog-bearing
  // entries than that in one call, however large the backlog (see cappedDetailed in src/core/drain.ts).
  it('renders link-heavy detailed digests in russian about as fast as in english', () => {
    const list = events(MAX_DETAILED_PER_DIGEST);
    const [en, ru] = bestOfPaired(
      12,
      () => renderDigest(list, { ...allDetail, locale: 'en' }),
      () => renderDigest(list, { ...allDetail, locale: 'ru' }),
    );
    expect(ru, `en ${en.toFixed(2)} ms, ru ${ru.toFixed(2)} ms`).toBeLessThan(en * 1.8 + 0.5);
    expect(ru).toBeLessThan(5);
  });

  it('renders an immediate message in russian far below the CPU budget', () => {
    const event = events(1)[0]!;
    expect(bestOf(20, () => renderImmediate(event, { now: NOW, locale: 'ru' }))).toBeLessThan(2);
  });
});

describe('formatCount', () => {
  it('groups thousands with commas by hand', () => {
    const cases: [number, string][] = [[0, '0'], [7, '7'], [999, '999'], [1000, '1,000'], [12_345, '12,345'], [123_456, '123,456'], [1_234_567, '1,234,567'], [1_000_000_000, '1,000,000,000'], [Number.MAX_SAFE_INTEGER, '9,007,199,254,740,991']];
    for (const [n, text] of cases) expect(formatCount(n), String(n)).toBe(text);
  });

  it('uses the separator it is given', () => {
    expect(formatCount(1_234_567, '\u00a0')).toBe('1\u00a0234\u00a0567');
    expect(formatCount(999, '\u00a0')).toBe('999');
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

describe('formatBytes in a catalog language', () => {
  it('uses the unit names and decimal separator of the catalog', () => {
    expect(formatBytes(98_784_247, ru.byteUnits, ru.decimalSeparator)).toBe('94,2 МБ');
    expect(formatBytes(512, ru.byteUnits, ru.decimalSeparator)).toBe('512 Б');
    expect(formatBytes(2_516_582, en.byteUnits, en.decimalSeparator)).toBe('2.4 MB');
  });
});
