// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHANGELOG_EXCERPT_MAX } from '../core/constants.ts';
import { bestOf } from '../testing/timing.ts';
import { extractChangelog } from './extract.ts';

const ZWSP = String.fromCharCode(0x200b);
const FULL_URL = 'https://thunderstore.io/c/valheim/p/Author/Mod/changelog/';
const FULL_LINK = `[Full changelog](${FULL_URL})`;
const TICKS = '\\`\\`\\`';

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
    expect(out).toBe(`Run:\n\n${TICKS}bash\n# install deps\n## still code\nnpm i\n${TICKS}\n\n- done`);
  });

  it('does not match a version that only appears inside a fence', () => {
    const md = '## 1.2.3\n```\n## 1.2.4\n```\n- x\n## 1.2.2\n- y';
    expect(extractChangelog(md, '1.2.4')).toBe(`${TICKS}\n## 1.2.4\n${TICKS}\n- x`);
  });

  it('honours tilde fences and longer closing fences', () => {
    const md = '## 1.0.0\n~~~\n# no\n~~~\n````\n# no\n```\n# still code\n````\n- end\n## 0.9.0\n- z';
    expect(extractChangelog(md, '1.0.0')).toContain('- end');
  });

  it('keeps the words inside fences, escaping the angle brackets instead of stripping them', () => {
    const md = '## 1.0.0\n```cs\nList<string> names = new List<string>();\n```';
    expect(extractChangelog(md, '1.0.0')).toBe(`${TICKS}cs\nList\\<string> names = new List\\<string>();\n${TICKS}`);
  });

  it('leaves an unterminated fence as escaped text', () => {
    const out = extractChangelog('## 1.0.0\n- a\n```\ncode', '1.0.0');
    expect(out).toBe(`- a\n${TICKS}\ncode`);
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

  it('cuts the lines of a fence like any other lines', () => {
    const md = `## 1.0.0\n- intro\n\`\`\`\n${'code line\n'.repeat(60)}\`\`\`\n- outro`;
    const out = extractChangelog(md, '1.0.0', { maxChars: 60 });
    expect(out).toBe(`- intro\n${TICKS}\ncode line\ncode line\ncode line\ncode line…`);
  });

  it('never leaves half of an escaped backtick at the cut', () => {
    for (let maxChars = 2; maxChars < 40; maxChars++) {
      const out = extractChangelog('## 1.0.0\n`````````` x', '1.0.0', { maxChars }) ?? '';
      expect(out.length).toBeLessThanOrEqual(maxChars);
      expect(out.replace(/\\`/g, '').replace(/…$/, '')).not.toMatch(/[\\`]/);
    }
  });

  it('puts the ellipsis right after the escaped ticks of a fence that ends the excerpt', () => {
    const md = '## 1.0.0\n```\na\n```\n' + 'x'.repeat(200);
    const out = extractChangelog(md, '1.0.0', { maxChars: 30 });
    expect(out).toBe(`${TICKS}\na\n${TICKS}…`);
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

  it('stays on its own line after an unterminated fence', () => {
    const out = extractChangelog('## 1.0.0\n```\ncode', '1.0.0', { fullUrl: FULL_URL }) ?? '';
    expect(out).toBe(`${TICKS}\ncode\n${FULL_LINK}`);
  });
});

describe('performance', () => {
  const section = (v: string): string => `## ${v}\n\n### Added\n\n- Something new in ${v}\n- Another [link](https://example.com/${v}) here\n\n### Fixed\n\n- A bug\n\n`;

  it('finds a section at the very end of a ~100 KB changelog', () => {
    let md = '# Changelog\n\n';
    let i = 0;
    while (md.length < 100_000) md += section(`2.${i++}.0`);
    md += section('1.0.0');
    expect(extractChangelog(md, '1.0.0')).toContain('Something new in 1.0.0');
    expect(bestOf(5, () => extractChangelog(md, '1.0.0'))).toBeLessThan(50);
  });

  it('falls back quickly on a ~200 KB changelog with no match', () => {
    let md = '';
    let i = 0;
    while (md.length < 200_000) md += section(`2.${i++}.0`);
    expect(extractChangelog(md, '9.9.9')).toContain('Something new in 2.0.0');
    expect(bestOf(5, () => extractChangelog(md, '9.9.9'))).toBeLessThan(50);
  });

  it('ignores a matching section beyond the input window and falls back to the first section', () => {
    let md = '';
    let i = 0;
    while (md.length < 200_000) md += section(`2.${i++}.0`);
    md += section('1.0.0');
    expect(extractChangelog(md, '1.0.0')).toContain('Something new in 2.0.0');
  });

  it('stays cheap on floods of headings and fences at the input cap', () => {
    const floods = ['# a\n'.repeat(131_072), '## 1.0\n'.repeat(70_000), '```\n'.repeat(110_000), '~~~\n# a\n'.repeat(60_000), '#\n'.repeat(260_000), '    # a\n'.repeat(80_000)];
    let total = 0;
    for (const md of floods) {
      for (const input of [md, `## 1.0.0\n${md}`]) {
        const elapsed = bestOf(3, () => extractChangelog(input, '9.9.9', { fullUrl: FULL_URL }));
        total += elapsed;
        expect(elapsed, md.slice(0, 12)).toBeLessThan(25);
      }
    }
    expect(total).toBeLessThan(120);
  });

  it('stays cheap on floods of blank and whitespace-only lines', () => {
    const inputs = [
      `## 1.0.0\n${'\n'.repeat(400_000)}- x`,
      `## 1.0.0\n${' \t\n'.repeat(200_000)}- x`,
      `## 1.0.0\n${'  \n'.repeat(200_000)}- x`,
    ];
    const elapsed = bestOf(5, () => {
      for (const input of inputs) extractChangelog(input, '1.0.0');
    });
    expect(elapsed).toBeLessThan(25);
  });

  it('handles one enormous section', () => {
    const md = `## 1.0.0\n${'- a long-ish bullet point about a change\n'.repeat(5000)}## 0.9.0\n- old`;
    expect((extractChangelog(md, '1.0.0') ?? '').length).toBeLessThanOrEqual(CHANGELOG_EXCERPT_MAX);
    expect(bestOf(5, () => extractChangelog(md, '1.0.0'))).toBeLessThan(50);
  });

  it('handles adversarial single-line inputs', () => {
    const inputs = ['<'.repeat(200_000), '![['.repeat(60_000), '['.repeat(200_000), '#'.repeat(200_000), '```'.repeat(60_000), '<script>'.repeat(20_000)];
    for (const md of inputs) {
      const elapsed = bestOf(5, () => {
        extractChangelog(md, '1.0.0');
        extractChangelog(`## 1.0.0\n${md}`, '1.0.0', { fullUrl: FULL_URL });
      });
      expect(elapsed, md.slice(0, 8)).toBeLessThan(100);
    }
  });

  it('handles many tiny headings and lines', () => {
    const md = '## x\n'.repeat(40_000);
    expect(bestOf(5, () => extractChangelog(md, '1.0.0'))).toBeLessThan(100);
  });
});

describe('angle-bracket text in changelogs', () => {
  it('keeps generics, placeholders and angle-bracketed URLs readable, escaped', () => {
    const md = ['## 1.0.0', '- Added Dictionary<string, int> support and a <player> argument', '- Docs: <https://example.com/docs>'].join('\n');
    const out = extractChangelog(md, '1.0.0') ?? '';
    expect(out).toContain('Dictionary\\<string, int>');
    expect(out).toContain('\\<player>');
    expect(out).toContain('\\<https://example.com/docs>');
  });
});

describe('link sanitising', () => {
  const run = (line: string, fullUrl: string | null = null): string => extractChangelog(`## 1.0.0\n${line}`, '1.0.0', { fullUrl }) ?? '';

  it('keeps http and https links, including uppercase schemes', () => {
    expect(run('- [docs](https://example.com/x) and [more](HTTP://EXAMPLE.COM/y)')).toBe('- [docs](https://example.com/x) and [more](HTTP://EXAMPLE.COM/y)');
  });

  it.each([
    ['javascript:alert(1)'],
    ['JavaScript:alert(1)'],
    ['data:text/html;base64,PHNjcmlwdD4='],
    ['vbscript:x'],
    ['file:///etc/passwd'],
    ['//evil.example/x'],
    ['/relative/path'],
    ['#fragment'],
    ['discord://-/channels/1/2'],
    [''],
  ])('degrades a link to %s to its plain text', (target) => {
    const out = run(`- see [the guide](${target}) now`);
    expect(out).toBe('- see the guide now');
  });

  it('strips a link title and keeps only the target', () => {
    expect(run('[t](https://a.example/p "hover text")')).toBe('[t](https://a.example/p)');
  });

  it('keeps a validated angle-bracket http target, percent-encoded, and degrades other schemes', () => {
    expect(run('[t](<https://a.example/p q> "hover")')).toBe('[t](https://a.example/p%20q)');
    expect(run('[t](<javascript:alert(1)>)')).not.toContain('javascript:alert(1)](');
  });

  it('does not link a URL-looking label to a different host', () => {
    const spoof = run('[https://thunderstore.io/c/valheim/](https://evil.example/login)');
    expect(spoof).not.toContain('evil.example');
    expect(spoof).toContain('https://thunderstore.io/c/valheim/');
    expect(run('[www.thunderstore.io](https://evil.example/x)')).not.toContain('evil.example');
  });

  it('keeps a URL-looking label that points at the same host', () => {
    expect(run('[https://example.com/a](https://example.com/b)')).toBe('[https://example.com/a](https://example.com/b)');
    expect(run('[www.example.com](https://example.com/b)')).toBe('[www.example.com](https://example.com/b)');
  });

  it('percent-encodes characters that would end the link early', () => {
    expect(run('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe('[wiki](https://en.wikipedia.org/wiki/Foo_%28bar%29)');
  });

  it('turns an empty-text link into its bare http target or nothing', () => {
    expect(run('a [](https://a.example/p) b')).toBe('a https://a.example/p b');
    expect(run('a [](javascript:x) b')).toBe('a  b');
  });

  it('degrades nested and unbalanced constructs without throwing', () => {
    for (const line of ['[a](javascript:alert(1)', '[[a](javascript:x)](https://ok.example)', '[a]b](javascript:x)', '[a](', '[a](([(', '!['.repeat(50) + '](javascript:x)']) {
      const out = run(line);
      expect(out).not.toMatch(/\]\(\s*javascript/i);
    }
  });

  it('sanitises links inside code fences and inline code as well', () => {
    expect(run('```\n[a](javascript:x)\n```')).toBe(`${TICKS}\na\n${TICKS}`);
    expect(run('use `[a](javascript:x)` literally')).toBe('use \\`a\\` literally');
  });

  it('sanitises links in headings too', () => {
    expect(run('### [Docs](javascript:x)\n- a')).toBe('**Docs**\n- a');
  });

  it('turns an image with an unsafe source into its alt text', () => {
    expect(run('![logo](javascript:alert(1)) x')).toBe('!logo x');
  });

  it('neutralises mentions inside link text and keeps the link', () => {
    const out = run('[@everyone <@123>](https://a.example/p)');
    expect(out).not.toMatch(/@everyone/);
    expect(out).not.toMatch(/<@123>/);
    expect(out).toContain('](https://a.example/p)');
  });

  it.each([
    ['https://x.io/@everyone', 'https://x.io/%40everyone'],
    ['https://x.io/a?u=@HERE&b=1', 'https://x.io/a?u=%40HERE&b=1'],
    ['https://x.io/＠everyone', 'https://x.io/%EF%BC%A0everyone'],
    ['https://x.io/@user/@here', 'https://x.io/@user/%40here'],
  ])('keeps a mention-looking link target working by percent-encoding it (%s)', (target, encoded) => {
    expect(run(`[a](${target})`)).toBe(`[a](${encoded})`);
    expect(run('- x', target)).toBe(`- x\n[Full changelog](${encoded})`);
    expect(run(`[a](${target})`)).not.toContain(ZWSP);
  });

  it('still neutralises a mention in the visible text of a link', () => {
    const out = run('[@everyone](https://x.io/@everyone) @here');
    expect(out).toBe(`[@${ZWSP}everyone](https://x.io/%40everyone) @${ZWSP}here`);
  });

  it('never lets an author-written "Full changelog" link compete with the real one', () => {
    const out = run('- fixed\n[Full changelog](https://evil.example/x)', FULL_URL);
    expect(out.match(/\[Full changelog\]\(/g)).toHaveLength(1);
    expect(out.endsWith(FULL_LINK)).toBe(true);
    expect(out).not.toContain('evil.example');
    expect(out).toContain('Full changelog');
  });

  it('stays cheap on lines full of unclosed, nested or backtick-heavy constructs', () => {
    const lines = [
      '[a]('.repeat(3000),
      '[a](' + '('.repeat(4000),
      '['.repeat(9000),
      '`'.repeat(4000) + '[a](x)',
      Array.from({ length: 60 }, (_, i) => '`'.repeat(i + 1) + 'x').join(' '),
      '[ `a](x) ` '.repeat(800),
      '``a`[a](javascript:alert(1))`'.repeat(320),
    ];
    let total = 0;
    for (const line of lines) total += bestOf(3, () => run(line, FULL_URL));
    expect(total).toBeLessThan(20);
  });

  it('produces final Markdown: lists and bold stay as written, fences turn into escaped text', () => {
    const out = run('### Added\n- **bold** item\n```\ncode\n```', FULL_URL);
    expect(out).toBe(`**Added**\n- **bold** item\n${TICKS}\ncode\n${TICKS}\n${FULL_LINK}`);
  });
});

describe('properties', () => {
  const unicode = fc
    .array(fc.oneof(fc.integer({ min: 0, max: 0xd7ff }), fc.integer({ min: 0xe000, max: 0x10ffff })), { maxLength: 500 })
    .map((codePoints) => String.fromCodePoint(...codePoints));
  const markdownish = fc
    .array(fc.oneof(fc.constantFrom('## 1.2.4\n', '# T\n', '### v1.2.4\n', '```\n', '~~~\n', '[a](http://x.y/z)', '![i](u)', '@everyone', '<@1>', '<b>', '\r\n', '\n', '- ', '[', '](', ')', '…'), fc.string({ maxLength: 20 })), { maxLength: 60 })
    .map((parts) => parts.join(''));
  const hostileSurrogates = fc
    .array(fc.constantFrom('\uD800', '\uDBFF', '\uDC00', '\uDFFF', 'a', ' ', '\n'), { maxLength: 40 })
    .map((parts) => parts.join(''));

  it('output length never exceeds maxChars and the call never throws', () => {
    fc.assert(
      fc.property(fc.oneof(unicode, markdownish, hostileSurrogates), fc.integer({ min: 0, max: 400 }), fc.boolean(), (md, maxChars, withLink) => {
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
