// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { bestOf } from '../testing/timing.ts';
import { SOURCE_URL_MAX_CHARS } from './budget.ts';
import { websiteUrl } from './guards.ts';

describe('websiteUrl', () => {
  it.each([
    ['https://github.com/owner/mod', 'https://github.com/owner/mod'],
    ['http://example.org/', 'http://example.org/'],
    ['https://discord.gg/abc123', 'https://discord.gg/abc123'],
    ['HTTPS://Example.COM', 'https://example.com/'],
    ['  https://example.com/a b  ', 'https://example.com/a%20b'],
    ['https://example.com/?q=1#frag', 'https://example.com/?q=1#frag'],
    ['https://xn--e1afmkfd.xn--p1ai/', 'https://xn--e1afmkfd.xn--p1ai/'],
    ['https://пример.рф/', 'https://xn--e1afmkfd.xn--p1ai/'],
  ])('accepts %j as %j', (raw, expected) => {
    expect(websiteUrl(raw)).toBe(expected);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://example.com/x'],
    ['blob', 'blob:https://example.com/id'],
    ['mailto', 'mailto:a@example.com'],
    ['a scheme with mixed case', 'JaVaScRiPt:alert(1)'],
    ['protocol-relative', '//example.com/x'],
    ['relative', '/path/only'],
    ['bare host', 'example.com'],
    ['userinfo', 'https://user:pass@example.com/'],
    ['username only', 'https://user@example.com/'],
    ['empty password', 'https://:pw@example.com/'],
    ['no host', 'https://'],
    ['whitespace only', '   '],
    ['empty', ''],
    ['a control character in the host', 'https://exa\u0000mple.com/'],
    ['a space in the host', 'https://exa mple.com/'],
  ])('rejects %s', (_label, raw) => {
    expect(websiteUrl(raw)).toBeNull();
  });

  it.each([[null], [undefined], [42], [true], [{}], [['https://example.com/']], [Number.NaN]])('rejects the non-string %j', (raw) => {
    expect(websiteUrl(raw)).toBeNull();
  });

  it('accepts a URL of exactly the cap and rejects one character more', () => {
    const base = 'https://example.com/';
    const at = base + 'a'.repeat(SOURCE_URL_MAX_CHARS - base.length);
    expect(at).toHaveLength(SOURCE_URL_MAX_CHARS);
    expect(websiteUrl(at)).toBe(at);
    expect(websiteUrl(`${at}a`)).toBeNull();
  });

  it('rejects a huge input without parsing it', () => {
    expect(websiteUrl(`https://example.com/${'a'.repeat(5_000_000)}`)).toBeNull();
  });

  it('rejects a URL that only exceeds the cap after normalisation', () => {
    const base = 'https://example.com/';
    const raw = base + ' '.repeat(3) + 'a'.repeat(SOURCE_URL_MAX_CHARS - base.length - 6);
    const normalised = new URL(raw).href;
    expect(normalised.length).toBeGreaterThan(SOURCE_URL_MAX_CHARS);
    expect(raw.length).toBeLessThanOrEqual(SOURCE_URL_MAX_CHARS);
    expect(websiteUrl(raw)).toBeNull();
  });

  it.each(['https://mysite/', 'https://example/', 'https://a.b/', 'http://localhost/', 'http://localhost:8080/x', 'http://[::1]/', 'https://site.c0m/', 'https://example.com./'])(
    'rejects %s: Discord refuses a button to a host without a real top-level domain',
    (raw) => {
      expect(websiteUrl(raw)).toBeNull();
    },
  );

  it('does not restrict the host: any public http(s) site is fine', () => {
    expect(websiteUrl('https://hexium.gg.evil.example/x')).toBe('https://hexium.gg.evil.example/x');
    expect(websiteUrl('http://192.0.2.1:8080/x')).toBe('http://192.0.2.1:8080/x');
  });
});

describe('websiteUrl cost', () => {
  it('validates the largest accepted URL and a 5 MB rejected one twelve times each well inside the CPU budget', () => {
    const accepted = `https://example.com/${'a'.repeat(SOURCE_URL_MAX_CHARS - 20)}`;
    const rejected = `https://example.com/${'a'.repeat(5_000_000)}`;
    const run = (): void => {
      for (let i = 0; i < 12; i += 1) {
        websiteUrl(accepted);
        websiteUrl(rejected);
      }
    };
    expect(bestOf(5, run)).toBeLessThan(5);
  });
});
