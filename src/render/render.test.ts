// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHANGELOG_DISPLAY_MAX, DISCORD } from '../core/constants.ts';
import type { DiscordMessage, EventKind, ModEvent } from '../core/types.ts';
import { extractChangelog } from '../changelog/extract.ts';
import { hasInvisible, INVISIBLE_CODE_POINTS } from '../text/__fixtures__/invisible.ts';
import { bestOf } from '../testing/timing.ts';
import { countItems } from './count.ts';
import { prepare, renderBlocks } from './compact.ts';
import { planDigest } from './digest.ts';
import { renderDigest, renderImmediate } from './index.ts';
import { assertWithinLimits } from './limits.ts';
import { KIND_EMOJI, PROJECT_LINE, SECTION_EMOJI } from './layout.ts';
import { endsWithProjectField, makeEvent, NOW, realisticUpdates, STORE_KINDS, type EventSeed } from './__fixtures__/events.ts';
import { escapeTruncate, formatBytes, inline, safeUrl } from './text.ts';

const noDetail = { detailed: () => false, now: NOW };
const allDetail = { detailed: () => true, now: NOW };

const WORST_EMOJI = `<a:${'e'.repeat(32)}:${'9'.repeat(20)}>`;
const WORST_EMOJIS = { thunderstore: WORST_EMOJI, hexium: WORST_EMOJI, nexus: WORST_EMOJI };

function unescapedCount(text: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === ch) n += 1;
  }
  return n;
}

function displayTexts(message: DiscordMessage): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const rec = node as { type?: number; content?: string; components?: unknown[] };
    if (rec.type === 10 && typeof rec.content === 'string') out.push(rec.content);
    for (const child of rec.components ?? []) visit(child);
  };
  for (const top of message.components ?? []) visit(top);
  return out;
}

function allText(messages: DiscordMessage[]): string {
  return messages
    .flatMap((m) => [
      ...(m.embeds ?? []).flatMap((e) => [e.description, e.footer?.text, ...(e.fields ?? []).filter((f) => f.value !== PROJECT_LINE).flatMap((f) => [f.name, f.value])]),
      ...displayTexts(m),
    ])
    .filter((t): t is string => typeof t === 'string')
    .join('\n')
    .replaceAll(KIND_EMOJI.update, '')
    .replaceAll(KIND_EMOJI.new, '')
    .replaceAll(SECTION_EMOJI.info, '')
    .replaceAll(SECTION_EMOJI.categories, '');
}

function expectValid(messages: DiscordMessage[]): void {
  for (const msg of messages) {
    expect(assertWithinLimits(msg)).toEqual([]);
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    expectEndsWithProjectLine(msg);
  }
}

function expectEndsWithProjectLine(msg: DiscordMessage): void {
  expect(endsWithProjectField(msg)).toBe(true);
}

const trickyText = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: 'grapheme', maxLength: 40 }) },
  { weight: 2, arbitrary: fc.string({ unit: 'binary', maxLength: 40 }) },
  {
    weight: 2,
    arbitrary: fc.constantFrom('@everyone', 'a]b(c)', '[x](http://evil)', '|', '||spoil||', '\\', '- item', '1. item', '<@123>', '<#456>', 'line\nbreak', '', '   ', '`code`', '> quote', '# head'),
  },
  { weight: 1, arbitrary: fc.nat(700).map((n) => 'n'.repeat(n)) },
  { weight: 1, arbitrary: fc.constant('L'.repeat(5000)) },
);

const urlArb = fc.oneof(
  { weight: 4, arbitrary: fc.string({ maxLength: 120 }).map((s) => `https://thunderstore.io/c/valheim/p/${s}`) },
  { weight: 1, arbitrary: fc.constantFrom('not a url', 'javascript:alert(1)', '', 'https://a.io/x)y(z') },
  { weight: 1, arbitrary: fc.nat(1500).map((n) => `https://x.io/${'a'.repeat(n)}`) },
);

const seedArb: fc.Arbitrary<EventSeed> = fc.record({
  store: fc.constantFrom(...STORE_KINDS),
  kind: fc.constantFrom<EventKind>('new', 'update', 'update', 'update'),
  name: trickyText,
  owner: trickyText,
  url: urlArb,
  versionFrom: fc.option(trickyText, { nil: null }),
  versionTo: trickyText,
  sizeBytes: fc.option(fc.oneof(fc.nat(), fc.constant(Number.NaN), fc.double()), { nil: null }),
  description: fc.option(trickyText, { nil: null }),
  changelog: fc.option(fc.oneof(trickyText, fc.constant('line one\n\n\n\nline two\r\n- x\n'.repeat(400))), { nil: null }),
  changelogUrl: fc.option(urlArb, { nil: null }),
  alsoOn: fc.array(fc.record({ store: fc.constantFrom(...STORE_KINDS), url: urlArb }), { maxLength: 5 }),
  downloadUrl: fc.option(urlArb, { nil: null }),
  websiteUrl: fc.option(urlArb, { nil: null }),
  iconUrl: fc.option(urlArb, { nil: null }),
  likes: fc.option(fc.oneof(fc.nat(), fc.constant(Number.NaN), fc.constant(-5), fc.constant(1e30), fc.double()), { nil: null }),
  downloads: fc.option(fc.oneof(fc.nat(), fc.constant(Number.NaN), fc.constant(-5), fc.constant(1e30), fc.double()), { nil: null }),
  categories: fc.array(trickyText, { maxLength: 30 }),
  updatedAt: fc.oneof(fc.constant('2026-09-19T11:30:00Z'), trickyText),
  createdAt: fc.oneof(fc.constant('2026-09-19T11:30:00Z'), trickyText),
});

const seedListArb = fc.oneof(
  fc.array(seedArb, { maxLength: 25 }),
  fc.array(seedArb, { minLength: 100, maxLength: 600, size: 'max' }),
);

describe('digest invariants', () => {
  it('never drops a mod and always satisfies Discord limits (property)', () => {
    fc.assert(
      fc.property(seedListArb, fc.integer({ min: 0, max: 6 }), fc.boolean(), (seeds, detailEvery, withEmoji) => {
        const events = seeds.map((seed, i) => makeEvent(seed, i));
        const plan = planDigest(events, {
          detailed: (e) => detailEvery > 0 && e.pkg.packageId.length % detailEvery === 0,
          now: NOW,
          ...(withEmoji ? { storeEmojis: WORST_EMOJIS } : {}),
        });
        expect(countItems(plan.messages)).toBe(events.length);
        for (const msg of plan.messages) {
          expect(assertWithinLimits(msg)).toEqual([]);
          expect(msg.allowed_mentions).toEqual({ parse: [] });
          expect(msg.components).toBeUndefined();
          expectEndsWithProjectLine(msg);
        }
        if (events.length === 0) expect(plan.messages).toEqual([]);
      }),
      { numRuns: 60 },
    );
  }, 30_000);

  it('renders a single mod with a pathologically long name', () => {
    for (const long of ['L'.repeat(5000), '*'.repeat(5000), '@everyone'.repeat(500)]) {
      const events = [makeEvent({ name: long, owner: long, url: `https://x.io/${'a'.repeat(3000)}`, versionTo: long, versionFrom: long })];
      const messages = renderDigest(events, noDetail);
      expect(countItems(messages)).toBe(1);
      expectValid(messages);
      const detailedMessages = renderDigest(events, { detailed: () => true, now: NOW });
      expect(countItems(detailedMessages)).toBe(1);
      expectValid(detailedMessages);
    }
  });

  it('returns no messages for empty input', () => {
    expect(renderDigest([], noDetail)).toEqual([]);
  });
});

describe('degradation ladder', () => {
  it('goes down progressively as the list grows', () => {
    const levels = [5, 50, 60, 66, 70, 76, 150, 400].map((n) => {
      const plan = planDigest(realisticUpdates(n), noDetail);
      expect(countItems(plan.messages)).toBe(n);
      return { n, level: plan.level, messages: plan.messages.length };
    });
    expect(levels).toMatchInlineSnapshot(`
      [
        {
          "level": 0,
          "messages": 1,
          "n": 5,
        },
        {
          "level": 0,
          "messages": 1,
          "n": 50,
        },
        {
          "level": 1,
          "messages": 1,
          "n": 60,
        },
        {
          "level": 2,
          "messages": 1,
          "n": 66,
        },
        {
          "level": 2,
          "messages": 1,
          "n": 70,
        },
        {
          "level": 4,
          "messages": 1,
          "n": 76,
        },
        {
          "level": 4,
          "messages": 1,
          "n": 150,
        },
        {
          "level": 4,
          "messages": 2,
          "n": 400,
        },
      ]
    `);
  });

  it('uses L0 for a small digest with author and size', () => {
    const [msg] = renderDigest([makeEvent({ name: 'Alpha', owner: 'Bob', url: 'https://thunderstore.io/c/valheim/p/Bob/Mod0/' })], noDetail);
    const desc = msg!.embeds![0]!.description!;
    expect(desc).toBe(
      ['**Thunderstore** · 1 update', '**[Alpha](https://thunderstore.io/c/valheim/p/Bob/Mod0/)** 1.2.3 → 1.2.4 · Bob · 2.4 MB'].join('\n'),
    );
    expect(msg!.embeds![0]!.footer).toBeUndefined();
  });

  it('applies one level to the whole section', () => {
    const plan = planDigest(realisticUpdates(120, 'thunderstore').concat(realisticUpdates(30, 'hexium')), noDetail);
    const lines = plan.messages.flatMap((m) => m.embeds!).flatMap((e) => e.description!.split('\n').slice(1));
    const hasLinks = lines.map((l) => l.includes('](http'));
    expect(new Set(hasLinks).size).toBe(1);
  });

  it('L3 groups mods by author and keeps every mod countable', () => {
    const events = Array.from({ length: 200 }, (_, i) => makeEvent({ owner: i < 150 ? 'Solo' : `Other${i}`, name: `M|${i}` }, i));
    const [block] = renderBlocks(events.map((e) => prepare(e)), 3);
    expect(block!.lines.reduce((sum, l) => sum + l.count, 0)).toBe(200);
    expect(block!.lines[0]!.text.startsWith('**Solo** · [M\\|0](')).toBe(true);
    for (const line of block!.lines) expect(line.text.length).toBeLessThan(1100);
    const description = ['**Thunderstore** · 200 updates', ...block!.lines.map((l) => l.text)].join('\n');
    const messages = [{ embeds: [{ description }], allowed_mentions: { parse: [] as [] } }];
    expect(countItems(messages)).toBe(200);
  });

  it('L4 lines carry no links', () => {
    const plan = planDigest(realisticUpdates(300), noDetail);
    expect(plan.level).toBe(4);
    expect(allText(plan.messages).replaceAll(PROJECT_LINE, '')).not.toContain('](');
  });
});

describe('injection', () => {
  const evil = 'evil](https://evil.example) @everyone @here <@123456789> <@&99> <#5> **bold** [x](y) ||spoiler|| `code`';

  it('keeps hostile names inside their link text at every level', () => {
    for (const n of [1, 40, 120, 200]) {
      const events = [makeEvent({ name: evil, owner: evil, versionTo: evil, versionFrom: evil }, 0), ...realisticUpdates(n, 'hexium')];
      const messages = renderDigest(events, noDetail);
      const text = allText(messages);
      expect(text).not.toMatch(/@(everyone|here)/i);
      expect(text).not.toMatch(/<[@#][!&]?\d+>/);
      expectValid(messages);
    }
  });

  it('cannot break out of the markdown link at L0', () => {
    const [msg] = renderDigest([makeEvent({ name: evil })], noDetail);
    const line = msg!.embeds![0]!.description!.split('\n')[1]!;
    expect(unescapedCount(line, '[')).toBe(1);
    expect(unescapedCount(line, ']')).toBe(1);
    expect(unescapedCount(line, '(')).toBe(1);
    expect(unescapedCount(line, ')')).toBe(1);
    expect(line).toContain('evil\\]\\(https://evil.example\\)');
    expect(unescapedCount(line, '|')).toBe(0);
  });

  it('encodes hostile URLs and drops non-http schemes', () => {
    expect(safeUrl('https://a.io/x)y(z w|v')).toBe('https://a.io/x%29y%28z%20w%7Cv');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('https://a.io/' + 'a'.repeat(600))).toBeNull();
    const [msg] = renderDigest([makeEvent({ url: 'javascript:alert(1)' })], noDetail);
    expect(msg!.embeds![0]!.description).not.toContain('](');
  });

  it('neutralises line-start list markers and headings', () => {
    expect(inline('- item', 50)).toBe('\\- item');
    expect(inline('1. item', 50)).toBe('1\\. item');
    expect(inline('# h > q', 50)).toBe('\\# h \\> q');
  });

  it('neutralises detailed embeds too', () => {
    const event = makeEvent({ kind: 'new', name: evil, description: evil, changelog: `${evil}\n- @everyone`, changelogUrl: 'https://x.io/c' });
    const messages = renderDigest([event], noDetail);
    const text = allText(messages);
    expect(text).not.toMatch(/@(everyone|here)/i);
    expect(text).not.toMatch(/<[@#][!&]?\d+>/);
    expectValid(messages);
  });
});

describe('invisible characters in text fields', () => {
  const RAW = INVISIBLE_CODE_POINTS.map(([label, code]): [string, string] => [label, String.fromCodePoint(code)]);
  const ENTITIES = INVISIBLE_CODE_POINTS.map(([label, code]): [string, string] => [label, `&#x${code.toString(16)};`]);

  it.each(RAW)('%s written raw is dropped from name, owner, versions and description, detailed and compact', (_label, mark) => {
    const event = makeEvent({ kind: 'update', name: `Mo${mark}d`, owner: `Ow${mark}ner`, versionFrom: `1${mark}.0`, versionTo: `2${mark}.0`, description: `De${mark}sc` });
    for (const text of [allText([renderImmediate(event, { now: NOW })]), allText(renderDigest([event], noDetail)), allText(renderDigest([event], allDetail))]) {
      expect(hasInvisible(text)).toBe(false);
    }
    const detailed = renderDigest([event], allDetail)[0]!.embeds![0]!;
    const compact = detailed.description!.replace(/\s/g, '');
    expect(detailed.description?.split('\n')[0]?.replace(/\s/g, '')).toBe(`#[Mod](${event.pkg.url})`);
    expect(compact).toContain('byOwner');
    expect(compact).toContain('1.0→2.0');
    expect(compact).toContain('Desc');
  });

  it.each(ENTITIES)('%s written as an entity is dropped from the description', (_label, mark) => {
    const event = makeEvent({ kind: 'new', description: `De${mark}sc` });
    const text = allText([renderImmediate(event, { now: NOW }), ...renderDigest([event], allDetail)]);
    expect(hasInvisible(text)).toBe(false);
    expect(text).toContain('Desc');
  });

  it('keeps a line separator inside a name as a space', () => {
    expect(inline(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`, 50)).toBe('a b c');
  });
});

describe('splitting', () => {
  it('numbers messages and prefers store boundaries', () => {
    const events = [...realisticUpdates(150, 'thunderstore'), ...realisticUpdates(150, 'hexium'), ...realisticUpdates(40, 'nexus')];
    const plan = planDigest(events, noDetail);
    expect(plan.level).toBe(4);
    const total = plan.messages.length;
    expect(total).toBeGreaterThan(1);
    expect(countItems(plan.messages)).toBe(events.length);
    plan.messages.forEach((msg, i) => {
      expect(msg.embeds!.at(-1)!.footer!.text).toBe(`(${i + 1}/${total})`);
      for (const embed of msg.embeds!.slice(0, -1)) expect(embed.footer).toBeUndefined();
    });
    const storesPerMessage = plan.messages.map((m) => new Set(m.embeds!.map((e) => e.description!.split('\n')[0]!.replace(/\*\*/g, '').split(' · ')[0])));
    const thunderstoreMessages = storesPerMessage.filter((s) => s.has('Thunderstore')).length;
    const hexiumMessages = storesPerMessage.filter((s) => s.has('Hexium')).length;
    expect(thunderstoreMessages).toBe(1);
    expect(hexiumMessages).toBe(1);
    expectValid(plan.messages);
  });

  it('splits inside a store only when the store cannot fit in one message', () => {
    const events = realisticUpdates(700, 'thunderstore');
    const plan = planDigest(events, noDetail);
    expect(plan.messages.length).toBeGreaterThan(2);
    expect(countItems(plan.messages)).toBe(700);
    expectValid(plan.messages);
  });

  it('keeps full embeds first and compact lists after them', () => {
    const events = [
      ...realisticUpdates(30, 'hexium'),
      makeEvent({ kind: 'new', name: 'Brand New', versionFrom: null, description: 'Does things', changelog: '## 1.0\n- first', changelogUrl: 'https://x.io/changelog' }, 900),
    ];
    const plan = planDigest(events, noDetail);
    expect(plan.messages).toHaveLength(1);
    const [first, second] = plan.messages[0]!.embeds!;
    expect(first!.description!.split('\n')[0]).toBe('# [Brand New](https://thunderstore.io/c/valheim/p/Author0/Mod900/)');
    expect(first!.fields![0]!.value).toContain('[Full changelog](https://x.io/changelog)');
    expect(second!.description!.startsWith('# ')).toBe(false);
    expect(countItems(plan.messages)).toBe(31);
  });

  it('honours the detailed predicate for updates', () => {
    const events = realisticUpdates(3);
    const messages = renderDigest(events, { detailed: (e) => e === events[1], now: NOW });
    const embeds = messages.flatMap((m) => m.embeds!);
    expect(embeds.filter((e) => e.description!.startsWith('# '))).toHaveLength(1);
    expect(countItems(messages)).toBe(3);
  });
});

describe('changelog field', () => {
  const URL_ = 'https://x.io/changelog';
  const field = (event: ModEvent): string | undefined => renderDigest([event], allDetail)[0]!.embeds![0]!.fields?.find((f) => f.name === 'Changelog')?.value;
  const display = (event: ModEvent): string | undefined => displayTexts(renderImmediate(event, { now: NOW })).find((t) => t.startsWith('**Changelog**\n'))?.slice('**Changelog**\n'.length);
  const count = (text: string, part: string): number => text.split(part).length - 1;

  it('inserts an extracted excerpt exactly as the changelog module produced it', () => {
    const markdown = '## 1.0.0\n### Added\n- **bold** item with `code`\n```\nconst a = 1;\n```\n- [docs](https://example.com/d)';
    const excerpt = extractChangelog(markdown, '1.0.0', { fullUrl: URL_ });
    expect(excerpt).toBe('**Added**\n- **bold** item with \\`code\\`\n\\`\\`\\`\nconst a = 1;\n\\`\\`\\`\n- [docs](https://example.com/d)\n[Full changelog](https://x.io/changelog)');
    expect(field(makeEvent({ kind: 'new', changelog: excerpt, changelogUrl: URL_ }))).toBe(excerpt);
    expect(display(makeEvent({ kind: 'new', changelog: excerpt, changelogUrl: URL_ }))).toBe(excerpt);
  });

  it('shows exactly one full-changelog link when the excerpt already ends with it', () => {
    const excerpt = extractChangelog('## 1.0.0\n- a', '1.0.0', { fullUrl: URL_ })!;
    const value = field(makeEvent({ kind: 'new', changelog: excerpt, changelogUrl: URL_ }))!;
    expect(count(value, '[Full changelog](')).toBe(1);
  });

  it('adds the link itself when the excerpt carries none, and omits the field without an excerpt', () => {
    expect(field(makeEvent({ kind: 'new', changelog: '- a\n- b', changelogUrl: URL_ }))).toBe(`- a\n- b\n[Full changelog](${URL_})`);
    expect(field(makeEvent({ kind: 'new', changelog: null, changelogUrl: URL_ }))).toBeUndefined();
    expect(field(makeEvent({ kind: 'new', changelog: null, changelogUrl: null }))).toBeUndefined();
  });

  it('does not escape Markdown that is already final', () => {
    const value = field(makeEvent({ kind: 'new', changelog: '- **x**\n> quote\n1. one\n# head', changelogUrl: null }))!;
    expect(value).toBe('- **x**\n> quote\n1. one\n# head');
  });

  it('neutralises mentions and caps an oversized excerpt defensively', () => {
    const value = field(makeEvent({ kind: 'new', changelog: `@everyone <@123>\n${'x'.repeat(5000)}`, changelogUrl: URL_ }))!;
    expect(value).not.toMatch(/@(everyone|here)/);
    expect(value).not.toMatch(/<@\d+>/);
    expect(value.length).toBeLessThanOrEqual(CHANGELOG_DISPLAY_MAX);
    expect(value.endsWith(`[Full changelog](${URL_})`)).toBe(true);
    expect(value).toContain('…\n');
  });

  it('holds up against a hostile changelog through both layers', () => {
    const hostile = [
      '## 1.0.0',
      '- [click](javascript:alert(1)) and [data](data:text/html;base64,AAAA)',
      '- [Full changelog](https://evil.example/phish)',
      '- @everyone @here <@123456789> <@&99> <#5> </cmd:12345>',
      '- <script>alert(1)</script><img src=x onerror=alert(1)><b>bold</b>',
      '- [@everyone](https://ok.example/a)',
      '- ![img](https://evil.example/track.png)',
      '- text ||spoiler|| and [x](https://ok.example/p_(q))',
    ].join('\n');
    const excerpt = extractChangelog(hostile, '1.0.0', { fullUrl: URL_ });
    const messages = renderDigest([makeEvent({ kind: 'new', name: 'Hostile', changelog: excerpt, changelogUrl: URL_ })], noDetail);
    expect(display(makeEvent({ kind: 'new', name: 'Hostile', changelog: excerpt, changelogUrl: URL_ }))).toBe(messages[0]!.embeds![0]!.fields![0]!.value);
    const value = messages[0]!.embeds![0]!.fields![0]!.value;
    expect(count(value, '[Full changelog](')).toBe(1);
    expect(value.endsWith(`[Full changelog](${URL_})`)).toBe(true);
    expect(value).not.toMatch(/\]\(\s*(javascript|data):/i);
    expect(value).not.toContain('evil.example/phish');
    expect(value).not.toMatch(/@(everyone|here)/i);
    expect(value).not.toMatch(/<[@#][!&]?\d+>/);
    expect(value).not.toMatch(/<\/[\w -]+:\d+>/);
    expect(value).not.toMatch(/<\/?(script|img|b)\b/i);
    expect(value).toContain('](https://ok.example/p_%28q%29)');
    expect(value.length).toBeLessThanOrEqual(CHANGELOG_DISPLAY_MAX);
    expectValid(messages);
  });

  it('never exceeds the field limit for any extracted excerpt (property)', () => {
    const piece = fc.constantFrom('- item\n', '## 1.0.0\n', '```\n', '[a](https://a.example/b)', '[a](javascript:x)', '@everyone', '<@1>', '\n\n', 'x'.repeat(300), '~~~\n', '1. n\n', '<b>', '\\', '|');
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 60 }), fc.boolean(), (parts, withUrl) => {
        const excerpt = extractChangelog(parts.join(''), '1.0.0', { fullUrl: withUrl ? URL_ : null });
        const value = field(makeEvent({ kind: 'new', changelog: excerpt, changelogUrl: withUrl ? URL_ : null }));
        if (value !== undefined) {
          expect(value.length).toBeLessThanOrEqual(CHANGELOG_DISPLAY_MAX);
          expect(count(value, '[Full changelog](')).toBeLessThanOrEqual(1);
          expect(value).not.toMatch(/@(everyone|here)/i);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('escapeTruncate', () => {
  const SPECIAL = new Set(['\\', '*', '_', '~', '|', '`', '[', ']', '(', ')', '<', '>']);

  function reference(text: string, max: number): string {
    const chars = Array.from(text);
    const pieces: string[] = [];
    let len = 0;
    let col = 0;
    let onlyDigits = true;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      const next = chars[i + 1];
      const listDot = ch === '.' && col > 0 && onlyDigits && (next === undefined || next === ' ' || next === '\n');
      const escape = SPECIAL.has(ch) || (col === 0 && (ch === '-' || ch === '#')) || listDot;
      const piece = escape ? `\\${ch}` : ch;
      if (len + piece.length > max) {
        while (pieces.length > 0 && len + 1 > max) len -= pieces.pop()!.length;
        return max >= 1 ? `${pieces.join('')}…` : '';
      }
      pieces.push(piece);
      len += piece.length;
      if (ch === '\n') {
        col = 0;
        onlyDigits = true;
      } else {
        col += 1;
        if (ch < '0' || ch > '9') onlyDigits = false;
      }
    }
    return pieces.join('');
  }

  const pieces = fc.oneof(
    fc.constantFrom('\\', '*', '_', '~', '|', '`', '[', ']', '(', ')', '<', '>', '-', '#', '.', '1', '12', '3.', ' ', '\n', '\n-', '\n# ', '\n1. ', '\u{1F600}', '\ud83d', '\ude00', 'é', 'ab'),
    fc.string({ maxLength: 6 }),
  );
  const textArb = fc.array(pieces, { maxLength: 40 }).map((parts) => parts.join(''));

  it('matches the reference implementation on arbitrary text and limits (property)', () => {
    fc.assert(
      fc.property(textArb, fc.integer({ min: -1, max: 60 }), (text, max) => {
        expect(escapeTruncate(text, max)).toBe(reference(text, max));
      }),
      { numRuns: 3000 },
    );
  });

  it('matches the reference on the documented cases', () => {
    for (const [text, max] of [['- item', 50], ['1. item', 50], ['# h > q', 50], ['a\\b*c', 4], ['\\\\\\\\', 3], ['x'.repeat(100), 10], ['\u{1F600}'.repeat(10), 5], ['1.\n2.\n3.', 20]] as const) {
      expect(escapeTruncate(text, max), text).toBe(reference(text, max));
    }
  });
});

describe('unbounded fields are cut before they are processed', () => {
  const timed = (fn: () => void): number => bestOf(5, fn);

  it('renders a package with a megabyte of HTML description cheaply', () => {
    const description = '<b>x</b> '.repeat(120_000);
    expect(description.length).toBeGreaterThan(1_000_000);
    const event = makeEvent({ kind: 'new', description });
    expect(timed(() => renderImmediate(event, { now: NOW }))).toBeLessThan(10);
    expect(timed(() => renderDigest([event], allDetail))).toBeLessThan(10);
    const embed = renderDigest([event], allDetail)[0]!.embeds![0]!;
    expect(embed.description!.length).toBeLessThanOrEqual(DISCORD.embedDescriptionMax);
    expect(embed.description).toContain('x x x');
    expect(allText([renderImmediate(event, { now: NOW })])).toContain('x x x');
  });

  it('renders hundreds of 20 000-character names, owners and versions cheaply', () => {
    const long = 'N'.repeat(20_000);
    const events = Array.from({ length: 400 }, (_, i) => makeEvent({ name: long + i, owner: long, versionTo: long, versionFrom: long }, i));
    expect(timed(() => renderDigest(events, noDetail))).toBeLessThan(60);
    const messages = renderDigest(events, noDetail);
    expect(countItems(messages)).toBe(400);
    expectValid(messages);
  });

  it('keeps inline output identical below the scan window and cuts far beyond it', () => {
    expect(inline('a'.repeat(300), 300)).toBe('a'.repeat(300));
    const cut = inline('a'.repeat(2_000_000), 64);
    expect(cut).toBe(`${'a'.repeat(63)}…`);
    expect(() => encodeURIComponent(inline('\u{1F600}'.repeat(5000), 50))).not.toThrow();
  });
});

describe('formatBytes', () => {
  it('formats sizes', () => {
    expect(formatBytes(2_516_582)).toBe('2.4 MB');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024 * 1024 * 1.5)).toBe('1.5 GB');
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(Number.NaN)).toBeNull();
    expect(formatBytes(0)).toBeNull();
  });
});
