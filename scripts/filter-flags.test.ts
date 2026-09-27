// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { resolveFilter } from './filter-flags.ts';

const noFile = (): string => {
  throw new Error('unexpected file read');
};

describe('resolveFilter', () => {
  it('defaults to the empty filter', () => {
    expect(resolveFilter({}, noFile)).toEqual({});
  });

  it('builds a filter from the convenience flags', () => {
    expect(
      resolveFilter(
        {
          source: ['hexium:valheim'],
          kind: ['update'],
          package: ['Owner-Name', 'Owner'],
          'exclude-package': ['Noisy-Mod'],
          category: ['Tweaks'],
          'exclude-category': ['Cosmetics'],
          'allow-nsfw': true,
        },
        noFile,
      ),
    ).toEqual({
      sources: ['hexium:valheim'],
      kinds: ['update'],
      packages: ['Owner-Name', 'Owner'],
      excludePackages: ['Noisy-Mod'],
      includeCategories: ['Tweaks'],
      excludeCategories: ['Cosmetics'],
      allowNsfw: true,
    });
  });

  it('only sets the keys that were given', () => {
    expect(resolveFilter({ package: ['Owner'] }, noFile)).toEqual({ packages: ['Owner'] });
    expect(resolveFilter({ 'allow-nsfw': false }, noFile)).toEqual({});
  });

  it('drops repeated values and keeps the first order', () => {
    expect(resolveFilter({ source: ['a:b', 'c:d', 'a:b'], kind: ['new', 'new'] }, noFile)).toEqual({
      sources: ['a:b', 'c:d'],
      kinds: ['new'],
    });
  });

  it.each(['delete', '', 'NEW'])('rejects the kind %j', (kind) => {
    expect(() => resolveFilter({ kind: [kind] }, noFile)).toThrow(/--kind/);
  });

  it('parses a raw JSON filter', () => {
    expect(resolveFilter({ filter: '{"allowNsfw":true}' }, noFile)).toEqual({ allowNsfw: true });
  });

  it('reads a filter file through the injected reader', () => {
    expect(resolveFilter({ 'filter-file': 'f.json' }, (path) => (path === 'f.json' ? '{"kinds":["new"]}' : ''))).toEqual({
      kinds: ['new'],
    });
  });

  it('rejects invalid raw JSON without echoing the input', () => {
    expect(() => resolveFilter({ filter: '{"packages":["secret"' }, noFile)).toThrow(/valid JSON/);
    try {
      resolveFilter({ filter: '{"packages":["secret"' }, noFile);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('secret');
    }
  });

  it('rejects --filter together with --filter-file', () => {
    expect(() => resolveFilter({ filter: '{}', 'filter-file': 'f.json' }, noFile)).toThrow(/not both/);
  });

  it.each([
    ['source', { source: ['a:b'] }],
    ['kind', { kind: ['new'] }],
    ['package', { package: ['a'] }],
    ['exclude-package', { 'exclude-package': ['a'] }],
    ['category', { category: ['a'] }],
    ['exclude-category', { 'exclude-category': ['a'] }],
    ['allow-nsfw', { 'allow-nsfw': true }],
  ])('rejects raw JSON combined with --%s', (flag, extra) => {
    expect(() => resolveFilter({ filter: '{}', ...extra }, noFile)).toThrow(new RegExp(`--${flag}`));
    expect(() => resolveFilter({ 'filter-file': 'f.json', ...extra }, noFile)).toThrow(/not both|cannot be combined/);
  });
});
