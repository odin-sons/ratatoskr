// SPDX-License-Identifier: AGPL-3.0-or-later
import { neutralizeMentions, stripUnsafeChars } from '../text/sanitize.ts';
import { CAPS } from './layout.ts';

const SPECIAL = /[\\*_~|`[\]()<>]/g;
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
export function escapeTruncate(text: string, max: number): string {
  if (max < 1) return '';
  const escaped = text.replace(SPECIAL, '\\$&').replace(LINE_START, (_match, before: string, mark?: string, digits?: string) =>
    mark !== undefined ? `${before}\\${mark}` : `${before}${digits}\\.`,
  );
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

/** Untrusted single-line text, safe to embed anywhere in Markdown, at most `max` characters. */
export function inline(raw: string, max: number): string {
  return escapeTruncate(cleanInline(raw, max), max);
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

/** Whole count with comma thousands separators; null unless the value is a non-negative safe number. */
export function formatCount(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const whole = Math.floor(value);
  if (!Number.isSafeInteger(whole)) return null;
  const digits = String(whole);
  let out = '';
  for (let end = digits.length; end > 0; end -= 3) {
    const group = digits.slice(Math.max(0, end - 3), end);
    out = out === '' ? group : `${group},${out}`;
  }
  return out;
}

export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (unit < units.length - 1 && (unit === 0 ? value >= 1024 : Math.round(value * 10) / 10 >= 1024)) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}
