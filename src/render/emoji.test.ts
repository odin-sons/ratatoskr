// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DISCORD_CUSTOM_EMOJI } from '../core/constants.ts';
import { parseStoreEmojis, resolveStoreEmojis } from './emoji.ts';

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
