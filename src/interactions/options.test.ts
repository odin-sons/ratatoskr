// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { interaction } from './commands/harness.ts';
import { parseOptions } from './options.ts';

const withOptions = (options: unknown[]) => parseOptions(interaction({ data: { name: 'x', options } }));

describe('parseOptions', () => {
  it('reads strings, integers and booleans by name', () => {
    const options = withOptions([
      { name: 'a', type: 3, value: 'text' },
      { name: 'n', type: 4, value: 7 },
      { name: 'b', type: 5, value: true },
    ]);
    expect([options.string('a'), options.integer('n'), options.boolean('b')]).toEqual(['text', 7, true]);
    expect([options.string('missing'), options.integer('missing'), options.boolean('missing')]).toEqual([undefined, undefined, undefined]);
  });

  it('treats a value of the wrong type as absent', () => {
    const options = withOptions([
      { name: 'a', type: 3, value: 5 },
      { name: 'n', type: 4, value: 1.5 },
      { name: 'b', type: 5, value: 'true' },
    ]);
    expect([options.string('a'), options.integer('n'), options.boolean('b')]).toEqual([undefined, undefined, undefined]);
  });

  it('skips malformed entries without throwing', () => {
    const options = withOptions([null, 'x', [], { value: 'a' }, { name: 5, value: 'a' }, { name: 'obj', value: {} }, { name: 'ok', value: 'fine' }]);
    expect(options.string('ok')).toBe('fine');
    expect(options.string('obj')).toBeUndefined();
  });

  it('reports the focused option of an autocomplete request', () => {
    expect(withOptions([{ name: 'owner', type: 3, value: 'ra', focused: true }]).focused).toEqual({ name: 'owner', value: 'ra' });
    expect(withOptions([{ name: 'owner', type: 3, value: 'ra' }]).focused).toBeUndefined();
  });

  it('has no options for a payload without data', () => {
    expect(parseOptions(interaction()).string('a')).toBeUndefined();
  });
});
