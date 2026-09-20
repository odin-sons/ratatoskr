// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { eventId } from '../core/ids.ts';
import type { ModEvent } from '../core/types.ts';
import { buildDetailed } from '../render/detailed.ts';
import { nestedLinkDocument, nestedLinkText, unsafeLinkTargets } from './__fixtures__/link-oracle.ts';
import { hasInvisible, INVISIBLE_CODE_POINTS } from '../text/__fixtures__/invisible.ts';
import { extractChangelog } from './extract.ts';
import { extractNexusChangelog } from './nexus.ts';

const FULL_URL = 'https://thunderstore.io/c/valheim/p/Author/Mod/changelog/';
const NOW = new Date('2026-09-19T12:00:00Z');


function eventWith(changelog: string | null, changelogUrl: string | null = FULL_URL): ModEvent {
  return {
    id: eventId('thunderstore:valheim', 'Author-Mod', '1.0.0'),
    kind: 'update',
    versionFrom: '0.9.0',
    versionTo: '1.0.0',
    changelog,
    changelogUrl,
    createdAt: '2026-09-19T11:30:00Z',
    alsoOn: [],
    pkg: {
      source: 'thunderstore:valheim',
      store: 'thunderstore',
      packageId: 'Author-Mod',
      owner: 'Author',
      name: 'Mod',
      version: '1.0.0',
      url: 'https://thunderstore.io/c/valheim/p/Author/Mod/',
      iconUrl: null,
      description: null,
      categories: [],
      isNsfw: false,
      isDeprecated: false,
      updatedAt: '2026-09-19T11:30:00Z',
      sizeBytes: null,
    },
  };
}

const viaThunderstore = (md: string): string => extractChangelog(`## 1.0.0\n${md}`, '1.0.0', { fullUrl: FULL_URL }) ?? '';
const viaNexus = (md: string): string => extractNexusChangelog({ '1.0.0': md.split('\n') }, '1.0.0', { fullUrl: FULL_URL }) ?? '';
const viaRenderer = (md: string): string => buildDetailed(eventWith(extractChangelog(`## 1.0.0\n${md}`, '1.0.0', { fullUrl: FULL_URL })), NOW).fields?.[0]?.value ?? '';

const ROUTES: Array<[string, (md: string) => string]> = [
  ['extractChangelog', viaThunderstore],
  ['extractNexusChangelog', viaNexus],
  ['the renderer field', viaRenderer],
];

describe('nested links never smuggle a non-http(s) target', () => {
  const CASES = [
    '[[b](x)](javascript:alert(1))',
    '[[b](https://ok.example)](javascript:alert(1))',
    '[[[c](x)](y)](javascript:alert(1))',
    '![[b](x)](javascript:alert(1))',
    '![a](x)](javascript:alert(1))',
    '[a\\](javascript:alert(1))',
    '\\[a](javascript:alert(1))',
    'x](javascript:alert(1))',
    '[a]](javascript:alert(1))',
    '[a](x)](javascript:alert(1))',
    '&#91;a&#93;&#40;javascript:alert(1)&#41;',
    '[a `b](javascript:alert(1))` c',
    '`x` ](javascript:alert(1))',
    '[[a](b)](c)](javascript:alert(1))',
    'a `x\n`[a](javascript:alert(1))`',
    '- a `x\n- `[click](steam://run/1)`',
    '~~~\n[a](javascript:alert(1))\n~~~',
    '```\nfoo ``` [a](javascript:alert(1))\n```',
    '````````\n[a](javascript:alert(1))',
    '`````````[a](javascript:x)`````````',
    '&#96;x\n&#96;[a](javascript:x)&#96;',
    '```\n[a](javascript:x)\n```\n[b](javascript:y)',
    '[a](<javascript:x>)',
    '&lt;steam://run/1&gt; &lt;javascript:x&gt;',
    '[ref][ref]\n\n[ref]: javascript:x',
    '[ref]\n[ref]: <javascript:x>',
  ];

  it.each(ROUTES)('%s: reproduces from the review and other nestings', (_name, route) => {
    for (const md of CASES) {
      const out = route(md);
      expect(unsafeLinkTargets(out), `${md} -> ${out}`).toEqual([]);
    }
  });

  it('keeps the plain text of the degraded outer link', () => {
    expect(viaThunderstore('[[b](x)](javascript:alert(1))')).not.toMatch(/\]\(javascript/);
    expect(viaThunderstore('[[b](x)](javascript:alert(1))')).toContain('b');
  });

  it('keeps a valid link next to a nested one', () => {
    expect(viaThunderstore('[ok](https://ok.example/a) and [[b](x)](javascript:y)')).toContain('[ok](https://ok.example/a)');
  });

  it.each(['<b>```\n```\n[a](javascript:x)\n```', '&#96;&#96;&#96;\n&#96;&#96;&#96;\n[a](javascript:x)\n```', '# ``` x**\n```\n[a](javascript:x)'])(
    'markup that turns into a code fence cannot hide a link line (%#)',
    (md) => {
      for (const [name, route] of ROUTES) expect(unsafeLinkTargets(route(md)), name).toEqual([]);
    },
  );

  it('treats an inline code span like any other text', () => {
    expect(viaThunderstore('use `[a](javascript:x)` literally')).toBe(`use \\\`a\\\` literally\n[Full changelog](${FULL_URL})`);
  });

  it('keeps a valid link inside what used to be a code span', () => {
    expect(viaThunderstore('use `[a](https://ok.example/x)`')).toBe(`use \\\`[a](https://ok.example/x)\\\`\n[Full changelog](${FULL_URL})`);
  });

  describe.each(ROUTES)('property via %s', (_name, route) => {
    it('no output holds a link target that is not http(s), over arbitrary text', () => {
      fc.assert(
        fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 200 }), fc.string({ unit: 'grapheme', maxLength: 100 })), (md) => {
          expect(unsafeLinkTargets(route(md))).toEqual([]);
        }),
        { numRuns: 400 },
      );
    });

    it('no output holds a link target that is not http(s), over adversarial nesting', () => {
      fc.assert(
        fc.property(nestedLinkText, (md) => {
          expect(unsafeLinkTargets(route(md)), md).toEqual([]);
        }),
        { numRuns: 1500 },
      );
    });

    it('no output holds a link target that is not http(s), over nested multi-line documents', () => {
      fc.assert(
        fc.property(nestedLinkDocument, (md) => {
          expect(unsafeLinkTargets(route(md)), md).toEqual([]);
        }),
        { numRuns: 800 },
      );
    });
  });
});

function unescapedBackticks(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '`') count++;
  }
  return count;
}

describe('no code span or fence can exist for Discord', () => {
  const CASES = [
    '`code`',
    '```\nblock\n```',
    '````lang\nx\n````',
    '~~~\nx\n~~~',
    '&#96;x&#96;',
    '&#x60;&#x60;&#x60;\nx',
    '\\`x',
    '\\\\`x',
    '\\\\\\`x',
    'a \\` b ` c',
    '[a`b](https://ok.example/x)`',
    '### `title`',
    '- `item` and ``double`` and ```triple```',
    '<code>x</code> `y`',
  ];

  it.each(ROUTES)('%s: every backtick is escaped', (_name, route) => {
    for (const md of CASES) {
      const out = route(md);
      expect(unescapedBackticks(out), `${md} -> ${out}`).toBe(0);
    }
  });

  it('escapes a backtick once, and leaves an already escaped one alone', () => {
    expect(viaThunderstore('a `b` \\`c\\`')).toBe(`a \\\`b\\\` \\\`c\\\`\n[Full changelog](${FULL_URL})`);
  });

  it('escapes the backtick after an escaped backslash', () => {
    expect(viaThunderstore('a \\\\`b')).toBe(`a \\\\\\\`b\n[Full changelog](${FULL_URL})`);
  });

  it('escapes the backtick that an entity decodes to', () => {
    expect(viaThunderstore('a &#96;b&#x60;')).toBe(`a \\\`b\\\`\n[Full changelog](${FULL_URL})`);
  });

  it('escapes the backticks of a fence written in the changelog and keeps its lines', () => {
    expect(viaThunderstore('```bash\nnpm i\n```')).toBe(`\\\`\\\`\\\`bash\nnpm i\n\\\`\\\`\\\`\n[Full changelog](${FULL_URL})`);
  });

  it('escapes a backtick a removed link leaves next to a backslash', () => {
    for (const md of ['[a\\](x)`b', '[a\\\\](x)`b`', '[\\](x)`[a](javascript:x)`']) {
      expect(unescapedBackticks(viaThunderstore(md)), md).toBe(0);
    }
  });

  it('a cut never leaves a backtick unescaped or splits an escape', () => {
    const md = Array.from({ length: 40 }, (_, i) => `- item ${i} \`code ${i}\` and [a](javascript:x) \\\`tail\\\``).join('\n');
    for (let maxChars = 30; maxChars < 400; maxChars += 7) {
      const out = extractChangelog(`## 1.0.0\n${md}`, '1.0.0', { maxChars }) ?? '';
      expect(out.length).toBeLessThanOrEqual(maxChars);
      expect(unescapedBackticks(out), `${maxChars}: ${out}`).toBe(0);
      expect(unsafeLinkTargets(out)).toEqual([]);
    }
  });

  it('property: no unescaped backtick in any output, over arbitrary backtick-heavy text', () => {
    const piece = fc.constantFrom('`', '``', '```', '\\', '\\\\', '&#96;', '&#x60;', '&#92;', 'a', ' ', '\n', '[', ']', '(', ')', '~~~', '<b>', '](', '- ', '### ');
    const doc = fc.array(piece, { maxLength: 40 }).map((parts) => parts.join(''));
    fc.assert(
      fc.property(doc, (md) => {
        for (const [name, route] of ROUTES) expect(unescapedBackticks(route(md)), `${name}: ${JSON.stringify(md)}`).toBe(0);
      }),
      { numRuns: 800 },
    );
  });
});

describe('invisible and bidi characters written as numeric entities', () => {
  const CLASSES: Array<[string, string]> = [
    ...INVISIBLE_CODE_POINTS.map(([label, code]): [string, string] => [label, `&#x${code.toString(16).toUpperCase()};`]),
    ...INVISIBLE_CODE_POINTS.map(([label, code]): [string, string] => [`${label} (decimal)`, `&#${code};`]),
    ['DEL', '&#127;'],
  ];

  it.each(CLASSES)('%s is dropped from a paragraph by every route', (_label, entity) => {
    for (const [name, route] of ROUTES) {
      const out = route(`fix${entity}ed${entity}!`);
      expect(hasInvisible(out), name).toBe(false);
      expect(out, name).toContain('fixed!');
    }
  });

  it.each(CLASSES)('%s is dropped from link text, link target and heading', (_label, entity) => {
    const out = viaThunderstore(`[a${entity}b](https://x.example/p${entity}q)\n### Head${entity}ing\n- item`);
    expect(hasInvisible(out)).toBe(false);
    expect(out).toContain('[ab](https://x.example/pq)');
    expect(out).toContain('**Heading**');
  });

  it.each(INVISIBLE_CODE_POINTS)('%s written raw is dropped by every route', (_label, code) => {
    const raw = String.fromCodePoint(code);
    for (const [name, route] of ROUTES) {
      const out = route(`fix${raw}ed${raw}!\n- it${raw}em`);
      expect(hasInvisible(out), name).toBe(false);
      expect(out, name).toContain('fixed!');
    }
  });

  it('drops the raw characters too, also through the renderer', () => {
    const raw = `a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x2066)}c${String.fromCharCode(0x200b)}d`;
    expect(hasInvisible(viaThunderstore(raw))).toBe(false);
    expect(buildDetailed(eventWith(raw, null), NOW).fields?.[0]?.value).toBe('abcd');
  });

  it('keeps entities inside code fences literal', () => {
    expect(viaThunderstore('```\n&#x202E;\n```')).toContain('&#x202E;');
  });

  it('property: no entity of an unsafe code point survives, in any position', () => {
    const unsafe = fc.constantFrom(0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200e, 0x200f, 0x2060, 0x2064, 0xfeff, 0xad, 0x61c, 0x180e, 0x7, 0x1b, 0x7f, 0x85, 0x9f);
    const entity = fc.tuple(unsafe, fc.boolean()).map(([code, hex]) => (hex ? `&#x${code.toString(16)};` : `&#${code};`));
    const piece = fc.oneof(entity, fc.constantFrom('a', ' ', '[', ']', '(', ')', '](', 'https://x.example/', '- ', '### ', '<b>', '`'));
    const doc = fc.array(piece, { maxLength: 40 }).map((parts) => parts.join(''));
    fc.assert(
      fc.property(doc, (md) => {
        for (const [name, route] of ROUTES) expect(hasInvisible(route(md)), `${name}: ${md}`).toBe(false);
      }),
      { numRuns: 800 },
    );
  });
});
