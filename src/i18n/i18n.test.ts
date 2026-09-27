// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { en } from './en.ts';
import { DEFAULT_LANGUAGE, getMessages, isLanguage, LANGUAGES, parseLanguage } from './index.ts';
import { englishPlural, russianPlural } from './plural.ts';
import { ru } from './ru.ts';

const SAMPLES = [0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111];

describe('plural rules', () => {
  it('english: one for exactly 1, other otherwise', () => {
    expect(SAMPLES.map(englishPlural)).toEqual(['other', 'one', 'other', 'other', 'other', 'other', 'other', 'other', 'other', 'other', 'other', 'other', 'other']);
  });

  it('russian: one/few/many by the last digits', () => {
    expect(SAMPLES.map(russianPlural)).toEqual(['many', 'one', 'few', 'few', 'many', 'many', 'many', 'many', 'one', 'few', 'many', 'one', 'many']);
  });

  it('russian: the teens are many and 100-based repeats behave like their tail', () => {
    for (const n of [11, 12, 13, 14, 111, 112, 113, 114, 211, 1011]) expect(russianPlural(n), String(n)).toBe('many');
    for (const n of [21, 31, 101, 1001, 100_001]) expect(russianPlural(n), String(n)).toBe('one');
    for (const n of [22, 23, 24, 102, 1004]) expect(russianPlural(n), String(n)).toBe('few');
    for (const n of [0, 5, 6, 9, 10, 20, 25, 30, 100, 1000]) expect(russianPlural(n), String(n)).toBe('many');
  });

  it('never throws and always yields a known category, whatever the number (property)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.double(), fc.constant(Number.NaN), fc.constant(Number.POSITIVE_INFINITY)), (n) => {
        expect(['one', 'few', 'many', 'other']).toContain(russianPlural(n));
        expect(['one', 'other']).toContain(englishPlural(n));
      }),
    );
  });
});

describe('catalogs', () => {
  it('have the same keys, with the same kinds of values', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(typeof ru[key], key).toBe(typeof en[key]);
  });

  it('lists exactly the catalogs that exist', () => {
    expect([...LANGUAGES].sort()).toEqual(['en', 'ru']);
    expect(getMessages('en')).toBe(en);
    expect(getMessages('ru')).toBe(ru);
  });

  it('every text function returns non-empty text without unresolved placeholders', () => {
    for (const messages of [en, ru]) {
      for (const [key, value] of Object.entries(messages)) {
        const text = typeof value === 'function' ? (value as (...args: unknown[]) => unknown)('Owner', '12,345', 3) : value;
        if (typeof text === 'string') {
          expect(text.length, key).toBeGreaterThan(0);
          expect(text, key).not.toMatch(/undefined|\{|\}/);
        }
      }
    }
  });

  it('english wording', () => {
    expect(en.newBy('Bob')).toBe('New by Bob');
    expect(en.updatedBy('Bob')).toBe('Updated by Bob');
    expect(en.downloaded(1, '1')).toBe('Downloaded 1 time');
    expect(en.downloaded(0, '0')).toBe('Downloaded 0 times');
    expect(en.downloaded(12_345, '12,345')).toBe('Downloaded 12,345 times');
    expect(en.likes(1, '1')).toBe('1 like');
    expect(en.likes(2, '2')).toBe('2 likes');
    expect(en.updates(1)).toBe('1 update');
    expect(en.updates(37)).toBe('37 updates');
    expect(en.page(2, 3)).toBe('(2/3)');
  });

  it('russian wording follows the plural of the number', () => {
    const downloaded = SAMPLES.map((n) => ru.downloaded(n, String(n)).replace('Скачан ', ''));
    expect(downloaded).toEqual(['0 раз', '1 раз', '2 раза', '4 раза', '5 раз', '11 раз', '12 раз', '14 раз', '21 раз', '22 раза', '25 раз', '101 раз', '111 раз']);
    const likes = SAMPLES.map((n) => ru.likes(n, String(n)));
    expect(likes).toEqual(['0 лайков', '1 лайк', '2 лайка', '4 лайка', '5 лайков', '11 лайков', '12 лайков', '14 лайков', '21 лайк', '22 лайка', '25 лайков', '101 лайк', '111 лайков']);
    const updates = SAMPLES.map((n) => ru.updates(n));
    expect(updates).toEqual(['0 обновлений', '1 обновление', '2 обновления', '4 обновления', '5 обновлений', '11 обновлений', '12 обновлений', '14 обновлений', '21 обновление', '22 обновления', '25 обновлений', '101 обновление', '111 обновлений']);
  });

  it('plural is chosen from the number, not from its formatted text', () => {
    expect(ru.downloaded(1234, '1\u00a0234')).toBe('Скачан 1\u00a0234 раза');
    expect(en.downloaded(1, '1,000')).toBe('Downloaded 1,000 time');
  });

  it('the page suffix fits the reserve the packer sets aside', () => {
    for (const messages of [en, ru]) expect(messages.page(9999, 9999).length).toBeLessThanOrEqual(24);
  });
});

describe('language selection', () => {
  it('falls back to the default for unknown or missing values', () => {
    expect(DEFAULT_LANGUAGE).toBe('en');
    expect(getMessages(undefined)).toBe(en);
    expect(getMessages('xx')).toBe(en);
    expect(getMessages('')).toBe(en);
    expect(getMessages('__proto__')).toBe(en);
    expect(getMessages('constructor')).toBe(en);
  });

  it('isLanguage only accepts exact catalog names', () => {
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('ru')).toBe(true);
    for (const bad of ['EN', 'ru-RU', ' ru', 'toString', '__proto__', '', 5, null, undefined]) expect(isLanguage(bad), String(bad)).toBe(false);
  });

  it('parseLanguage accepts known values quietly, trimming and lower-casing them', () => {
    const warn = vi.fn();
    expect(parseLanguage('ru', warn)).toBe('ru');
    expect(parseLanguage(' RU ', warn)).toBe('ru');
    expect(parseLanguage(undefined, warn)).toBe('en');
    expect(parseLanguage('', warn)).toBe('en');
    expect(warn).not.toHaveBeenCalled();
  });

  it('parseLanguage falls back to en with one warning that names only the key', () => {
    for (const bad of ['klingon', 'https://evil.example/x?token=abc', 42, {}]) {
      const warn = vi.fn();
      expect(parseLanguage(bad, warn)).toBe('en');
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain('LANGUAGE');
      expect(message).not.toContain('klingon');
      expect(message).not.toContain('evil');
      expect(message).not.toContain('token');
    }
  });
});
