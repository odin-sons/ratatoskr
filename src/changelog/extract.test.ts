// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHANGELOG_EXCERPT_MAX } from '../core/constants.ts';
import { extractChangelog } from './extract.ts';

const ZWSP = String.fromCharCode(0x200b);
const FULL_URL = 'https://thunderstore.io/c/valheim/p/Author/Mod/changelog/';
const FULL_LINK = `[Full changelog](${FULL_URL})`;

const STANDARD = `# Changelog

All notable changes are documented here.

## 1.2.4

- Fixed a crash when loading old saves
- Added a config option for spawn rate

## 1.2.3

- Initial multiplayer support

## 1.2.2

- Bug fixes
`;

describe('section selection', () => {
  it('takes the section whose heading holds the version', () => {
    expect(extractChangelog(STANDARD, '1.2.4')).toBe('- Fixed a crash when loading old saves\n- Added a config option for spawn rate');
    expect(extractChangelog(STANDARD, '1.2.3')).toBe('- Initial multiplayer support');
  });

  it('handles bracketed versions with dates', () => {
    const md = '## [Unreleased]\n\n- nothing\n\n## [1.2.4] - 2026-01-01\n\n### Fixed\n\n- crash\n\n## [1.2.3] - 2025-12-01\n\n- old\n';
    expect(extractChangelog(md, '1.2.4')).toBe('**Fixed**\n\n- crash');
  });

  it('handles a leading v in the heading and in the argument', () => {
    const md = '### v1.2.4\n- new stuff\n\n### v1.2.3\n- old stuff\n';
    expect(extractChangelog(md, '1.2.4')).toBe('- new stuff');
    expect(extractChangelog(md, 'v1.2.3')).toBe('- old stuff');
  });

  it('handles "1.2.4 - 2026-01-01" and "Version 1.2.4" headings', () => {
    expect(extractChangelog('## 1.2.4 - 2026-01-01\n- a\n## 1.2.3\n- b', '1.2.4')).toBe('- a');
    expect(extractChangelog('## Version 1.2.4\n- a\n## Version 1.2.3\n- b', '1.2.4')).toBe('- a');
  });

  it('matches the version as a whole token', () => {
    const md = '## 11.2.40\n- wrong one\n\n## 1.2.4.1\n- wrong two\n\n## 0.1.2.4\n- wrong three\n\n## 1.2.4-beta.1\n- wrong four\n\n## 1.2.4\n- right\n';
    expect(extractChangelog(md, '1.2.4')).toBe('- right');
  });

  it('accepts a trailing sentence period after the version', () => {
    expect(extractChangelog('## Released 1.2.4.\n- ok\n## 1.2.3\n- b', '1.2.4')).toBe('- ok');
  });

  it('keeps sub-headings inside the matched section and stops at the next sibling', () => {
    const md = '## 1.2.4\n### Added\n- a\n### Fixed\n- b\n## 1.2.3\n- c';
    expect(extractChangelog(md, '1.2.4')).toBe('**Added**\n- a\n**Fixed**\n- b');
  });

  it('stops at a heading of a higher level too', () => {
    const md = '### 1.2.4\n- a\n## Older releases\n- b';
    expect(extractChangelog(md, '1.2.4')).toBe('- a');
  });

  it('falls back to the first release section when no heading matches', () => {
    expect(extractChangelog(STANDARD, '9.9.9')).toBe('- Fixed a crash when loading old saves\n- Added a config option for spawn rate');
  });

  it('falls back to the first non-empty section when no heading looks like a version', () => {
    const md = '## Unreleased\n\n## Added\n- thing\n\n## Fixed\n- other\n';
    expect(extractChangelog(md, '1.0.0')).toBe('- thing');
  });

  it('uses the whole text when there are no headings', () => {
    expect(extractChangelog('Fixed a few bugs.\n\nImproved performance.', '1.0.0')).toBe('Fixed a few bugs.\n\nImproved performance.');
  });

  it('returns null for null, undefined, empty and whitespace input', () => {
    expect(extractChangelog(null, '1.0.0')).toBeNull();
    expect(extractChangelog(undefined, '1.0.0')).toBeNull();
    expect(extractChangelog('', '1.0.0')).toBeNull();
    expect(extractChangelog(' \n\t\r\n ', '1.0.0')).toBeNull();
  });

  it('returns null when the matched section is empty', () => {
    expect(extractChangelog('## 1.2.4\n\n## 1.2.3\n- old', '1.2.4')).toBeNull();
  });

  it('returns null when every section is empty', () => {
    expect(extractChangelog('# Changelog\n\n## 1.0.0\n', '2.0.0')).toBeNull();
  });

  it('does not throw on non-string input', () => {
    expect(extractChangelog({ markdown: 'x' } as unknown as string, '1.0.0')).toBeNull();
  });

  it('works with an empty version by falling back', () => {
    expect(extractChangelog(STANDARD, '')).toBe('- Fixed a crash when loading old saves\n- Added a config option for spawn rate');
  });
});

describe('line endings', () => {
  it('handles CRLF', () => {
    const md = STANDARD.replace(/\n/g, '\r\n');
    const out = extractChangelog(md, '1.2.3');
    expect(out).toBe('- Initial multiplayer support');
    expect(out).not.toContain('\r');
  });

  it('handles lone CR', () => {
    expect(extractChangelog('## 1.0.0\r- a\r## 0.9.0\r- b', '1.0.0')).toBe('- a');
  });
});

describe('code fences', () => {
  it('does not treat # inside a fence as a heading', () => {
    const md = '## 1.2.4\n\nRun:\n\n```bash\n# install deps\n## still code\nnpm i\n```\n\n- done\n\n## 1.2.3\n- old';
    const out = extractChangelog(md, '1.2.4');
    expect(out).toBe('Run:\n\n```bash\n# install deps\n## still code\nnpm i\n```\n\n- done');
  });

  it('does not match a version that only appears inside a fence', () => {
    const md = '## 1.2.3\n```\n## 1.2.4\n```\n- x\n## 1.2.2\n- y';
    expect(extractChangelog(md, '1.2.4')).toBe('```\n## 1.2.4\n```\n- x');
  });

  it('honours tilde fences and longer closing fences', () => {
    const md = '## 1.0.0\n~~~\n# no\n~~~\n````\n# no\n```\n# still code\n````\n- end\n## 0.9.0\n- z';
    expect(extractChangelog(md, '1.0.0')).toContain('- end');
  });

  it('does not mangle angle brackets inside fences', () => {
    const md = '## 1.0.0\n```cs\nList<string> names = new List<string>();\n```';
    expect(extractChangelog(md, '1.0.0')).toBe('```cs\nList<string> names = new List<string>();\n```');
  });

  it('closes an unterminated fence', () => {
    const out = extractChangelog('## 1.0.0\n- a\n```\ncode', '1.0.0');
    expect(out).toBe('- a\n```\ncode\n```');
  });
});

describe('markdown conversion', () => {
  it('turns nested headings into bold and drops closing hashes', () => {
    expect(extractChangelog('## 1.0.0\n#### Fixed ####\n- a\n##### Deep\n- b', '1.0.0')).toBe('**Fixed**\n- a\n**Deep**\n- b');
  });

  it('replaces images with their alt text and keeps links', () => {
    expect(extractChangelog('## 1.0.0\n![build](https://img.example/b.svg) see [docs](https://example.com)', '1.0.0')).toBe(
      'build see [docs](https://example.com)',
    );
    expect(extractChangelog('## 1.0.0\n![](https://img.example/b.svg)- x', '1.0.0')).toBe('- x');
  });

  it('collapses runs of blank lines', () => {
    expect(extractChangelog('## 1.0.0\n- a\n\n\n\n\n- b', '1.0.0')).toBe('- a\n\n- b');
  });
});

describe('untrusted input', () => {
  it('neutralises broadcast and tagged mentions', () => {
    const out = extractChangelog('## 1.0.0\n@everyone @here <@123> <@!123> <@&123> <#123> ＠everyone', '1.0.0') ?? '';
    expect(out).not.toMatch(/@(everyone|here)/);
    expect(out).not.toMatch(/<[@#]/);
    expect(out).toContain(ZWSP);
  });

  it('neutralises mentions reassembled by markup removal', () => {
    const out = extractChangelog('## 1.0.0\n@<b></b>everyone @![](x)here', '1.0.0') ?? '';
    expect(out).not.toMatch(/@(everyone|here)/);
  });

  it('neutralises mentions produced by entity decoding', () => {
    const out = extractChangelog('## 1.0.0\n&#64;everyone &#x40;here &lt;@123&gt;', '1.0.0') ?? '';
    expect(out).not.toMatch(/@(everyone|here)/);
    expect(out).not.toContain('<@123>');
  });

  it('strips HTML', () => {
    const md = '## 1.0.0\n<script>alert(1)</script><img src=x onerror=alert(1)><details><summary>More</summary><p>Body &amp; soul</p></details><br>tail';
    const out = extractChangelog(md, '1.0.0') ?? '';
    expect(out).not.toMatch(/<|alert|onerror/);
    expect(out).toContain('Body & soul');
    expect(out).toContain('tail');
  });

  it('strips control and bidi characters', () => {
    const out = extractChangelog(`## 1.0.0\nfix${String.fromCharCode(0x202e)}ed${String.fromCharCode(0)}!`, '1.0.0');
    expect(out).toBe('fixed!');
  });
});

describe('truncation', () => {
  const bullets = (n: number): string => Array.from({ length: n }, (_, i) => `- change number ${i} with a fairly descriptive sentence`).join('\n');

  it('returns short sections untouched', () => {
    expect(extractChangelog('## 1.0.0\n- a', '1.0.0', { maxChars: 50 })).toBe('- a');
  });

  it('defaults to CHANGELOG_EXCERPT_MAX and cuts on a line boundary', () => {
    const out = extractChangelog(`## 1.0.0\n${bullets(100)}`, '1.0.0') ?? '';
    expect(out.length).toBeLessThanOrEqual(CHANGELOG_EXCERPT_MAX);
    expect(out.endsWith('…')).toBe(true);
    const lines = out.slice(0, -1).split('\n');
    for (const line of lines) expect(line).toMatch(/^- change number \d+ with a fairly descriptive sentence$/);
  });

  it('never cuts inside a Markdown link straddling the limit', () => {
    const line = '- see [the migration guide](https://example.com/very/long/path/to/the/guide) for details';
    const head = '- first line here';
    for (let maxChars = head.length + 2; maxChars < head.length + line.length + 4; maxChars++) {
      const out = extractChangelog(`## 1.0.0\n${head}\n${line}\n- tail`, '1.0.0', { maxChars }) ?? '';
      expect(out.length).toBeLessThanOrEqual(maxChars);
      const opens = (out.match(/\[/g) ?? []).length;
      const closes = (out.match(/\]/g) ?? []).length;
      expect(opens).toBe(closes);
      if (out.includes('](')) expect(out).toContain(') for details');
    }
  });

  it('drops a half link from a single overlong line', () => {
    const md = `## 1.0.0\nSee [${'x'.repeat(50)}](https://example.com/${'y'.repeat(50)}) now`;
    const out = extractChangelog(md, '1.0.0', { maxChars: 40 }) ?? '';
    expect(out).toBe('See…');
  });

  it('hard-cuts an overlong single line without splitting a surrogate pair', () => {
    for (let maxChars = 3; maxChars < 12; maxChars++) {
      const out = extractChangelog(`## 1.0.0\n${'\u{1F600}'.repeat(50)}`, '1.0.0', { maxChars }) ?? '';
      expect(out.length).toBeLessThanOrEqual(maxChars);
      expect(() => encodeURIComponent(out)).not.toThrow();
    }
  });

  it('omits a partial fence instead of cutting through it', () => {
    const md = `## 1.0.0\n- intro\n\`\`\`\n${'code line\n'.repeat(60)}\`\`\`\n- outro`;
    const out = extractChangelog(md, '1.0.0', { maxChars: 200 });
    expect(out).toBe('- intro…');
  });

  it('closes a fence when it is the only content that fits', () => {
    const md = `## 1.0.0\n\`\`\`\n${'code line\n'.repeat(60)}\`\`\``;
    const out = extractChangelog(md, '1.0.0', { maxChars: 60 }) ?? '';
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.startsWith('```\ncode line')).toBe(true);
    expect(out.endsWith('\n```\n…')).toBe(true);
  });

  it('returns a complete fence followed by an ellipsis on its own line', () => {
    const md = '## 1.0.0\n```\na\n```\n' + 'x'.repeat(200);
    const out = extractChangelog(md, '1.0.0', { maxChars: 30 });
    expect(out).toBe('```\na\n```\n…');
  });

  it('returns null when maxChars is not usable', () => {
    expect(extractChangelog(STANDARD, '1.2.4', { maxChars: 0 })).toBeNull();
    expect(extractChangelog(STANDARD, '1.2.4', { maxChars: Number.NaN })).toBeNull();
  });

  it('handles a one-character budget', () => {
    expect(extractChangelog('## 1.0.0\n- abc', '1.0.0', { maxChars: 1 })).toBe('…');
  });
});

describe('full changelog link', () => {
  const long = `## 1.0.0\n${Array.from({ length: 60 }, (_, i) => `- item ${i} describing a change`).join('\n')}`;

  it('is appended inside the budget after the ellipsis', () => {
    const out = extractChangelog(long, '1.0.0', { fullUrl: FULL_URL }) ?? '';
    expect(out.length).toBeLessThanOrEqual(CHANGELOG_EXCERPT_MAX);
    expect(out.endsWith(`…\n${FULL_LINK}`)).toBe(true);
  });

  it('is appended to short excerpts too, reserving its room', () => {
    expect(extractChangelog('## 1.0.0\n- a', '1.0.0', { fullUrl: FULL_URL })).toBe(`- a\n${FULL_LINK}`);
  });

  it('shrinks the body so that the total never exceeds maxChars', () => {
    const md = `## 1.0.0\n- ${'a'.repeat(30)}\n- ${'b'.repeat(30)}`;
    const shortUrl = 'https://x.io/c';
    const shortLink = '[Full changelog](' + shortUrl + ')';
    const maxChars = shortLink.length + 1 + 42;
    const out = extractChangelog(md, '1.0.0', { maxChars, fullUrl: shortUrl }) ?? '';
    expect(out.length).toBeLessThanOrEqual(maxChars);
    expect(out).toBe(`- ${'a'.repeat(30)}…\n${shortLink}`);
  });

  it('is omitted when it would take half the budget or more', () => {
    const out = extractChangelog(long, '1.0.0', { maxChars: FULL_LINK.length * 2, fullUrl: FULL_URL }) ?? '';
    expect(out).not.toContain('Full changelog');
    expect(out.length).toBeLessThanOrEqual(FULL_LINK.length * 2);
  });

  it('is omitted for null, empty and non-http URLs', () => {
    for (const fullUrl of [null, '', 'javascript:alert(1)', 'ftp://x/y']) {
      expect(extractChangelog('## 1.0.0\n- a', '1.0.0', { fullUrl })).toBe('- a');
    }
  });

  it('percent-encodes characters that would break the Markdown link', () => {
    const out = extractChangelog('## 1.0.0\n- a', '1.0.0', { fullUrl: 'https://example.com/a b/(c)' }) ?? '';
    expect(out).toBe('- a\n[Full changelog](https://example.com/a%20b/%28c%29)');
  });

  it('is never placed inside an open code fence', () => {
    const out = extractChangelog('## 1.0.0\n```\ncode', '1.0.0', { fullUrl: FULL_URL }) ?? '';
    expect(out).toBe(`\`\`\`\ncode\n\`\`\`\n${FULL_LINK}`);
  });
});

describe('performance', () => {
  const section = (v: string): string => `## ${v}\n\n### Added\n\n- Something new in ${v}\n- Another [link](https://example.com/${v}) here\n\n### Fixed\n\n- A bug\n\n`;

  it('finds a section at the very end of a ~200 KB changelog', () => {
    let md = '# Changelog\n\n';
    let i = 0;
    while (md.length < 200_000) md += section(`2.${i++}.0`);
    md += section('1.0.0');
    const start = performance.now();
    const out = extractChangelog(md, '1.0.0');
    const elapsed = performance.now() - start;
    expect(out).toContain('Something new in 1.0.0');
    expect(elapsed).toBeLessThan(50);
  });

  it('falls back quickly on a ~200 KB changelog with no match', () => {
    let md = '';
    let i = 0;
    while (md.length < 200_000) md += section(`2.${i++}.0`);
    const start = performance.now();
    expect(extractChangelog(md, '9.9.9')).toContain('Something new in 2.0.0');
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('handles one enormous section', () => {
    const md = `## 1.0.0\n${'- a long-ish bullet point about a change\n'.repeat(5000)}## 0.9.0\n- old`;
    const start = performance.now();
    const out = extractChangelog(md, '1.0.0') ?? '';
    expect(out.length).toBeLessThanOrEqual(CHANGELOG_EXCERPT_MAX);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('handles adversarial single-line inputs', () => {
    const inputs = ['<'.repeat(200_000), '![['.repeat(60_000), '['.repeat(200_000), '#'.repeat(200_000), '```'.repeat(60_000), '<script>'.repeat(20_000)];
    for (const md of inputs) {
      const start = performance.now();
      extractChangelog(md, '1.0.0');
      extractChangelog(`## 1.0.0\n${md}`, '1.0.0', { fullUrl: FULL_URL });
      expect(performance.now() - start).toBeLessThan(100);
    }
  });

  it('handles many tiny headings and lines', () => {
    const md = '## x\n'.repeat(40_000);
    const start = performance.now();
    extractChangelog(md, '1.0.0');
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe('properties', () => {
  const markdownish = fc
    .array(fc.oneof(fc.constantFrom('## 1.2.4\n', '# T\n', '### v1.2.4\n', '```\n', '~~~\n', '[a](http://x.y/z)', '![i](u)', '@everyone', '<@1>', '<b>', '\r\n', '\n', '- ', '[', '](', ')', '…'), fc.string({ maxLength: 20 })), { maxLength: 60 })
    .map((parts) => parts.join(''));

  it('output length never exceeds maxChars and the call never throws', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 500 }), markdownish), fc.integer({ min: 0, max: 400 }), fc.boolean(), (md, maxChars, withLink) => {
        const out = extractChangelog(md, '1.2.4', { maxChars, fullUrl: withLink ? FULL_URL : null });
        if (out !== null) {
          expect(out.length).toBeLessThanOrEqual(maxChars);
          expect(() => encodeURIComponent(out)).not.toThrow();
          expect(out).not.toMatch(/@(everyone|here)/);
        }
      }),
      { numRuns: 500 },
    );
  });
});
