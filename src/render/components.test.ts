// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DISCORD } from '../core/constants.ts';
import { getMessages } from '../i18n/index.ts';
import { makeEvent } from './__fixtures__/events.ts';
import { buildActionRow, linkButtonUrl } from './components.ts';
import { makeCtx } from './context.ts';

const PAGE = 'https://thunderstore.io/c/valheim/p/Owner/Mod/';
const DL = 'https://thunderstore.io/package/download/Owner/Mod/1.2.3/';
const WEB = 'https://example.com/mod';
const ctx = makeCtx({});
const row = (over: Parameters<typeof makeEvent>[0], c = ctx) => buildActionRow(makeEvent(over), c);
const labels = (over: Parameters<typeof makeEvent>[0], c = ctx) => row(over, c)?.components.map((b) => b.label) ?? [];

describe('buildActionRow', () => {
  it('builds one row with page, download and website buttons in order; the source link is not one of them', () => {
    expect(labels({ url: PAGE, downloadUrl: DL, websiteUrl: WEB })).toEqual(['Mod page', 'Download', 'Website']);
    expect(row({ url: PAGE, downloadUrl: DL, websiteUrl: WEB })!.type).toBe(1);
  });

  it('omits the download and website buttons without a url', () => {
    expect(labels({ url: PAGE, downloadUrl: null, websiteUrl: null })).toEqual(['Mod page']);
    expect(labels({ url: PAGE, downloadUrl: DL, websiteUrl: null })).toEqual(['Mod page', 'Download']);
    expect(labels({ url: PAGE, downloadUrl: null, websiteUrl: WEB })).toEqual(['Mod page', 'Website']);
  });

  it('places the website button right after the download button', () => {
    expect(labels({ url: PAGE, downloadUrl: DL, websiteUrl: WEB }).indexOf('Website')).toBe(labels({ url: PAGE, downloadUrl: DL, websiteUrl: WEB }).indexOf('Download') + 1);
  });

  it('drops an invalid button and keeps the valid ones', () => {
    expect(labels({ url: 'javascript:alert(1)', downloadUrl: DL })).toEqual(['Download']);
    expect(labels({ url: PAGE, downloadUrl: 'ftp://x.io/a' })).toEqual(['Mod page']);
  });

  it('returns null when nothing is valid: an empty action row is not a valid component', () => {
    expect(row({ url: 'nope', downloadUrl: '', websiteUrl: '' })).toBeNull();
  });

  it('offers only the mod page button without optional buttons, and null when even that is invalid', () => {
    const core = makeCtx({ optionalButtons: false });
    expect(labels({ url: PAGE, downloadUrl: DL, websiteUrl: WEB }, core)).toEqual(['Mod page']);
    expect(row({ url: 'nope', downloadUrl: DL, websiteUrl: WEB }, core)).toBeNull();
    expect(labels({ url: PAGE, downloadUrl: DL, websiteUrl: WEB }, makeCtx({ optionalButtons: true }))).toHaveLength(3);
  });

  it('takes labels from the catalog', () => {
    expect(labels({ url: PAGE, downloadUrl: DL, websiteUrl: WEB }, makeCtx({ locale: 'ru' }))).toEqual(['Страница мода', 'Скачать', 'Сайт']);
  });

  it('uses real Unicode emoji for every store fallback, since Discord rejects other symbols on buttons', () => {
    for (const store of ['thunderstore', 'hexium', 'nexus'] as const) {
      const emoji = row({ url: PAGE, store })!.components[0]!.emoji as { name: string };
      expect(emoji.name).toMatch(/^\p{Extended_Pictographic}/u);
    }
  });

  it('gives the mod page button the configured store emoji, else the store fallback', () => {
    const custom = '<:thunderstore:123456789012345678>';
    expect(row({ url: PAGE }, makeCtx({ storeEmojis: { thunderstore: custom } }))!.components[0]!.emoji).toEqual({ id: '123456789012345678', name: 'thunderstore', animated: false });
    expect(row({ url: PAGE })!.components[0]!.emoji).toEqual({ name: '⚡' });
    expect(row({ url: PAGE, store: 'hexium' })!.components[0]!.emoji).toEqual({ name: '🟣' });
    expect(row({ url: PAGE, store: 'nexus' })!.components[0]!.emoji).toEqual({ name: '🌀' });
  });

  it('never exceeds the Discord button limits, and is null rather than empty when nothing is valid (property)', () => {
    const url = fc.oneof(
      fc.string({ maxLength: 700 }).map((s) => `https://a.io/${s}`),
      fc.string({ maxLength: 40 }),
      fc.constantFrom('http://a.io/x', 'https://user:pw@a.io/x', 'https://', 'HTTPS://A.IO/X', 'data:text/html,x', 'https://a.io/x y', ''),
      fc.constant(null),
    );
    const languages = fc.constantFrom('en' as const, 'ru' as const);
    fc.assert(
      fc.property(url, url, url, languages, (page, download, website, locale) => {
        const built = row({ url: page ?? '', downloadUrl: download, websiteUrl: website }, makeCtx({ locale }));
        if (built === null) return;
        expect(built.type).toBe(1);
        expect(built.components.length).toBeGreaterThan(0);
        expect(built.components.length).toBeLessThanOrEqual(DISCORD.buttonsPerRow);
        for (const b of built.components) {
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

  it('keeps every catalog label within the button label limit', () => {
    for (const language of ['en', 'ru']) {
      const m = getMessages(language);
      for (const label of [m.modPage, m.download, m.website]) {
        expect(label.length).toBeGreaterThan(0);
        expect(label.length).toBeLessThanOrEqual(DISCORD.buttonLabelMax);
      }
    }
  });
});

describe('hosts Discord rejects', () => {
  const BAD = ['https://mysite/x', 'https://example/', 'https://a.b/', 'http://localhost/', 'http://localhost:8080/x', 'http://[::1]/', 'https://site.c0m/'];

  it('drops the button of a page, download or website URL with such a host, keeping the others', () => {
    for (const bad of BAD) {
      expect(labels({ url: PAGE, downloadUrl: bad, websiteUrl: bad }), bad).toEqual(['Mod page']);
      expect(labels({ url: bad, downloadUrl: DL, websiteUrl: WEB }), bad).toEqual(['Download', 'Website']);
    }
  });

  it('keeps IPv4 literals, dotted names and punycode hosts', () => {
    for (const ok of ['http://192.168.1.1/x', 'https://example.co/', 'https://xn--e1afmkfd.xn--p1ai/']) {
      expect(labels({ url: PAGE, websiteUrl: ok }), ok).toEqual(['Mod page', 'Website']);
    }
  });

  it('linkButtonUrl refuses them too, so a thumbnail never carries one', () => {
    for (const bad of BAD) expect(linkButtonUrl(bad), bad).toBeNull();
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
