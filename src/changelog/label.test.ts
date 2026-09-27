// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { finalizeExcerpt } from './excerpt.ts';
import { sanitizeLinks } from './links.ts';

const LABEL = 'Полный список изменений';

describe('a localised full-changelog label', () => {
  it('finalizeExcerpt uses the given label for the trailing link', () => {
    expect(finalizeExcerpt('- fixed', { maxChars: 500, fullUrl: 'https://x.io/c', label: LABEL })).toBe(`- fixed\n[${LABEL}](https://x.io/c)`);
  });

  it('defaults to the english label', () => {
    expect(finalizeExcerpt('- fixed', { maxChars: 500, fullUrl: 'https://x.io/c' })).toBe('- fixed\n[Full changelog](https://x.io/c)');
  });

  it('keeps the link inside the budget when the body is cut', () => {
    const out = finalizeExcerpt('word '.repeat(400), { maxChars: 500, fullUrl: 'https://x.io/c', label: LABEL, cut: true })!;
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith(`\n[${LABEL}](https://x.io/c)`)).toBe(true);
  });

  it('sanitizeLinks degrades a link that impersonates the reserved label, in any case', () => {
    expect(sanitizeLinks(`see [${LABEL}](https://evil.example/x) now`, LABEL)).toBe(`see ${LABEL} now`);
    expect(sanitizeLinks(`see [${LABEL.toUpperCase()}](https://evil.example/x)`, LABEL)).toBe(`see ${LABEL.toUpperCase()}`);
    expect(sanitizeLinks('see [Full changelog](https://evil.example/x)', LABEL)).toBe('see Full changelog');
  });

  it('sanitizeLinks keeps ordinary links whatever the reserved label', () => {
    expect(sanitizeLinks('[docs](https://x.io/d)', LABEL)).toBe('[docs](https://x.io/d)');
    expect(sanitizeLinks(`[${LABEL}](https://x.io/d)`)).toBe(`[${LABEL}](https://x.io/d)`);
  });
});

describe('word-boundary cut', () => {
  it('hard-cuts mid-word by default and at a word boundary when asked', () => {
    const text = 'abcdefgh '.repeat(100);
    const plain = finalizeExcerpt(text, { maxChars: 96 })!;
    const words = finalizeExcerpt(text, { maxChars: 96, wordBoundary: true })!;
    expect(plain).toMatch(/abcde…$/);
    expect(words.length).toBeLessThanOrEqual(96);
    expect(words).toMatch(/abcdefgh…$/);
    expect(plain.endsWith('…')).toBe(true);
  });

  it('keeps a hard cut for one long word', () => {
    const out = finalizeExcerpt('x'.repeat(1000), { maxChars: 100, wordBoundary: true })!;
    expect(out).toBe(`${'x'.repeat(99)}…`);
  });

  it('does not back off when the cut already falls between words', () => {
    const out = finalizeExcerpt('aaaa bbbb cccc dddd', { maxChars: 10, wordBoundary: true })!;
    expect(out).toBe('aaaa bbbb…');
  });

  it('still drops a half link at the cut', () => {
    const out = finalizeExcerpt(`${'word '.repeat(18)}[some link text](https://example.com/path)`, { maxChars: 100, wordBoundary: true })!;
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).not.toMatch(/\[[^\]]*$/);
    expect(out).not.toMatch(/\]\([^)]*$/);
  });
});
