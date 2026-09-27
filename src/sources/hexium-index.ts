// SPDX-License-Identifier: AGPL-3.0-or-later
import { HEXIUM_INDEX_MAX_LINES, HEXIUM_INDEX_MAX_LINE_BYTES } from './budget.ts';

const CR = 13;

/**
 * Line head in the live key order. Names are 1-128 chars of [A-Za-z0-9_.-] not starting with a dot (so a value
 * is never `.` or `..` in a URL path); the version is 1-64 characters without quote, backslash or control
 * characters. Sticky, bounded quantifiers over disjoint classes: no backtracking, and no match spans a newline.
 */
const LINE_HEAD =
  /\{"namespace":"([A-Za-z0-9_-][A-Za-z0-9_.-]{0,127})","name":"([A-Za-z0-9_-][A-Za-z0-9_.-]{0,127})","version_number":"([^"\\\u0000-\u001f]{1,64})"(?:,"file_format":"[A-Za-z0-9._-]{1,16}","file_size":([0-9]{1,15})(?=[,}]))?/y;

export interface IndexEntry {
  namespace: string;
  name: string;
  version: string;
  sizeBytes: number | null;
}

export interface IndexScan {
  /** Non-blank lines seen. */
  lines: number;
  /** Lines that could not be read; they are skipped, never emitted. */
  failed: number;
  /** The scan stopped at `HEXIUM_INDEX_MAX_LINES`. */
  truncated: boolean;
}

function parseLine(text: string, start: number, stop: number): IndexEntry | null {
  if (stop - start > HEXIUM_INDEX_MAX_LINE_BYTES) return null;
  LINE_HEAD.lastIndex = start;
  const head = LINE_HEAD.exec(text);
  if (head === null) return null;
  return { namespace: head[1]!, name: head[2]!, version: head[3]!, sizeBytes: head[4] === undefined ? null : Number(head[4]) };
}

/**
 * Reads the NDJSON package index line by line with `indexOf` and one sticky regex per line; nothing is
 * JSON.parsed. Every read is bounded by its line, so the cost is linear in the body size.
 */
export function scanPackageIndex(text: string, visit: (entry: IndexEntry) => void): IndexScan {
  const scan: IndexScan = { lines: 0, failed: 0, truncated: false };
  for (let start = 0; start < text.length; ) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const next = end + 1;
    if (end > start && text.charCodeAt(end - 1) === CR) end -= 1;
    if (end > start) {
      if (scan.lines >= HEXIUM_INDEX_MAX_LINES) {
        scan.truncated = true;
        break;
      }
      scan.lines += 1;
      const entry = parseLine(text, start, end);
      if (entry === null) scan.failed += 1;
      else visit(entry);
    }
    start = next;
  }
  return scan;
}

/** FNV-1a of `namespace-name` with a murmur3 finalizer (FNV alone keeps low bits weak), modulo `count`; no id string is built. */
export function seedSliceOf(namespace: string, name: string, count: number): number {
  let hash = 2166136261;
  for (let i = 0; i < namespace.length; i += 1) hash = Math.imul(hash ^ namespace.charCodeAt(i), 16777619);
  hash = Math.imul(hash ^ 45, 16777619);
  for (let i = 0; i < name.length; i += 1) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) % count;
}
