// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DISCORD } from '../core/constants.ts';
import { buildComponents, linkButtonUrl } from './components.ts';

const PAGE = 'https://thunderstore.io/c/valheim/p/Owner/Mod/';
const DL = 'https://thunderstore.io/package/download/Owner/Mod/1.2.3/';

describe('buildComponents', () => {
  it('builds one action row with a page button and a download button', () => {
    expect(buildComponents(PAGE, DL)).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: 'Mod page', url: PAGE },
          { type: 2, style: 5, label: 'Download', url: DL },
        ],
      },
    ]);
  });

  it('omits the download button when there is no download url', () => {
    const rows = buildComponents(PAGE, null);
    expect(rows![0]!.components.map((b) => b.label)).toEqual(['Mod page']);
    expect(buildComponents(PAGE, undefined)![0]!.components).toHaveLength(1);
  });

  it('drops an invalid button and keeps the valid one', () => {
    expect(buildComponents('javascript:alert(1)', DL)![0]!.components.map((b) => b.label)).toEqual(['Download']);
    expect(buildComponents(PAGE, 'ftp://x.io/a')![0]!.components.map((b) => b.label)).toEqual(['Mod page']);
  });

  it('returns nothing when no button is valid', () => {
    expect(buildComponents('nope', null)).toBeUndefined();
    expect(buildComponents('', '')).toBeUndefined();
    expect(buildComponents(null, undefined)).toBeUndefined();
  });

  it('never exceeds the Discord button limits (property)', () => {
    const url = fc.oneof(
      fc.string({ maxLength: 700 }).map((s) => `https://a.io/${s}`),
      fc.string({ maxLength: 40 }),
      fc.constantFrom('http://a.io/x', 'https://user:pw@a.io/x', 'https://', 'HTTPS://A.IO/X', 'data:text/html,x', 'https://a.io/x y', ''),
      fc.constant(null),
    );
    fc.assert(
      fc.property(url, url, (page, download) => {
        const rows = buildComponents(page, download);
        if (rows === undefined) return;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.type).toBe(1);
        expect(rows[0]!.components.length).toBeGreaterThan(0);
        expect(rows[0]!.components.length).toBeLessThanOrEqual(DISCORD.buttonsPerRow);
        for (const b of rows[0]!.components) {
          expect(b.type).toBe(2);
          expect(b.style).toBe(5);
          expect(b.label.length).toBeGreaterThan(0);
          expect(b.label.length).toBeLessThanOrEqual(DISCORD.buttonLabelMax);
          expect(b.url.length).toBeLessThanOrEqual(DISCORD.buttonUrlMax);
          expect(b.url).toMatch(/^https?:\/\//);
          expect(() => new URL(b.url)).not.toThrow();
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('linkButtonUrl', () => {
  it('accepts http and https and normalises', () => {
    expect(linkButtonUrl('https://a.io/x')).toBe('https://a.io/x');
    expect(linkButtonUrl('http://a.io/x')).toBe('http://a.io/x');
    expect(linkButtonUrl('  https://a.io/x y ')).toBe('https://a.io/x%20y');
  });

  it('rejects other schemes, credentials, hostless and oversized urls', () => {
    const bad = ['javascript:alert(1)', 'data:text/html,x', 'ftp://a.io/x', 'https://user:pw@a.io/x', 'https://user@a.io/x', 'https://', '//a.io/x', 'a.io/x', '', `https://a.io/${'a'.repeat(600)}`];
    for (const url of bad) expect(linkButtonUrl(url), url).toBeNull();
    expect(linkButtonUrl(null)).toBeNull();
    expect(linkButtonUrl(undefined)).toBeNull();
  });
});
