// SPDX-License-Identifier: AGPL-3.0-or-later
import { normalizeIso } from './iso.ts';

const UPDATED = '"date_updated":"';
const CREATED = '"date_created":"';
const OBJECT_START = '{"name":"';
const NEXT_ITEM = ',{"name":"';
const VERSIONS = ',"versions":[';
const ARRAY_TAIL = '}]}';

export interface DumpRecord {
  owner: string;
  name: string;
  updatedAt: string;
  isNsfw: boolean;
  isDeprecated: boolean;
  categories: string[];
  /** Newest entry of `versions[]` by `date_created`. */
  version: string;
  description: string | null;
  iconUrl: string | null;
  sizeBytes: number | null;
}

/**
 * Per-record decision, given the first listed version, whether to run the full extraction
 * (newest version, description, icon, categories, size). Records answered false stay lean.
 */
export type DetailFilter = (owner: string, name: string, version: string) => boolean;

export interface DumpScan {
  /** Newest `date_updated` over every record, matched or not. */
  maxUpdated: string | null;
  records: number;
  /** Matched records that could not be extracted. */
  failed: number;
}

function stampAt(text: string, marker: string, at: number): string | null {
  const start = at + marker.length;
  const end = text.indexOf('"', start);
  if (end === -1) return null;
  const raw = text.slice(start, end);
  const canonical = raw.length === 27 && raw.charCodeAt(26) === 90 && raw.charCodeAt(10) === 84;
  return canonical ? raw : normalizeIso(raw);
}

function decode(raw: string): string | null {
  if (!raw.includes('\\')) return raw;
  try {
    const value: unknown = JSON.parse(`"${raw}"`);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Reads `"key":"value"` after `marker` within `[from, to)`, decoding JSON escapes. */
function readString(text: string, marker: string, from: number, to: number): string | null {
  const at = text.indexOf(marker, from);
  if (at === -1 || at >= to) return null;
  const start = at + marker.length;
  let end = start;
  for (;;) {
    end = text.indexOf('"', end);
    if (end === -1 || end >= to) return null;
    let slashes = 0;
    while (text.charCodeAt(end - 1 - slashes) === 92) slashes += 1;
    if (slashes % 2 === 0) break;
    end += 1;
  }
  const value = decode(text.slice(start, end));
  return value === '' ? null : value;
}

interface Flags {
  isDeprecated: boolean;
  isNsfw: boolean;
  /** Offset just after `"categories":[`. */
  categoriesAt: number;
}

const NSFW_KEY = ',"has_nsfw_content":';
const CATEGORIES_KEY = ',"categories":[';

/** Reads `"is_deprecated":b,"has_nsfw_content":b,"categories":[` positionally. */
function readFlags(text: string, from: number, versionsAt: number): Flags | null {
  const at = text.indexOf('"is_deprecated":', from);
  if (at === -1 || at >= versionsAt) return null;
  let p = at + 16;
  const isDeprecated = text.charCodeAt(p) === 116;
  if (!isDeprecated && text.charCodeAt(p) !== 102) return null;
  p += isDeprecated ? 4 : 5;
  if (!text.startsWith(NSFW_KEY, p)) return null;
  p += NSFW_KEY.length;
  const isNsfw = text.charCodeAt(p) === 116;
  if (!isNsfw && text.charCodeAt(p) !== 102) return null;
  p += isNsfw ? 4 : 5;
  if (!text.startsWith(CATEGORIES_KEY, p)) return null;
  return { isDeprecated, isNsfw, categoriesAt: p + CATEGORIES_KEY.length };
}

function readCategories(text: string, start: number, versionsAt: number): string[] | null {
  const end = versionsAt - 1;
  if (text.charCodeAt(end) !== 93 || end < start) return null;
  if (end === start) return [];
  const raw = text.slice(start, end);
  if (raw.includes('\\')) {
    try {
      const parsed: unknown = JSON.parse(`[${raw}]`);
      return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : null;
    } catch {
      return null;
    }
  }
  return raw.slice(1, -1).split('","');
}

function readSize(text: string, itemStart: number, itemEnd: number): number | null {
  const at = text.lastIndexOf('"file_size":', itemEnd);
  if (at < itemStart) return null;
  let i = at + 12;
  const from = i;
  while (i < itemEnd) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i += 1;
  }
  return i > from ? Number(text.slice(from, i)) : null;
}

function extract(
  text: string,
  at: number,
  updatedAt: string,
  regionEnd: number,
  wantDetail: DetailFilter | undefined,
): DumpRecord | null {
  const headerStart = text.lastIndexOf(OBJECT_START, at);
  const versionsAt = text.indexOf(VERSIONS, at);
  if (headerStart === -1 || versionsAt === -1 || versionsAt >= regionEnd) return null;

  const name = readString(text, '"name":"', headerStart, versionsAt);
  const owner = readString(text, '"owner":"', headerStart, versionsAt);
  const flags = readFlags(text, headerStart, versionsAt);
  if (name === null || owner === null || flags === null) return null;

  const leanVersion = readString(text, '"version_number":"', versionsAt, regionEnd);
  if (leanVersion === null) return null;
  if (wantDetail !== undefined && !wantDetail(owner, name, leanVersion)) {
    return {
      owner,
      name,
      updatedAt,
      isNsfw: flags.isNsfw,
      isDeprecated: flags.isDeprecated,
      categories: [],
      version: leanVersion,
      description: null,
      iconUrl: null,
      sizeBytes: null,
    };
  }

  const firstAt = text.indexOf(CREATED, versionsAt);
  const lastAt = text.lastIndexOf(CREATED, regionEnd);
  if (firstAt === -1 || firstAt >= regionEnd || lastAt < versionsAt) return null;
  let bestAt = firstAt;
  if (lastAt !== firstAt) {
    const first = stampAt(text, CREATED, firstAt);
    const last = stampAt(text, CREATED, lastAt);
    if (first === null || last === null) return null;
    if (last > first) bestAt = lastAt;
  }

  const itemStart = text.lastIndexOf(OBJECT_START, bestAt);
  let itemEnd = text.indexOf(NEXT_ITEM, bestAt);
  if (itemEnd === -1 || itemEnd >= regionEnd - 1) itemEnd = text.lastIndexOf(ARRAY_TAIL, regionEnd) + 1;
  if (itemStart <= versionsAt || itemEnd <= itemStart) return null;

  const version = readString(text, '"version_number":"', itemStart, itemEnd);
  if (version === null) return null;
  const categories = readCategories(text, flags.categoriesAt, versionsAt);
  if (categories === null) return null;
  return {
    owner,
    name,
    updatedAt,
    isNsfw: flags.isNsfw,
    isDeprecated: flags.isDeprecated,
    categories,
    version,
    description: readString(text, '"description":"', itemStart, itemEnd),
    iconUrl: readString(text, '"icon":"', itemStart, itemEnd),
    sizeBytes: readSize(text, itemStart, itemEnd),
  };
}

export interface DumpSlice {
  index: number;
  count: number;
}

export interface DumpScanOptions {
  /** Only records whose sequential id (`uuid4`) modulo `count` equals `index` are considered. */
  slice?: DumpSlice;
  wantDetail?: DetailFilter;
}

const UUID_OFFSET = UPDATED.length + 27 + 1;
const UUID_KEY = ',"uuid4":"';

/** Sequential creation id embedded in the record's `uuid4`, or null when the layout differs. */
function sequenceOf(text: string, at: number): number | null {
  const keyAt = at + UUID_OFFSET;
  if (!text.startsWith(UUID_KEY, keyAt)) return null;
  const seq = Number.parseInt(text.slice(keyAt + UUID_KEY.length, keyAt + UUID_KEY.length + 8), 16);
  return Number.isNaN(seq) ? null : seq;
}

/**
 * Single indexOf pass over the raw `/api/v1/package/` body (compact JSON, one `"date_updated":"`
 * per record). Records with `date_updated >= cursor` (all when null), inside the optional slice,
 * are extracted by field offsets; the body is never JSON.parsed. `maxUpdated` covers every record.
 */
export function scanPackageDump(
  text: string,
  cursor: string | null,
  visit: (record: DumpRecord) => void,
  options: DumpScanOptions = {},
): DumpScan {
  const { slice, wantDetail } = options;
  const cursorNorm = cursor === null ? null : normalizeIso(cursor);
  const scan: DumpScan = { maxUpdated: null, records: 0, failed: 0 };
  let pendingAt = -1;
  let pendingStamp = '';

  const flush = (regionEnd: number): void => {
    if (pendingAt === -1) return;
    const record = extract(text, pendingAt, pendingStamp, regionEnd, wantDetail);
    if (record === null) scan.failed += 1;
    else visit(record);
    pendingAt = -1;
  };

  for (let pos = 0; ; ) {
    const at = text.indexOf(UPDATED, pos);
    if (at === -1) break;
    pos = at + UPDATED.length;
    scan.records += 1;
    const stamp = stampAt(text, UPDATED, at);
    if (stamp !== null && (scan.maxUpdated === null || stamp > scan.maxUpdated)) scan.maxUpdated = stamp;

    if (pendingAt !== -1) flush(text.lastIndexOf(OBJECT_START, at));
    if (stamp === null) {
      scan.failed += 1;
      continue;
    }
    if (cursorNorm !== null && stamp < cursorNorm) continue;
    if (slice !== undefined) {
      const seq = sequenceOf(text, at);
      if (seq !== null && seq % slice.count !== slice.index) continue;
    }
    pendingAt = at;
    pendingStamp = stamp;
  }
  flush(text.length);
  return scan;
}
