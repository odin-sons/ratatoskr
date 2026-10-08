// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { en } from '../../i18n/en.ts';
import { analyzeTemplate } from './analyze.ts';
import { DEFAULT_DIGEST_LINE_SOURCE, defaultImmediateSource } from './defaults.ts';
import { parseTemplate } from './parse.ts';

const warnings = (source: string, kind: 'immediate' | 'digest_line' = 'immediate') => analyzeTemplate(parseTemplate(source), kind);

describe('analyzeTemplate', () => {
  it('finds nothing wrong with the default templates', () => {
    expect(warnings(defaultImmediateSource(en))).toEqual([]);
    expect(warnings(DEFAULT_DIGEST_LINE_SOURCE, 'digest_line')).toEqual([]);
  });

  it('reports an unknown variable once', () => {
    expect(warnings('{name:link} {nothing} {nothing}')).toEqual([{ code: 'unknown_variable', name: 'nothing' }]);
  });

  it('reports an ignored form but not a limit', () => {
    expect(warnings('{name:link} {changelog:tiny:300:l2} {owner:bold}')).toEqual([
      { code: 'ignored_form', name: 'changelog', form: 'tiny' },
      { code: 'ignored_form', name: 'owner', form: 'bold' },
    ]);
  });

  it('warns about a template without any link to the mod', () => {
    expect(warnings('{owner} {versions}')).toEqual([{ code: 'no_mod_link' }]);
    expect(warnings('{owner} {url}')).toEqual([]);
    expect(warnings('{owner}\n---\n{page_button}')).toEqual([]);
    expect(warnings('')).toEqual([]);
  });

  it('tells a digest line that a variable of the message is not available there', () => {
    expect(warnings('{name:link} {changelog}', 'digest_line')).toEqual([{ code: 'unavailable_in_line', name: 'changelog' }]);
    expect(warnings('{name:link} {nothing}', 'digest_line')).toEqual([{ code: 'unknown_variable', name: 'nothing' }]);
  });

  it('passes on the warning of the parser', () => {
    expect(warnings('{name:link}'.repeat(120))).toContainEqual({ code: 'too_many_variables' });
  });
});
