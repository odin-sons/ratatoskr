// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseTemplate, type Line, type Part } from './parse.ts';

const textLine = (line: Line | undefined): Part[] => {
  if (line === undefined || line.kind !== 'text') throw new Error('not a text line');
  return line.parts;
};

describe('parseTemplate: variables', () => {
  it('reads a variable with a form, a character limit and a line limit in any order', () => {
    const parsed = parseTemplate('{changelog:full:300:l3} {changelog:l2:short:50}');
    expect(textLine(parsed.blocks[0]!.lines[0])).toEqual([
      { t: 'var', name: 'changelog', forms: ['full'], chars: 300, lines: 3 },
      { t: 'text', text: ' ' },
      { t: 'var', name: 'changelog', forms: ['short'], chars: 50, lines: 2 },
    ]);
  });

  it('lets the last limit of a kind win and keeps unknown words as forms for the registry to judge', () => {
    const parsed = parseTemplate('{changelog:10:20:l1:l4:weird}');
    expect(textLine(parsed.blocks[0]!.lines[0])).toEqual([{ t: 'var', name: 'changelog', forms: ['weird'], chars: 20, lines: 4 }]);
  });

  it('lowercases names and forms and allows spaces around them', () => {
    const parsed = parseTemplate('{ Name : LINK }');
    expect(textLine(parsed.blocks[0]!.lines[0])).toEqual([{ t: 'var', name: 'name', forms: ['link'] }]);
  });

  it('turns {{ and }} into literal braces', () => {
    const parsed = parseTemplate('a {{b}} {c}');
    expect(textLine(parsed.blocks[0]!.lines[0])).toEqual([{ t: 'text', text: 'a {b} ' }, { t: 'var', name: 'c', forms: [] }]);
  });

  it.each(['{ }', '{"a":1}', '{1abc}', '{na me}', '{a:b:c d}', '{', 'x { y', '}'])('keeps %j as plain text', (source) => {
    const parsed = parseTemplate(source);
    const parts = textLine(parsed.blocks[0]!.lines[0]);
    expect(parts.every((part) => part.t === 'text')).toBe(true);
    expect(parts.map((part) => (part.t === 'text' ? part.text : '')).join('')).toBe(source);
  });
});

describe('parseTemplate: optional parts', () => {
  it('reads (? ... ?) as an optional part holding text and variables', () => {
    const parsed = parseTemplate('{name}(? · {owner}?)');
    expect(textLine(parsed.blocks[0]!.lines[0])).toEqual([
      { t: 'var', name: 'name', forms: [] },
      { t: 'opt', parts: [{ t: 'text', text: ' · ' }, { t: 'var', name: 'owner', forms: [] }] },
    ]);
  });

  it('keeps an unclosed or a nested marker as text', () => {
    const open = parseTemplate('a(? b');
    expect(textLine(open.blocks[0]!.lines[0])).toEqual([{ t: 'text', text: 'a(? b' }]);
    const nested = parseTemplate('(? a (? b ?) c ?)');
    const parts = textLine(nested.blocks[0]!.lines[0]);
    expect(parts[0]).toMatchObject({ t: 'opt' });
  });
});

describe('parseTemplate: lines and blocks', () => {
  it('splits blocks at a line that is exactly ---', () => {
    const parsed = parseTemplate('a\n---\nb\n  ---  \nc\n----\n');
    expect(parsed.blocks.map((block) => block.lines.length)).toEqual([1, 1, 2]);
  });

  it('accepts CRLF and drops empty blocks', () => {
    const parsed = parseTemplate('a\r\n---\r\n---\r\nb');
    expect(parsed.blocks).toHaveLength(2);
  });

  it('recognises a line made only of button variables as a row', () => {
    const parsed = parseTemplate('{buttons}\n{page_button} {info_button}\n{buttons} text');
    expect(parsed.blocks[0]!.lines).toEqual([
      { kind: 'row', buttons: ['buttons'] },
      { kind: 'row', buttons: ['page_button', 'info_button'] },
      expect.objectContaining({ kind: 'text' }),
    ]);
  });

  it('keeps the thumbnail marker as a variable', () => {
    const parsed = parseTemplate('{icon}{title}');
    expect(textLine(parsed.blocks[0]!.lines[0])).toEqual([{ t: 'var', name: 'icon', forms: [] }, { t: 'var', name: 'title', forms: [] }]);
  });
});

describe('parseTemplate: limits and safety', () => {
  it('cuts the source at the template cap and strips control characters', () => {
    const parsed = parseTemplate(`a\u0000b${'x'.repeat(5000)}`);
    const text = textLine(parsed.blocks[0]!.lines[0]).map((part) => (part.t === 'text' ? part.text : '')).join('');
    expect(text.startsWith('ab')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('ignores variables past the cap and says so', () => {
    const parsed = parseTemplate('{name}'.repeat(150));
    const vars = parsed.blocks.flatMap((block) => block.lines.flatMap((line) => (line.kind === 'text' ? line.parts : []))).filter((part) => part.t === 'var');
    expect(vars.length).toBe(100);
    expect(parsed.warnings).toContainEqual({ code: 'too_many_variables' });
  });

  it('returns no blocks for an empty template', () => {
    expect(parseTemplate('').blocks).toEqual([]);
    expect(parseTemplate('   \n \n').blocks).toEqual([]);
  });

  it('never throws, whatever the input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 3000 }), (source) => {
        const parsed = parseTemplate(source);
        expect(Array.isArray(parsed.blocks)).toBe(true);
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.array(fc.constantFrom('{', '}', '{{', '}}', '(?', '?)', ':', '---', '\n', 'name', 'l3', '300', ' ', 'icon', 'buttons'), { maxLength: 80 }), (pieces) => {
        expect(() => parseTemplate(pieces.join(''))).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});
