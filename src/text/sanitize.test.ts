// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { escapeMarkdown, neutralizeMentions, sanitizeUntrusted, stripHtml, stripUnsafeChars, truncate } from './sanitize.ts';

const ZWSP = String.fromCharCode(0x200b);
const ZWNJ = String.fromCharCode(0x200c);
const BIDI_OVERRIDE = String.fromCharCode(0x202e);
const FULLWIDTH_AT = String.fromCharCode(0xff20);
const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde00);

describe('neutralizeMentions', () => {
  it('breaks @everyone and @here in any case', () => {
    expect(neutralizeMentions('@everyone @here @EVERYONE @Here')).toBe(`@${ZWSP}everyone @${ZWSP}here @${ZWSP}EVERYONE @${ZWSP}Here`);
  });

  it('breaks user, nickname, role and channel mentions', () => {
    for (const mention of ['<@123>', '<@!123>', '<@&123>', '<#123>']) {
      const out = neutralizeMentions(`ping ${mention} now`);
      expect(out).not.toContain(mention);
      expect(out).toContain(ZWSP);
    }
  });

  it('breaks slash-command mentions', () => {
    expect(neutralizeMentions('</ban user:123456>')).not.toContain('</ban');
  });

  it('handles fullwidth at-signs and zero-width padding', () => {
    expect(neutralizeMentions(`${FULLWIDTH_AT}everyone`)).toBe(`@${ZWSP}everyone`);
    expect(neutralizeMentions(`@${ZWSP}${ZWNJ}here`)).toBe(`@${ZWSP}here`);
  });

  it('is idempotent', () => {
    const once = neutralizeMentions('@everyone <@1>');
    expect(neutralizeMentions(once)).toBe(once);
  });

  it('leaves ordinary text alone', () => {
    expect(neutralizeMentions('mail me@example.com, <b>bold</b>, 5 < 6')).toBe('mail me@example.com, <b>bold</b>, 5 < 6');
  });
});

describe('escapeMarkdown', () => {
  it('escapes control characters with a backslash', () => {
    expect(escapeMarkdown('*a* _b_ ~c~ |d| `e` [f](g) <h> #i')).toBe(
      '\\*a\\* \\_b\\_ \\~c\\~ \\|d\\| \\`e\\` \\[f\\]\\(g\\) \\<h\\> \\#i',
    );
  });

  it('escapes backslashes', () => {
    expect(escapeMarkdown('a\\b')).toBe('a\\\\b');
  });
});

describe('stripHtml', () => {
  it('removes tags and keeps text', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world\n');
  });

  it('maps br and li to line breaks and bullets', () => {
    expect(stripHtml('a<br>b<br/>c')).toBe('a\nb\nc');
    expect(stripHtml('<ul><li>one</li><li>two</li></ul>')).toBe('\n- one\n\n- two\n\n');
  });

  it('drops script and style blocks including their content', () => {
    expect(stripHtml('a<script>alert(1)</script>b<STYLE>p{}</STYLE>c')).toBe('abc');
  });

  it('drops an unterminated script block to the end', () => {
    expect(stripHtml('keep<script>evil')).toBe('keep');
  });

  it('drops comments', () => {
    expect(stripHtml('a<!-- hidden -->b<!-- open')).toBe('ab');
  });

  it('decodes named, decimal and hex entities in a single pass', () => {
    expect(stripHtml('Tom &amp; Jerry &lt;3 &quot;x&quot; &#39;y&#39; &#x27;z&#x27; &nbsp;!')).toBe(`Tom & Jerry <3 "x" 'y' 'z'  !`);
    expect(stripHtml('&amp;lt;')).toBe('&lt;');
  });

  it('replaces invalid code points and drops control ones', () => {
    expect(stripHtml('&#xD800;&#1114112;')).toBe(String.fromCharCode(0xfffd).repeat(2));
    expect(stripHtml('a&#0;b&#8;c')).toBe('abc');
  });

  it('leaves unknown entities and bare angle brackets', () => {
    expect(stripHtml('&bogus; a < b > c')).toBe('&bogus; a < b > c');
  });

  it('does not treat entity-encoded tags as tags', () => {
    expect(stripHtml('&lt;b&gt;x&lt;/b&gt;')).toBe('<b>x</b>');
  });

  it('is linear on pathological input', () => {
    const inputs = ['<'.repeat(200_000), '<script>'.repeat(30_000), '<!--'.repeat(50_000), '<a '.repeat(60_000)];
    for (const input of inputs) {
      const start = performance.now();
      stripHtml(input);
      expect(performance.now() - start).toBeLessThan(200);
    }
  });
});

describe('stripUnsafeChars', () => {
  it('removes control, zero-width and bidi characters', () => {
    const NUL = String.fromCharCode(0);
    const BEL = String.fromCharCode(7);
    expect(stripUnsafeChars(`a${ZWSP}b${BIDI_OVERRIDE}c${NUL}d${BEL}e`)).toBe('abcde');
  });

  it('keeps newlines, tabs and emoji joiners', () => {
    const joined = '\u{1F468}' + String.fromCharCode(0x200d) + '\u{1F469}';
    expect(stripUnsafeChars('a\n\tb')).toBe('a\n\tb');
    expect(stripUnsafeChars(joined)).toBe(joined);
  });

  it('removes lone surrogates but keeps pairs', () => {
    expect(stripUnsafeChars(`a${HIGH}b${LOW}c${HIGH}${LOW}`)).toBe(`abc${HIGH}${LOW}`);
  });
});

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('cuts to exactly max with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
  });

  it('handles tiny limits', () => {
    expect(truncate('abcdef', 1)).toBe('…');
    expect(truncate('abcdef', 0)).toBe('');
  });

  it('never leaves half of a surrogate pair', () => {
    const emoji = '\u{1F600}';
    for (let max = 0; max <= 8; max++) {
      const out = truncate(emoji.repeat(6), max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(() => encodeURIComponent(out)).not.toThrow();
    }
  });
});

describe('sanitizeUntrusted', () => {
  it('strips HTML, neutralises mentions and truncates', () => {
    const out = sanitizeUntrusted('<b>@everyone</b> &#x40;here <@42>', 100);
    expect(out).not.toContain('@everyone');
    expect(out).not.toContain('@here');
    expect(out).not.toContain('<@42>');
    expect(out).not.toContain('<b>');
  });

  it('reassembled mentions are caught after tag stripping and entity decoding', () => {
    expect(sanitizeUntrusted('@<i></i>everyone &#64;here', 100)).not.toMatch(/@(everyone|here)/);
  });

  it('returns an empty string for non-strings', () => {
    expect(sanitizeUntrusted(undefined as unknown as string, 10)).toBe('');
  });

  it('property: within max, no raw mentions, no lone surrogates, never throws', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.integer({ min: 0, max: 300 }), (text, max) => {
        const out = sanitizeUntrusted(text, max);
        expect(out.length).toBeLessThanOrEqual(max);
        expect(out).not.toMatch(/@(everyone|here)/i);
        expect(() => encodeURIComponent(out)).not.toThrow();
      }),
    );
  });
});
