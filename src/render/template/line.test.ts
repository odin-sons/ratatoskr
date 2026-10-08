// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { makeEvent } from '../../testing/fakes.ts';
import { prepare } from '../compact.ts';
import { renderDigest } from '../index.ts';
import { renderLine, LINE_MAX_CHARS } from './line.ts';
import { parseTemplate } from './parse.ts';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const ctx = { storeEmojis: { thunderstore: '<:ts:123456789012345678>' } };
const mod = (pkg: Record<string, unknown> = {}) =>
  prepare(makeEvent({ kind: 'update', versionFrom: '1.0.0', versionTo: '1.1.0', pkg: { owner: 'Bob', name: 'Warfare', url: 'https://example.com/mod', sizeBytes: 2_500_000, ...pkg } }));
const line = (source: string | null, p = mod()) => renderLine(source === null ? null : parseTemplate(source), p, ctx);

describe('the line of a mod in a digest', () => {
  it('is the default line without a template', () => {
    expect(line(null)).toBe('**[Warfare](https://example.com/mod)** 1.0.0 → 1.1.0 · Bob · 2.4 MB');
  });

  it('follows a custom template', () => {
    expect(line('{owner}: {name:link} {versions}')).toBe('Bob: [Warfare](https://example.com/mod) 1.0.0 → 1.1.0');
    expect(line('{store_emoji}{name} {version}')).toBe('<:ts:123456789012345678>Warfare 1.1.0');
  });

  it('drops an optional part and a whole line whose values are empty', () => {
    expect(line('{name}(? by {owner}?)(? [{size}]?)', mod({ owner: '', sizeBytes: null }))).toBe('Warfare');
    expect(line('{owner}\n{name}', mod({ owner: '' }))).toBe('Warfare');
  });

  it('ignores a form it does not know and a variable it does not have', () => {
    expect(line('{name:tiny} {changelog}')).toBe('Warfare');
  });

  it('joins several lines into one and cuts a value to its limit', () => {
    expect(line('{name}\n{versions}')).toBe('Warfare 1.0.0 → 1.1.0');
    expect(line('{name:3}')).toBe('Wa…');
  });

  it('falls back to the default line when the template gives nothing or too much', () => {
    const fallback = line(null);
    expect(line('{nothing}')).toBe(fallback);
    expect(line('')).toBe(fallback);
    expect(line(`${'x'.repeat(LINE_MAX_CHARS)} {name}`)).toBe(fallback);
  });

  it('is used by a digest at its first level and every mod is still listed', () => {
    const events = Array.from({ length: 3 }, (_, i) => makeEvent({ kind: 'update', versionFrom: '1.0.0', versionTo: '1.1.0', pkg: { owner: 'Bob', name: `Mod${i}`, packageId: `Bob-Mod${i}` } }));
    const messages = renderDigest(events, { now: NOW, detailed: () => false, digestLineTemplate: parseTemplate('{name} -> {version}') });
    const text = messages.map((m) => m.embeds!.map((e) => e.description ?? '').join('\n')).join('\n');
    for (let i = 0; i < 3; i += 1) expect(text).toContain(`Mod${i} -> 1.1.0`);
  });

  it('never throws and never returns an empty line, whatever the template', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (source) => {
        expect(line(source).length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });
});
