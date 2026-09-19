// SPDX-License-Identifier: AGPL-3.0-or-later
import { neutralizeMentions } from '../text/sanitize.ts';

const ELLIPSIS = '…';
const FENCE_CLOSE = '\n```';

export interface Fence {
  char: number;
  len: number;
}

const BACKTICK = 96;
const TILDE = 126;
const SPACE = 32;

/** Advances fence state across one line (CommonMark fenced code blocks). */
export function fenceStep(line: string, fence: Fence | null): Fence | null {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === SPACE) i++;
  const char = line.charCodeAt(i);
  if (char !== BACKTICK && char !== TILDE) return fence;
  let j = i;
  while (line.charCodeAt(j) === char) j++;
  const len = j - i;
  if (len < 3) return fence;
  if (fence === null) {
    if (char === BACKTICK && line.indexOf('`', j) !== -1) return null;
    return { char, len };
  }
  if (char === fence.char && len >= fence.len && line.slice(j).trim() === '') return null;
  return fence;
}

/** Start index of the line that opened a fence still open at the end of `text`, or -1. */
function openFenceStart(text: string): number {
  let fence: Fence | null = null;
  let openedAt = -1;
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const before = fence;
    fence = fenceStep(text.slice(pos, end), fence);
    if (before === null && fence !== null) openedAt = pos;
    if (nl === -1) break;
    pos = nl + 1;
  }
  return fence === null ? -1 : openedAt;
}

function lineStart(text: string, index: number): number {
  return text.lastIndexOf('\n', index - 1) + 1;
}

/** Start of the line holding a Markdown link cut in half at the end of `text`, or -1. */
function danglingLinkStart(text: string): number {
  const open = text.lastIndexOf('[');
  if (open > text.lastIndexOf(']')) return lineStart(text, open);
  const target = text.lastIndexOf('](');
  if (target !== -1 && text.indexOf(')', target) === -1) {
    return lineStart(text, Math.max(text.lastIndexOf('[', target), 0));
  }
  return -1;
}

function endsWithFenceLine(text: string): boolean {
  const last = text.slice(text.lastIndexOf('\n') + 1).trimStart();
  return last.startsWith('```') || last.startsWith('~~~');
}

function dropTrailingBackslash(text: string): string {
  let n = 0;
  while (text.charCodeAt(text.length - 1 - n) === 92) n++;
  return n % 2 === 1 ? text.slice(0, -1) : text;
}

function safeEnd(text: string, end: number): number {
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

interface Cut {
  text: string;
  separator: string;
}

/** Longest whole-line prefix of `body` (at most `limit` chars) that is not inside a fence or a link. */
function cutAtLine(body: string, limit: number): Cut | null {
  let end = body.length <= limit ? body.length : body.lastIndexOf('\n', limit);
  while (end > 0) {
    const prefix = body.slice(0, end);
    const fence = openFenceStart(prefix);
    if (fence !== -1) {
      end = fence - 1;
      continue;
    }
    const link = danglingLinkStart(prefix);
    if (link !== -1) {
      end = link - 1;
      continue;
    }
    const trimmed = prefix.trimEnd();
    const separator = endsWithFenceLine(trimmed) ? '\n' : '';
    if (trimmed.length + separator.length > limit) {
      end = body.lastIndexOf('\n', trimmed.length - 1);
      continue;
    }
    return trimmed === '' ? null : { text: trimmed, separator };
  }
  return null;
}

/** Fallback when no whole line fits: hard cut, drop a half link, close an open fence. */
function cutHard(body: string, limit: number): Cut | null {
  let text = body.slice(0, safeEnd(body, Math.min(limit, body.length)));
  if (openFenceStart(text) !== -1) {
    const room = limit - FENCE_CLOSE.length - 1;
    text = body.slice(0, safeEnd(body, Math.max(Math.min(room, body.length), 0)));
    if (openFenceStart(text) !== -1) return { text: text + FENCE_CLOSE, separator: '\n' };
  }
  const open = text.lastIndexOf('[');
  if (open > text.lastIndexOf(']')) {
    text = text.slice(0, open);
  } else {
    const target = text.lastIndexOf('](');
    if (target !== -1 && text.indexOf(')', target) === -1) text = text.slice(0, Math.max(text.lastIndexOf('[', target), 0));
  }
  text = dropTrailingBackslash(text).trimEnd();
  return text === '' ? null : { text, separator: '' };
}

function linkTarget(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed.replace(/[\s()<>\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

export interface FinalizeOptions {
  maxChars: number;
  fullUrl?: string | null;
  /** The caller already dropped text from the end of `text`, so an ellipsis is always due. */
  cut?: boolean;
}

/**
 * Neutralises mentions, then fits `text` into `maxChars` in total, including the ellipsis and
 * the trailing `[Full changelog](url)` line. The link is omitted when it would take half the budget or more.
 */
export function finalizeExcerpt(text: string, opts: FinalizeOptions): string | null {
  const { maxChars } = opts;
  if (!Number.isFinite(maxChars) || maxChars < 1) return null;
  const body = neutralizeMentions(text).trim();
  if (body === '') return null;

  const target = linkTarget(opts.fullUrl);
  let link = target === null ? null : `[Full changelog](${target})`;
  if (link !== null && (link.length + 1) * 2 >= maxChars) link = null;
  const suffix = link === null ? '' : `\n${link}`;
  const budget = maxChars - suffix.length;

  if (opts.cut !== true && body.length <= budget) {
    if (openFenceStart(body) === -1) return body + suffix;
    if (body.length + FENCE_CLOSE.length <= budget) return body + FENCE_CLOSE + suffix;
  }

  const limit = budget - 1;
  if (limit < 1) return ELLIPSIS + suffix;
  const cut = cutAtLine(body, limit) ?? cutHard(body, limit);
  if (cut === null) return null;
  return `${cut.text}${cut.separator}${ELLIPSIS}${suffix}`;
}
