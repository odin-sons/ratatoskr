// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hasDeliverableHost } from './url.ts';

const hostOf = (url: string): string => new URL(url).hostname;

describe('hasDeliverableHost', () => {
  it.each([
    'https://example.com/',
    'https://a.b.co/x',
    'https://www.thunderstore.io/c/valheim/',
    'https://hexium.gg/',
    'https://github.com/owner/mod',
    'https://xn--e1afmkfd.xn--p1ai/',
    'https://пример.рф/',
    'http://192.168.1.1/',
    'http://192.0.2.1:8080/x',
    'https://hexium.example/p',
    'https://my-site.example.org/',
    'https://1.example.com/',
  ])('accepts %s', (url) => {
    expect(hasDeliverableHost(hostOf(url))).toBe(true);
  });

  it.each([
    'https://mysite',
    'https://example',
    'https://a.b',
    'http://localhost',
    'http://localhost:8080/x',
    'http://[::1]/',
    'http://[2001:db8::1]/',
    'https://example.com./',
    'https://a..b.com/',
    'https://-a.example.com/',
    'https://a-.example.com/',
    'https://under_score.example.com/',
    'https://site.c0m/',
    'https://site.123/',
    'https://site.xn--/',
    `https://${'a'.repeat(64)}.com/`,
    `https://${'a.'.repeat(130)}com/`,
  ])('rejects %s', (url) => {
    let host: string;
    try {
      host = hostOf(url);
    } catch {
      return;
    }
    expect(hasDeliverableHost(host)).toBe(false);
  });

  it('rejects the empty string and anything that is not a hostname', () => {
    for (const bad of ['', '.', '..', ' ', 'exa mple.com', 'example.com/x', 'a@b.com', 'EXAMPLE.COM']) expect(hasDeliverableHost(bad), bad).toBe(false);
  });

  it('never throws and never accepts a host without a dot or a bracket (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (host) => {
        const ok = hasDeliverableHost(host);
        if (ok) {
          expect(host).toContain('.');
          expect(host).toMatch(/^[a-z0-9.-]+$/);
        }
      }),
      { numRuns: 500 },
    );
  });
});
