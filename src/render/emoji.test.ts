// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DISCORD_CUSTOM_EMOJI } from '../core/constants.ts';
import { BUTTON_EMOJI } from './layout.ts';
import { STORE_ORDER, STORES } from './stores.ts';
import { buttonEmoji, parseRatatoskrEmoji, resolveRatatoskrEmoji, parseStoreEmojis, resolveStoreEmojis } from './emoji.ts';

const TS = '<:thunderstore:123456789012345678>';
const HX = '<:hexium:123456789012345679>';
const NX = '<a:nexus:123456789012345680>';

function collect(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message) => void messages.push(message), messages };
}

describe('parseStoreEmojis', () => {
  it('accepts an object with valid custom emoji for known stores', () => {
    const w = collect();
    expect(parseStoreEmojis({ thunderstore: TS, hexium: HX, nexus: NX }, w.warn)).toEqual({ thunderstore: TS, hexium: HX, nexus: NX });
    expect(w.messages).toEqual([]);
  });

  it('accepts the same mapping as a JSON string', () => {
    const w = collect();
    expect(parseStoreEmojis(JSON.stringify({ thunderstore: TS }), w.warn)).toEqual({ thunderstore: TS });
    expect(w.messages).toEqual([]);
  });

  it('treats absent, empty and blank configuration as no emoji without a warning', () => {
    const w = collect();
    for (const raw of [undefined, null, {}, '', '   ', '{}']) expect(parseStoreEmojis(raw, w.warn)).toEqual({});
    expect(w.messages).toEqual([]);
  });

  it('ignores invalid and unknown entries with exactly one warning that names only the keys', () => {
    const w = collect();
    const result = parseStoreEmojis(
      {
        thunderstore: TS,
        hexium: ':hexium:',
        nexus: '<:nexus:12345>',
        steam: HX,
        '<@123456789012345678>': HX,
      },
      w.warn,
    );
    expect(result).toEqual({ thunderstore: TS });
    expect(w.messages).toHaveLength(1);
    expect(w.messages[0]).toContain('hexium');
    expect(w.messages[0]).toContain('nexus');
    expect(w.messages[0]).toContain('steam');
    expect(w.messages[0]).not.toContain(':hexium:');
    expect(w.messages[0]).not.toContain('12345');
    expect(w.messages[0]).not.toContain('@');
    expect(w.messages[0]!.length).toBeLessThan(200);
  });

  it('rejects markup that could smuggle content into the message', () => {
    const values = [
      `${TS} @everyone`,
      `${TS}\n`,
      `x${TS}`,
      '<:a:123456789012345678>',
      `<:${'a'.repeat(33)}:123456789012345678>`,
      '<:ok_name:1234567890123456>',
      `<:ok_name:${'1'.repeat(21)}>`,
      42,
      null,
      ['a'],
    ];
    for (const value of values) {
      const w = collect();
      expect(parseStoreEmojis({ thunderstore: value }, w.warn), String(value)).toEqual({});
      expect(w.messages).toHaveLength(1);
    }
  });

  it('never throws on malformed configuration and warns once', () => {
    for (const raw of ['not json', '[1,2]', '"str"', '42', 42, true, [TS], '{"thunderstore":', 'x'.repeat(10_000)]) {
      const w = collect();
      expect(parseStoreEmojis(raw, w.warn)).toEqual({});
      expect(w.messages).toHaveLength(1);
      expect(w.messages[0]).not.toContain('not json');
    }
  });

  it('ignores inherited properties', () => {
    const w = collect();
    const inherited = Object.create({ thunderstore: TS }) as Record<string, string>;
    expect(parseStoreEmojis(inherited, w.warn)).toEqual({});
    expect(parseStoreEmojis('{"__proto__":{"thunderstore":"x"}}', w.warn)).toEqual({});
  });

  it('only ever returns known store keys with regex-valid values (property)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 12 }), fc.oneof(fc.string({ maxLength: 60 }), fc.constant(TS), fc.integer())), (dict) => {
        const w = collect();
        const result = parseStoreEmojis(dict, w.warn);
        for (const [key, value] of Object.entries(result)) {
          expect(['thunderstore', 'hexium', 'nexus']).toContain(key);
          expect(DISCORD_CUSTOM_EMOJI.test(value)).toBe(true);
        }
        expect(w.messages.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });
});

describe('resolveStoreEmojis', () => {
  it('passes valid entries and silently drops anything else', () => {
    expect(resolveStoreEmojis({ thunderstore: TS, hexium: 'bad', nexus: `${NX} @everyone` })).toEqual({ thunderstore: TS });
    expect(resolveStoreEmojis(undefined)).toEqual({});
  });
});

describe('parseRatatoskrEmoji', () => {
  const RT = '<:ratatoskr:123456789012345681>';

  it('accepts valid custom emoji markup, static or animated, without a warning', () => {
    const w = collect();
    expect(parseRatatoskrEmoji(RT, w.warn)).toBe(RT);
    expect(parseRatatoskrEmoji('<a:squirrel:123456789012345682>', w.warn)).toBe('<a:squirrel:123456789012345682>');
    expect(parseRatatoskrEmoji(`  ${RT}  `, w.warn)).toBe(RT);
    expect(w.messages).toEqual([]);
  });

  it('treats absent and blank values as unset without a warning', () => {
    const w = collect();
    for (const empty of [undefined, null, '', '   ']) expect(parseRatatoskrEmoji(empty, w.warn)).toBeUndefined();
    expect(w.messages).toEqual([]);
  });

  it('ignores anything else with exactly one warning that names only the key', () => {
    for (const bad of [':ratatoskr:', '<:x:1>', '🐿️', RT + ' @everyone', 42, {}, ['x'], '<:name:123456789012345678> https://evil.example/token']) {
      const w = collect();
      expect(parseRatatoskrEmoji(bad, w.warn)).toBeUndefined();
      expect(w.messages).toHaveLength(1);
      expect(w.messages[0]).toContain('RATATOSKR_EMOJI');
      expect(w.messages[0]).not.toContain('evil');
      expect(w.messages[0]).not.toContain('everyone');
    }
  });

  it('is re-validated by the renderer', () => {
    expect(resolveRatatoskrEmoji(RT)).toBe(RT);
    for (const bad of [undefined, '', 'nope', RT + 'x', 5 as unknown as string]) expect(resolveRatatoskrEmoji(bad)).toBeNull();
  });
});

describe('buttonEmoji', () => {
  it('turns custom emoji markup into an id, name and animated flag', () => {
    expect(buttonEmoji('<:thunderstore:123456789012345678>')).toEqual({ id: '123456789012345678', name: 'thunderstore', animated: false });
    expect(buttonEmoji('<a:party:123456789012345679>')).toEqual({ id: '123456789012345679', name: 'party', animated: true });
  });

  it('keeps a unicode emoji as its name only', () => {
    expect(buttonEmoji('⚡')).toEqual({ name: '⚡' });
    expect(buttonEmoji('\u2b07\ufe0f')).toEqual({ name: '\u2b07\ufe0f' });
  });

  it('never emits markup-looking text as a unicode name', () => {
    expect(buttonEmoji('<:x:1>')).toBeNull();
    expect(buttonEmoji('<:name:123456789012345678> extra')).toBeNull();
    expect(buttonEmoji('')).toBeNull();
    expect(buttonEmoji('a'.repeat(40))).toBeNull();
  });
});

describe('unicode button emoji', () => {
  it('drops symbols that are not emoji, which Discord answers with a 400', () => {
    for (const symbol of [String.fromCodePoint(0x2b21), 'A', '1', '#', '*', '-', '•', String.fromCodePoint(0x2192), 'ab', '⚡x', '⚡ ⚡', String.fromCodePoint(0xfe0f)]) {
      expect(buttonEmoji(symbol), symbol).toBeNull();
    }
  });

  it('keeps single emoji, with variation selectors, skin tones and joined sequences', () => {
    for (const emoji of ['⚡', '🌀', '🔷', '🌐', String.fromCodePoint(0x1f43f, 0xfe0f), String.fromCodePoint(0x2b07, 0xfe0f), String.fromCodePoint(0x1f44d, 0x1f3fd), String.fromCodePoint(0x1f468, 0x200d, 0x1f4bb)]) {
      expect(buttonEmoji(emoji), emoji).toEqual({ name: emoji });
    }
  });

  it('accepts every built-in button emoji', () => {
    const builtIn = [...Object.values(BUTTON_EMOJI), ...STORE_ORDER.map((store) => STORES[store].buttonEmoji)];
    expect(builtIn.length).toBeGreaterThanOrEqual(6);
    for (const emoji of builtIn) expect(buttonEmoji(emoji), emoji).toEqual({ name: emoji });
  });

  it('is the only gate: a button never carries an emoji object that is neither custom nor pictographic (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), (text) => {
        const emoji = buttonEmoji(text);
        if (emoji !== null && emoji.id === undefined) expect(text).toMatch(/^\p{Extended_Pictographic}/u);
      }),
      { numRuns: 500 },
    );
  });
});
