// SPDX-License-Identifier: AGPL-3.0-or-later
import { normalizeIso } from './iso.ts';

/**
 * Calls `visit(start, end)` for every non-empty line (`end` exclusive, trailing `\r` excluded).
 * No intermediate array; lines are addressed by offsets into `text`.
 */
export function forEachLine(text: string, visit: (start: number, end: number) => void): void {
  const length = text.length;
  let pos = 0;
  while (pos < length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = length;
    let lineEnd = end;
    if (lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
    if (lineEnd > pos) visit(pos, lineEnd);
    pos = end + 1;
  }
}

/**
 * Reads `"key":"value"` from one line given the marker `"key":"`.
 * Returns null when absent, unterminated, or when the value contains an escape.
 */
export function readStringField(line: string, marker: string): string | null {
  const at = line.indexOf(marker);
  if (at === -1) return null;
  const valueStart = at + marker.length;
  const close = line.indexOf('"', valueStart);
  if (close === -1) return null;
  const value = line.slice(valueStart, close);
  return value.includes('\\') ? null : value;
}

/** Reads `"key":123` (non-negative integer) from one line given the marker `"key":`. */
export function readNumberField(line: string, marker: string): number | null {
  const at = line.indexOf(marker);
  if (at === -1) return null;
  let i = at + marker.length;
  const from = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i += 1;
  }
  return i > from ? Number(line.slice(from, i)) : null;
}

/**
 * Single pass over raw NDJSON: finds each `marker` (e.g. `"date_updated":"`) with `indexOf`,
 * compares the ISO timestamp that follows against `cursor`, and hands only lines strictly
 * newer than the cursor to `parse`. Lines without the marker are never parsed. With a null
 * cursor every line carrying the marker is parsed. A line whose timestamp cannot be
 * normalised is parsed, since it cannot be proven old. `parse` returning null, or throwing
 * (malformed JSON), drops the line.
 */
export function scanNdjsonSince<T>(
  text: string,
  marker: string,
  cursor: string | null,
  parse: (line: string) => T | null,
): T[] {
  const out: T[] = [];
  const cursorNorm = cursor === null ? null : normalizeIso(cursor);
  const length = text.length;
  let pos = 0;
  while (pos < length) {
    const at = text.indexOf(marker, pos);
    if (at === -1) break;
    const lineStartNl = text.lastIndexOf('\n', at - 1);
    const lineStart = lineStartNl + 1;
    let lineEnd = text.indexOf('\n', at);
    const nextPos = lineEnd === -1 ? length : lineEnd + 1;
    if (lineEnd === -1) lineEnd = length;
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;

    const valueStart = at + marker.length;
    const close = text.indexOf('"', valueStart);
    const stamp = close === -1 || close > lineEnd ? null : normalizeIso(text.slice(valueStart, close));
    const newer = cursorNorm === null || stamp === null || stamp > cursorNorm;
    if (newer) {
      try {
        const item = parse(text.slice(lineStart, lineEnd));
        if (item !== null) out.push(item);
      } catch {
        // malformed line: skipped
      }
    }
    pos = nextPos;
  }
  return out;
}
