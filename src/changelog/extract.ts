// SPDX-License-Identifier: AGPL-3.0-or-later
import { CHANGELOG_EXCERPT_MAX } from '../core/constants.ts';
import { escapeInlineTokens, stripHtml, stripUnsafeChars } from '../text/sanitize.ts';
import { finalizeExcerpt } from './excerpt.ts';
import { sanitizeLinks } from './links.ts';

export interface ExtractOptions {
  /** Total budget in characters, including the ellipsis and the full-changelog link. Default `CHANGELOG_EXCERPT_MAX`. */
  maxChars?: number;
  /** Rendered as a trailing `[Full changelog](url)` line inside the budget. */
  fullUrl?: string | null;
}

/** Input beyond this is ignored; a matching section further in falls back to the first section. */
const MAX_INPUT_CHARS = 128 * 1024;
/** Raw characters kept per output character, to absorb markup that sanitising removes. */
const RAW_CHARS_PER_OUTPUT_CHAR = 8;

const TAB = 9;
const NEWLINE = 10;
const SPACE = 32;
const HASH = 35;

interface Heading {
  level: number;
  text: string;
}

function parseHeading(line: string, maxLevel: number): Heading | null {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === SPACE) i++;
  let level = 0;
  while (line.charCodeAt(i) === HASH) {
    i++;
    level++;
  }
  if (level === 0 || level > maxLevel) return null;
  const next = line.charCodeAt(i);
  if (next !== SPACE && next !== TAB) return null;
  return { level, text: line.slice(i + 1) };
}

function isAlphanumeric(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isWholeToken(text: string, start: number, end: number): boolean {
  if (start > 0) {
    const prev = text.charCodeAt(start - 1);
    if (isAlphanumeric(prev)) {
      const isVPrefix = prev === 118 && (start < 2 || !isAlphanumeric(text.charCodeAt(start - 2)));
      if (!isVPrefix) return false;
    } else if (prev === 46 && start > 1 && isDigit(text.charCodeAt(start - 2))) {
      return false;
    }
  }
  if (end < text.length) {
    const next = text.charCodeAt(end);
    const after = text.charCodeAt(end + 1);
    if (isAlphanumeric(next)) return false;
    if (next === 46 && isDigit(after)) return false;
    if ((next === 45 || next === 43) && isAlphanumeric(after)) return false;
  }
  return true;
}

function normalizeVersion(version: string): string {
  const trimmed = version.trim().toLowerCase();
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

function headingHasVersion(heading: string, version: string): boolean {
  if (version === '') return false;
  const text = heading.toLowerCase();
  for (let at = text.indexOf(version); at !== -1; at = text.indexOf(version, at + 1)) {
    if (isWholeToken(text, at, at + version.length)) return true;
  }
  return false;
}

const VERSION_LIKE = /\d+\.\d+/;

interface Span {
  start: number;
  end: number;
}

interface Open {
  start: number;
  level: number;
}

const BACKTICK = 96;
const TILDE = 126;

interface Fence {
  char: number;
  len: number;
}

/** Advances fence state across one line of the raw changelog (CommonMark fenced code blocks). */
function fenceStep(line: string, fence: Fence | null): Fence | null {
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

/** Heading and fence lines examined per changelog. */
const MAX_SPECIAL_LINES = 4096;

/** False for a line that can neither be a heading nor a fence. */
function mayBeSpecial(md: string, pos: number, end: number): boolean {
  let i = pos;
  while (i < end && i - pos < 3 && md.charCodeAt(i) === SPACE) i++;
  const c = md.charCodeAt(i);
  return i < end && (c === HASH || c === BACKTICK || c === TILDE);
}

function isBlank(md: string, pos: number, end: number): boolean {
  for (let i = pos; i < end; i++) {
    const c = md.charCodeAt(i);
    if (c === SPACE || c === TAB) continue;
    if (c > 32 && c < 127) return false;
    return md.slice(pos, end).trim() === '';
  }
  return true;
}

/** End of the section opened at `open`: the next heading of the same or a higher level. */
function sectionEnd(md: string, open: Open, from: number = open.start): number {
  let fence: Fence | null = null;
  let specials = 0;
  let pos = from;
  for (;;) {
    if (md.charCodeAt(pos) === NEWLINE) {
      pos += 1;
      continue;
    }
    const nl = md.indexOf('\n', pos);
    const end = nl === -1 ? md.length : nl;
    if (mayBeSpecial(md, pos, end)) {
      if (++specials > MAX_SPECIAL_LINES) return pos;
      const line = md.slice(pos, end);
      const before = fence;
      fence = fenceStep(line, fence);
      if (before === null && fence === null) {
        const heading = parseHeading(line, 4);
        if (heading !== null && heading.level <= open.level) return pos;
      }
    }
    if (nl === -1) return md.length;
    pos = nl + 1;
  }
}

/** Section for `version`, else the first release-looking section, else the first non-empty one, else the whole text. */
function locateSection(md: string, version: string): Span | null {
  let fence: Fence | null = null;
  let firstVersioned: Open | null = null;
  let firstWithBody: Open | null = null;
  let current: Open | null = null;
  let currentHasBody = false;
  let sawHeading = false;
  let specials = 0;
  let pos = 0;

  for (;;) {
    if (md.charCodeAt(pos) === NEWLINE) {
      pos += 1;
      continue;
    }
    const nl = md.indexOf('\n', pos);
    const end = nl === -1 ? md.length : nl;
    const next = nl === -1 ? md.length : nl + 1;
    if (mayBeSpecial(md, pos, end)) {
      if (++specials > MAX_SPECIAL_LINES) break;
      const line = md.slice(pos, end);
      const before = fence;
      fence = fenceStep(line, fence);
      const heading = before === null && fence === null ? parseHeading(line, 4) : null;
      if (heading !== null) {
        sawHeading = true;
        if (current !== null && currentHasBody && firstWithBody === null) firstWithBody = current;
        current = { start: next, level: heading.level };
        currentHasBody = false;
        if (headingHasVersion(heading.text, version)) {
          return { start: next, end: sectionEnd(md, current) };
        }
        if (firstVersioned === null && VERSION_LIKE.test(heading.text)) firstVersioned = current;
      } else if (current !== null && line.trim() !== '') {
        currentHasBody = true;
      }
    } else if (current !== null && !currentHasBody && !isBlank(md, pos, end)) {
      currentHasBody = true;
    }
    if (nl === -1) break;
    pos = next;
  }

  if (current !== null && currentHasBody && firstWithBody === null) firstWithBody = current;
  const fallback = firstVersioned ?? firstWithBody;
  if (fallback !== null) return { start: fallback.start, end: sectionEnd(md, fallback) };
  return sawHeading ? null : { start: 0, end: md.length };
}

const IMAGE = /!\[([^[\]]*)\]\([^()]*\)/g;

function transformLine(line: string): string {
  const withoutImages = line.includes('![') ? line.replace(IMAGE, '$1') : line;
  const heading = parseHeading(withoutImages, 6);
  if (heading === null) return sanitizeLinks(withoutImages.trimEnd());
  const text = sanitizeLinks(heading.text.replace(/\s+#+\s*$/, '').trim());
  if (text === '') return '';
  return text.includes('**') ? text : `**${text}**`;
}

/** Lines inside a CommonMark fence are kept as written apart from links; every backtick is escaped. */
function renderBody(body: string): string {
  const out: string[] = [];
  let run: string[] = [];
  let fence: Fence | null = null;

  const flush = (): void => {
    if (run.length === 0) return;
    for (const line of stripHtml(run.join('\n')).split('\n')) out.push(escapeInlineTokens(transformLine(line)));
    run = [];
  };

  for (const line of body.split('\n')) {
    const before = fence;
    fence = fenceStep(line, fence);
    if (before !== null || fence !== null) {
      flush();
      out.push(escapeInlineTokens(sanitizeLinks(line.trimEnd())));
    } else {
      run.push(line);
    }
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Excerpt of the changelog section for `version` from a Thunderstore/Hexium `CHANGELOG.md`.
 * Returns null when there is nothing usable. The result never exceeds `maxChars`.
 */
export function extractChangelog(markdown: string | null | undefined, version: string, opts: ExtractOptions = {}): string | null {
  if (typeof markdown !== 'string' || markdown.trim() === '') return null;
  const maxChars = opts.maxChars ?? CHANGELOG_EXCERPT_MAX;
  if (!Number.isFinite(maxChars) || maxChars < 1) return null;

  const md = (markdown.length > MAX_INPUT_CHARS ? markdown.slice(0, MAX_INPUT_CHARS) : markdown).replace(/\r\n?/g, '\n');
  const span = locateSection(md, normalizeVersion(typeof version === 'string' ? version : ''));
  if (span === null) return null;

  const rawLimit = maxChars * RAW_CHARS_PER_OUTPUT_CHAR + 1024;
  let end = span.end;
  let cut = false;
  if (end - span.start > rawLimit) {
    cut = true;
    end = span.start + rawLimit;
    const boundary = md.lastIndexOf('\n', end);
    if (boundary > span.start) end = boundary;
    else if (md.charCodeAt(end - 1) >= 0xd800 && md.charCodeAt(end - 1) <= 0xdbff) end -= 1;
  }

  const body = stripUnsafeChars(md.slice(span.start, end)).replace(/\r\n?/g, '\n');
  if (body.trim() === '') return null;
  return finalizeExcerpt(renderBody(body), { maxChars, fullUrl: opts.fullUrl ?? null, cut });
}
