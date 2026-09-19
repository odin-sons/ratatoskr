// SPDX-License-Identifier: AGPL-3.0-or-later
import { neutralizeMentions } from '../text/sanitize.ts';
import { CAPS } from './layout.ts';

const SPECIAL = new Set(['\\', '*', '_', '~', '|', '`', '[', ']', '(', ')', '<', '>']);
const BIDI = /\p{Bidi_Control}/gu;
const HOST = /^https?:\/\/[^\s/?#]+/i;
const URL_UNSAFE = /[\p{Cc}\s()<>\\|[\]"`]/gu;

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function scan(raw: string): string {
  return (raw.length > CAPS.scanChars ? raw.slice(0, CAPS.scanChars) : raw).replace(BIDI, '');
}

function cleanInline(raw: string): string {
  return neutralizeMentions(scan(raw).replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim());
}

function cleanBlock(raw: string): string {
  const text = scan(raw)
    .replace(/\r\n|[\r\p{Zl}\p{Zp}\x85]/gu, '\n')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]/gu, (ch) => (ch === '\n' ? '\n' : ' '))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
  return neutralizeMentions(text);
}

/** Escapes Markdown control characters and line-start list markers; never splits an escape pair; appends `…` when cut. */
export function escapeTruncate(text: string, max: number): string {
  const chars = Array.from(text);
  const pieces: string[] = [];
  let len = 0;
  let col = 0;
  let onlyDigits = true;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const next = chars[i + 1];
    const listDot = ch === '.' && col > 0 && onlyDigits && (next === undefined || next === ' ' || next === '\n');
    const escape = SPECIAL.has(ch) || (col === 0 && (ch === '-' || ch === '#')) || listDot;
    const piece = escape ? `\\${ch}` : ch;
    if (len + piece.length > max) {
      while (pieces.length > 0 && len + 1 > max) len -= pieces.pop()!.length;
      return max >= 1 ? `${pieces.join('')}…` : '';
    }
    pieces.push(piece);
    len += piece.length;
    if (ch === '\n') {
      col = 0;
      onlyDigits = true;
    } else {
      col += 1;
      if (!isDigit(ch)) onlyDigits = false;
    }
  }
  return pieces.join('');
}

/** Untrusted single-line text, safe to embed anywhere in Markdown, at most `max` characters. */
export function inline(raw: string, max: number): string {
  return escapeTruncate(cleanInline(raw), max);
}

/** Untrusted multi-line text rendered literally, at most `max` characters. */
export function block(raw: string, max: number): string {
  return escapeTruncate(cleanBlock(raw), max);
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
