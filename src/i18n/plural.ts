// SPDX-License-Identifier: AGPL-3.0-or-later

export type PluralCategory = 'one' | 'few' | 'many' | 'other';

export type PluralForms = Partial<Record<PluralCategory, string>> & { other: string };

/** CLDR `en`: `one` for exactly 1. */
export function englishPlural(n: number): PluralCategory {
  return n === 1 ? 'one' : 'other';
}

/** CLDR `ru` for whole numbers: one (1, 21, 101, not 11), few (2-4, not 12-14), many (the rest); fractions are `other`. */
export function russianPlural(n: number): PluralCategory {
  if (!Number.isInteger(n)) return 'other';
  const tail = Math.abs(n) % 100;
  const last = tail % 10;
  if (last === 1 && tail !== 11) return 'one';
  if (last >= 2 && last <= 4 && (tail < 12 || tail > 14)) return 'few';
  return 'many';
}

export function pick(category: PluralCategory, forms: PluralForms): string {
  return forms[category] ?? forms.other;
}
