// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHANGELOG_EXCERPT_MAX } from '../core/constants.ts';
import { bestOf } from '../testing/timing.ts';
import { extractNexusChangelog } from './nexus.ts';

const FULL_URL = 'https://www.nexusmods.com/valheim/mods/1234?tab=logs';

const CHANGELOGS: Record<string, string[]> = {
  '1.2.4': ['Fixed crash on load', 'Added <b>new</b> config &amp; options', '* Already bulleted'],
  '1.2.3': ['Initial release'],
  '11.2.40': ['wrong'],
};

describe('extractNexusChangelog', () => {
  it('renders the exact version key as a bullet list', () => {
    expect(extractNexusChangelog(CHANGELOGS, '1.2.4')).toBe('- Fixed crash on load\n- Added new config & options\n- Already bulleted');
  });

  it('tolerates a leading v on either side', () => {
    expect(extractNexusChangelog(CHANGELOGS, 'v1.2.3')).toBe('- Initial release');
    expect(extractNexusChangelog({ 'v2.0.0': ['x'] }, '2.0.0')).toBe('- x');
  });

  it('does not match partial versions and never falls back', () => {
    expect(extractNexusChangelog(CHANGELOGS, '1.2')).toBeNull();
    expect(extractNexusChangelog(CHANGELOGS, '1.2.5')).toBeNull();
    expect(extractNexusChangelog(CHANGELOGS, '')).toBeNull();
  });

  it('returns null for empty or unusable entries', () => {
    expect(extractNexusChangelog({ '1.0.0': [] }, '1.0.0')).toBeNull();
    expect(extractNexusChangelog({ '1.0.0': ['', '  ', '<br>'] }, '1.0.0')).toBeNull();
    expect(extractNexusChangelog({ '1.0.0': 'text' as unknown as string[] }, '1.0.0')).toBeNull();
    expect(extractNexusChangelog(null as unknown as Record<string, string[]>, '1.0.0')).toBeNull();
    expect(extractNexusChangelog({}, '1.0.0')).toBeNull();
  });

  it('ignores non-string lines', () => {
    expect(extractNexusChangelog({ '1.0.0': ['ok', 5, null, { a: 1 }] as unknown as string[] }, '1.0.0')).toBe('- ok');
  });

  it('is not fooled by prototype keys', () => {
    expect(extractNexusChangelog({}, 'constructor')).toBeNull();
  });

  it('escapes Markdown control characters in lines', () => {
    expect(extractNexusChangelog({ '1.0.0': ['fix some_var_name and *bold*'] }, '1.0.0')).toBe('- fix some\\_var\\_name and \\*bold\\*');
  });

  it('neutralises mentions and strips HTML', () => {
    const out = extractNexusChangelog({ '1.0.0': ['@everyone <script>x</script>&#64;here <@123>', '<img src=x onerror=y>ok'] }, '1.0.0') ?? '';
    expect(out).not.toMatch(/@(everyone|here)/);
    expect(out).not.toContain('<@123>');
    expect(out).not.toMatch(/script|onerror/);
    expect(out).toContain('ok');
  });

  it('renders link syntax literally so no author link survives and the full-changelog link stays unique', () => {
    const out = extractNexusChangelog({ '1.0.0': ['[click](javascript:alert(1))', '[Full changelog](https://evil.example/x)', '[ok](https://a.example)'] }, '1.0.0', { fullUrl: FULL_URL }) ?? '';
    expect(out.slice(0, out.lastIndexOf('\n'))).not.toMatch(/(?<!\\)\]\(/);
    expect(out.match(/\[Full changelog\]\(/g)).toHaveLength(1);
    expect(out.endsWith(`\n[Full changelog](${FULL_URL})`)).toBe(true);
  });

  it('truncates on a line boundary with the ellipsis and link inside the budget', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `Change number ${i} with a fairly descriptive sentence`);
    const out = extractNexusChangelog({ '1.0.0': lines }, '1.0.0', { fullUrl: FULL_URL }) ?? '';
    expect(out.length).toBeLessThanOrEqual(CHANGELOG_EXCERPT_MAX);
    expect(out.endsWith(`…\n[Full changelog](${FULL_URL})`)).toBe(true);
    const bulletLines = out.split('\n').slice(0, -2);
    for (const line of bulletLines) expect(line).toMatch(/^- Change number \d+ with a fairly descriptive sentence$/);
  });

  it('adds an ellipsis when input lines were dropped before rendering', () => {
    const lines = Array.from({ length: 500 }, () => 'x');
    expect(extractNexusChangelog({ '1.0.0': lines }, '1.0.0', { maxChars: 5000 })?.endsWith('…')).toBe(true);
  });

  it('handles one enormous line quickly', () => {
    const lines = { '1.0.0': ['<'.repeat(300_000)] };
    expect((extractNexusChangelog(lines, '1.0.0') ?? '').length).toBeLessThanOrEqual(CHANGELOG_EXCERPT_MAX);
    expect(bestOf(5, () => extractNexusChangelog(lines, '1.0.0'))).toBeLessThan(50);
  });

  it('property: never throws and never exceeds maxChars', () => {
    const unicode = fc
      .array(fc.oneof(fc.integer({ min: 0, max: 0xd7ff }), fc.integer({ min: 0xe000, max: 0x10ffff })), { maxLength: 80 })
      .map((codePoints) => String.fromCodePoint(...codePoints));
    const hostileSurrogates = fc
      .array(fc.constantFrom('\uD800', '\uDBFF', '\uDC00', '\uDFFF', 'a', ' ', '\n'), { maxLength: 80 })
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(fc.array(fc.oneof(unicode, hostileSurrogates), { maxLength: 30 }), fc.integer({ min: 0, max: 300 }), fc.boolean(), (lines, maxChars, withLink) => {
        const out = extractNexusChangelog({ '1.0.0': lines }, '1.0.0', { maxChars, fullUrl: withLink ? FULL_URL : null });
        if (out !== null) {
          expect(out.length).toBeLessThanOrEqual(maxChars);
          expect(() => encodeURIComponent(out)).not.toThrow();
        }
      }),
      { numRuns: 300 },
    );
  });
});
