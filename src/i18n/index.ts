// SPDX-License-Identifier: AGPL-3.0-or-later
import { en } from './en.ts';
import type { Messages } from './messages.ts';
import { ru } from './ru.ts';

export type { Messages } from './messages.ts';

const CATALOGS = { en, ru } as const;

export type Language = keyof typeof CATALOGS;

export const LANGUAGES = Object.keys(CATALOGS) as readonly Language[];

export const DEFAULT_LANGUAGE: Language = 'en';

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.hasOwn(CATALOGS, value);
}

/** The catalog for `language`; anything unknown resolves to the default. */
export function getMessages(language: string | undefined): Messages {
  return isLanguage(language) ? CATALOGS[language] : CATALOGS[DEFAULT_LANGUAGE];
}

/**
 * Validates the `LANGUAGE` Worker setting. Empty or absent means the default; an unknown value falls back to the default
 * with one warning that names only the key.
 */
export function parseLanguage(raw: unknown, warn: (message: string) => void = console.warn): Language {
  if (raw === undefined || raw === null) return DEFAULT_LANGUAGE;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (value === '') return DEFAULT_LANGUAGE;
    if (isLanguage(value)) return value;
  }
  warn(`LANGUAGE ignored: not one of ${LANGUAGES.join(', ')}; using ${DEFAULT_LANGUAGE}`);
  return DEFAULT_LANGUAGE;
}
