// SPDX-License-Identifier: AGPL-3.0-or-later
import { neutralizeMentions, stripUnsafeChars } from '../text/sanitize.ts';
import { CAPS } from './layout.ts';

const SPECIAL = /[\\*~|`[\]<>]|(?<=\])\(/g;
/** An underscore that is not flanked by a word character on both sides: Discord never reads an intraword `_` as emphasis. */
const UNDERSCORE = /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;
const LINE_START = /(^|\n)(?:([-#])|(\d+)\.(?![^ \n]))/g;
const BIDI = /\p{Bidi_Control}/gu;
const HOST = /^https?:\/\/[^\s/?#]+/i;
const URL_UNSAFE = /[\p{Cc}\s()<>\\|[\]"`]/gu;

/** First `limit` characters of `raw`, never ending in half a surrogate pair. */
export function head(raw: string, limit: number): string {
  if (raw.length <= limit) return raw;
  const last = raw.charCodeAt(limit - 1);
  return raw.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

function cleanInline(raw: string, max: number): string {
  return neutralizeMentions(stripUnsafeChars(head(raw, max * CAPS.rawFactor).replace(BIDI, '').replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ')).trim());
}

/** Escapes Markdown control characters and line-start list markers; never splits an escape pair; appends `…` when cut. */
export function escapeTruncate(text: string, max: number, loneUnderscoreRunStaysRaw = false): string {
  if (max < 1) return '';
  const special = text.replace(SPECIAL, '\\$&');
  const lone = loneUnderscoreRunStaysRaw ? loneUnderscoreRun(special) : null;
  const escaped = special
    .replace(UNDERSCORE, (match, offset: number) => (lone !== null && offset >= lone.start && offset < lone.end ? match : '\\_'))
    .replace(LINE_START, (_match, before: string, mark?: string, digits?: string) => (mark !== undefined ? `${before}\\${mark}` : `${before}${digits}\\.`));
  if (escaped.length <= max) return escaped;
  let end = max - 1;
  let slashes = 0;
  while (end - 1 - slashes >= 0 && escaped.charCodeAt(end - 1 - slashes) === 92) slashes += 1;
  if (slashes % 2 === 1) end -= 1;
  const last = escaped.charCodeAt(end - 1);
  const after = escaped.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end -= 1;
  return `${escaped.slice(0, end)}…`;
}

/** The only run of two or more underscores in `text`, or null: a single run has no second run to close an underline. */
function loneUnderscoreRun(text: string): { start: number; end: number } | null {
  const runs = [...text.matchAll(/_{2,}/g)];
  const only = runs.length === 1 ? runs[0] : undefined;
  return only?.index === undefined ? null : { start: only.index, end: only.index + only[0].length };
}

/** Untrusted single-line text, safe to embed anywhere in Markdown, at most `max` characters. */
export function inline(raw: string, max: number): string {
  return escapeTruncate(cleanInline(raw, max), max);
}

/** Like `inline`, for a title alone on its line: one run of underscores stays raw (Discord shows an escape there as a backslash). */
export function inlineTitle(raw: string, max: number): string {
  return escapeTruncate(cleanInline(raw, max), max, true);
}

/** Returns a Markdown-destination-safe http(s) URL, or null when unusable or longer than the cap. */
export function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length > CAPS.url || !HOST.test(trimmed)) return null;
  const encoded = trimmed.replace(URL_UNSAFE, (ch) => (ch === '(' ? '%28' : ch === ')' ? '%29' : encodeURIComponent(ch)));
  return encoded.length > CAPS.url ? null : encoded;
}

export function mdLink(text: string, url: string): string {
  return `[${text}](${url})`;
}

/** The whole part of a count, or null unless the value is a non-negative safe number. */
export function wholeCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const whole = Math.floor(value);
  return Number.isSafeInteger(whole) ? whole : null;
}

/** Whole count with a separator between digit groups of three; null unless the value is a non-negative safe number. */
export function formatCount(value: number | null | undefined, separator = ','): string | null {
  const whole = wholeCount(value);
  if (whole === null) return null;
  const digits = String(whole);
  let out = '';
  for (let end = digits.length; end > 0; end -= 3) {
    const group = digits.slice(Math.max(0, end - 3), end);
    out = out === '' ? group : `${group}${separator}${out}`;
  }
  return out;
}

const ENGLISH_UNITS: readonly string[] = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number | null | undefined, units: readonly string[] = ENGLISH_UNITS, decimalSeparator = '.'): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  let value = bytes;
  let unit = 0;
  while (unit < units.length - 1 && (unit === 0 ? value >= 1024 : Math.round(value * 10) / 10 >= 1024)) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} ${units[0]}`;
  const fixed = value.toFixed(1);
  return `${decimalSeparator === '.' ? fixed : fixed.replace('.', decimalSeparator)} ${units[unit]}`;
}
