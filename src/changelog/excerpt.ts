// SPDX-License-Identifier: AGPL-3.0-or-later
import { neutralizeMentions } from '../text/sanitize.ts';
import { FULL_CHANGELOG_LABEL, linkTarget } from './links.ts';

const ELLIPSIS = '…';

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

function dropTrailingBackslash(text: string): string {
  let n = 0;
  while (text.charCodeAt(text.length - 1 - n) === 92) n++;
  return n % 2 === 1 ? text.slice(0, -1) : text;
}

function safeEnd(text: string, end: number): number {
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/** Longest whole-line prefix of `body` (at most `limit` chars) that does not end inside a link. */
function cutAtLine(body: string, limit: number): string | null {
  let end = body.length <= limit ? body.length : body.lastIndexOf('\n', limit);
  while (end > 0) {
    const prefix = body.slice(0, end);
    const link = danglingLinkStart(prefix);
    if (link !== -1) {
      end = link - 1;
      continue;
    }
    const trimmed = prefix.trimEnd();
    if (trimmed.length > limit) {
      end = body.lastIndexOf('\n', trimmed.length - 1);
      continue;
    }
    return trimmed === '' ? null : trimmed;
  }
  return null;
}

/** Fallback when no whole line fits: hard cut, drop a half link and a dangling backslash. */
function cutHard(body: string, limit: number): string | null {
  let text = body.slice(0, safeEnd(body, Math.min(limit, body.length)));
  const open = text.lastIndexOf('[');
  if (open > text.lastIndexOf(']')) {
    text = text.slice(0, open);
  } else {
    const target = text.lastIndexOf('](');
    if (target !== -1 && text.indexOf(')', target) === -1) text = text.slice(0, Math.max(text.lastIndexOf('[', target), 0));
  }
  text = dropTrailingBackslash(text).trimEnd();
  return text === '' ? null : text;
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
  let link = target === null ? null : `[${FULL_CHANGELOG_LABEL}](${target})`;
  if (link !== null && (link.length + 1) * 2 >= maxChars) link = null;
  const suffix = link === null ? '' : `\n${link}`;
  const budget = maxChars - suffix.length;

  if (opts.cut !== true && body.length <= budget) return body + suffix;

  const limit = budget - 1;
  if (limit < 1) return ELLIPSIS + suffix;
  const cut = cutAtLine(body, limit) ?? cutHard(body, limit);
  return cut === null ? null : `${cut}${ELLIPSIS}${suffix}`;
}
