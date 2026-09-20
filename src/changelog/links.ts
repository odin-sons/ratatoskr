// SPDX-License-Identifier: AGPL-3.0-or-later
import { encodeMentionsInUrl } from '../text/sanitize.ts';

export const FULL_CHANGELOG_LABEL = 'Full changelog';

const MAX_TARGET_CHARS = 2048;
const BACKSLASH = 92;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const OPEN_PAREN = 40;
const CLOSE_PAREN = 41;
const HTTP_URL = /^https?:\/\/\S/i;
const HTTP_TARGET_AT = /\s*<?https?:\/\/\S/iy;
const TARGET_END = /[\s]/;

/** Percent-encodes the characters that would end or break a Markdown link target; null unless http(s). */
export function linkTarget(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  const encoded = trimmed.replace(/[\s()<>\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return encodeMentionsInUrl(encoded);
}

/** For every `(` its matching `)` (escapes honoured), -1 when unmatched. One pass. */
function pairParens(line: string): Int32Array {
  const match = new Int32Array(line.length).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === BACKSLASH) i++;
    else if (c === OPEN_PAREN) open.push(i);
    else if (c === CLOSE_PAREN && open.length > 0) match[open.pop()!] = i;
  }
  return match;
}

function urlOf(target: string): string {
  const trimmed = target.trim();
  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>');
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  const space = trimmed.search(TARGET_END);
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

const URL_LOOKING_LABEL = /^(?:https?:\/\/|www\.)\S/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function labelSpoofsHost(text: string, url: string): boolean {
  const label = text.trim();
  if (!URL_LOOKING_LABEL.test(label)) return false;
  const token = label.split(/\s/, 1)[0]!;
  const labelHost = hostOf(/^www\./i.test(token) ? `https://${token}` : token);
  return labelHost === null || labelHost !== hostOf(url);
}

function safeLink(text: string, target: string): string {
  const url = urlOf(target);
  const safe = HTTP_URL.test(url) ? linkTarget(url) : null;
  if (safe === null || labelSpoofsHost(text, url)) return text;
  if (text.trim() === '') return safe;
  if (text.includes(']') || text.trim().toLowerCase() === FULL_CHANGELOG_LABEL.toLowerCase()) return text;
  return `[${text}](${safe})`;
}

/**
 * One left-to-right pass. Every `](` that does not open a kept http(s) link is escaped or degraded.
 * Time O(L): every character is visited once, parentheses are paired in one pass.
 */
function scan(line: string): string {
  let out = '';
  let tail = 0;
  let last = 0;
  let open = -1;
  const emit = (piece: string): void => {
    if (piece === '') return;
    if (tail === CLOSE_BRACKET && piece.charCodeAt(0) === OPEN_PAREN) out += String.fromCharCode(BACKSLASH);
    out += piece;
    tail = piece.charCodeAt(piece.length - 1);
  };
  let parens: Int32Array | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === BACKSLASH) {
      if (line.charCodeAt(i + 1) !== CLOSE_BRACKET) i++;
    } else if (c === OPEN_BRACKET) {
      open = i;
    } else if (c === CLOSE_BRACKET && line.charCodeAt(i + 1) === OPEN_PAREN) {
      parens ??= pairParens(line);
      const close = open === -1 ? -1 : (parens[i + 1] ?? -1);
      if (close === -1 || close - i > MAX_TARGET_CHARS) {
        emit(line.slice(last, i + 1) + String.fromCharCode(BACKSLASH));
        last = i + 1;
        open = -1;
        continue;
      }
      emit(line.slice(last, open));
      emit(safeLink(line.slice(open + 1, i), line.slice(i + 2, close)));
      last = close + 1;
      i = close;
      open = -1;
    }
  }
  emit(line.slice(last));
  return out;
}

/**
 * Keeps `[text](url)` links whose target is http(s) and turns every other one into its plain text.
 * No `](` survives outside a kept link; a link labelled like the trailing full-changelog link is degraded too,
 * so that link stays unique. Code spans are not modelled: the caller escapes every backtick.
 */
export function sanitizeLinks(line: string): string {
  return line.indexOf('](') === -1 ? line : scan(line);
}
