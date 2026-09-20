// SPDX-License-Identifier: AGPL-3.0-or-later
import { normalizeIso } from './iso.ts';

const UPDATED = '"date_updated":"';
const CREATED = '"date_created":"';
const OBJECT_START = '{"name":"';
const ITEM_SEP = '},{"name":"';
const RECORD_SEP = ']},{"name":"';
const RECORD_CLOSE = '}]}';
const EMPTY_VERSIONS_CLOSE = '"versions":[]}';
const VERSIONS = ',"versions":[';
const CATEGORIES_KEY = ',"categories":[';
const NSFW_KEY = '"has_nsfw_content":';
const DEPRECATED_KEY = '"is_deprecated":';
const RECORD_END_LENGTH = 2;
const RECORD_SEP_HEAD = 3;
const CLOSING_BRACKET = 93;
const CLOSE_BRACE = 125;

/** A lean record longer than this is checked for a second `date_updated` marker, which means the separators were lost. */
const LEAN_GUARD_CHARS = 16 * 1024;

/** The scan stops when this many records failed and none has been read yet. */
export const EARLY_ABORT_FAILURES = 8;

export interface DumpRecord {
  owner: string;
  name: string;
  updatedAt: string;
  isNsfw: boolean;
  isDeprecated: boolean;
  categories: string[];
  /** Newest entry of `versions[]` by `date_created`. */
  version: string;
  /** Second-newest by `date_created`, null with a single version. Absent when the history was not read (lean). */
  previousVersion?: string | null;
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
  /** Newest valid `date_updated` over every record, matched or not, not later than `notAfter`. */
  maxUpdated: string | null;
  records: number;
  /** Records that could not be read; they are skipped, never emitted. */
  failed: number;
  /** The scan stopped early: the first records all failed. */
  aborted: boolean;
}

const CANONICAL_STAMP = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/;

function stampAt(text: string, at: number, marker: string): string | null {
  const start = at + marker.length;
  const end = text.indexOf('"', start);
  if (end === -1) return null;
  const raw = text.slice(start, end);
  return CANONICAL_STAMP.test(raw) ? raw : normalizeIso(raw);
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

/** Reads `"key":"value"` after `marker`, decoding JSON escapes. `text` is already bounded to one record or item. */
function readString(text: string, marker: string, from: number): string | null {
  const at = text.indexOf(marker, from);
  if (at === -1) return null;
  const start = at + marker.length;
  let end = start;
  for (;;) {
    end = text.indexOf('"', end);
    if (end === -1) return null;
    let slashes = 0;
    while (text.charCodeAt(end - 1 - slashes) === 92) slashes += 1;
    if (slashes % 2 === 0) break;
    end += 1;
  }
  const value = decode(text.slice(start, end));
  return value === '' ? null : value;
}

/** `true`/`false` after `key`, null when the key is missing or the value is anything else. */
function readBool(text: string, key: string): boolean | null {
  const at = text.indexOf(key);
  if (at === -1) return null;
  const p = at + key.length;
  const isTrue = text.startsWith('true', p);
  const length = isTrue ? 4 : text.startsWith('false', p) ? 5 : 0;
  if (length === 0) return null;
  const next = text.charCodeAt(p + length);
  return next === 44 || next === 125 || Number.isNaN(next) ? isTrue : null;
}

function readCategories(header: string): string[] | null {
  const at = header.indexOf(CATEGORIES_KEY);
  if (at === -1 || header.charCodeAt(header.length - 1) !== 93) return null;
  const start = at + CATEGORIES_KEY.length;
  const end = header.length - 1;
  if (end < start) return null;
  if (end === start) return [];
  const raw = header.slice(start, end);
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

function readSize(item: string): number | null {
  const at = item.lastIndexOf('"file_size":');
  if (at === -1) return null;
  let i = at + 12;
  const from = i;
  while (i < item.length) {
    const c = item.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i += 1;
  }
  return i > from ? Number(item.slice(from, i)) : null;
}

interface Release {
  created: string;
  version: string;
  item: string;
}

/** Newest and second-newest release by `date_created`, over every item of `versions[]`. */
function newestReleases(versions: string): { newest: Release; previous: Release | null } | null {
  let newest: Release | null = null;
  let previous: Release | null = null;
  for (let from = 0; ; ) {
    const sep = versions.indexOf(ITEM_SEP, from);
    const item = versions.slice(from, sep === -1 ? versions.length : sep + 1);
    const createdAt = item.indexOf(CREATED);
    const created = createdAt === -1 ? null : stampAt(item, createdAt, CREATED);
    const version = created === null ? null : readString(item, '"version_number":"', 0);
    if (created !== null && version !== null) {
      const release = { created, version, item };
      if (newest === null || created > newest.created) {
        previous = newest;
        newest = release;
      } else if (previous === null || created > previous.created) {
        previous = release;
      }
    }
    if (sep === -1) break;
    from = sep + 2;
  }
  return newest === null ? null : { newest, previous };
}

function extract(region: string, updatedAt: number, updated: string, wantDetail: DetailFilter | undefined): DumpRecord | null {
  const versionsAt = region.indexOf(VERSIONS);
  if (versionsAt === -1 || updatedAt >= versionsAt) return null;
  const header = region.slice(0, versionsAt);

  const name = readString(header, '"name":"', 0);
  const owner = readString(header, '"owner":"', 0);
  const isNsfw = readBool(header, NSFW_KEY);
  const isDeprecated = readBool(header, DEPRECATED_KEY);
  if (name === null || owner === null || isNsfw === null || isDeprecated === null) return null;

  const leanVersion = readString(region, '"version_number":"', versionsAt);
  if (leanVersion === null) return null;
  if (wantDetail !== undefined && !wantDetail(owner, name, leanVersion)) {
    if (region.length > LEAN_GUARD_CHARS && region.indexOf(UPDATED, versionsAt) !== -1) return null;
    return { owner, name, updatedAt: updated, isNsfw, isDeprecated, categories: [], version: leanVersion, description: null, iconUrl: null, sizeBytes: null };
  }

  const versions = region.slice(versionsAt + VERSIONS.length);
  if (versions.includes(UPDATED)) return null;
  const releases = newestReleases(versions);
  const categories = readCategories(header);
  if (releases === null || categories === null) return null;
  const { item } = releases.newest;
  return {
    owner,
    name,
    updatedAt: updated,
    isNsfw,
    isDeprecated,
    categories,
    version: releases.newest.version,
    previousVersion: releases.previous?.version ?? null,
    description: readString(item, '"description":"', 0),
    iconUrl: readString(item, '"icon":"', 0),
    sizeBytes: readSize(item),
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
  /** Records stamped later than this are still read but never raise `maxUpdated`. */
  notAfter?: string;
}

const UUID_OFFSET = UPDATED.length + 27 + 1;
const UUID_KEY = ',"uuid4":"';

/** Sequential creation id embedded in the record's `uuid4`, or null when the layout differs. */
function sequenceOf(region: string, updatedAt: number): number | null {
  const keyAt = updatedAt + UUID_OFFSET;
  if (!region.startsWith(UUID_KEY, keyAt)) return null;
  const seq = Number.parseInt(region.slice(keyAt + UUID_KEY.length, keyAt + UUID_KEY.length + 8), 16);
  return Number.isNaN(seq) ? null : seq;
}

/**
 * Position of the `]` that closes a record and is followed by the next one: the last version object closes
 * (`}]}`) or `versions` is empty. A version item that merely ends with an array is skipped.
 */
function recordSeparator(text: string, from: number): number {
  for (let at = text.indexOf(RECORD_SEP, from); at !== -1; at = text.indexOf(RECORD_SEP, at + 1)) {
    if (text.charCodeAt(at - 1) === CLOSE_BRACE || text.startsWith(EMPTY_VERSIONS_CLOSE, at - EMPTY_VERSIONS_CLOSE.length + 2)) return at;
  }
  return -1;
}

function closesRecord(region: string): boolean {
  return region.endsWith(RECORD_CLOSE) || region.endsWith(EMPTY_VERSIONS_CLOSE);
}

/** End of the last record: the body without trailing whitespace and the closing bracket of the array. */
function lastRecordEnd(text: string): number {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) <= 32) end -= 1;
  return text.charCodeAt(end - 1) === CLOSING_BRACKET ? end - 1 : end;
}

/**
 * Scans the raw `/api/v1/package/` body record by record and extracts those whose `date_updated` is at or
 * after the cursor and inside the optional slice. Every search stays inside one record; nothing is JSON.parsed.
 */
export function scanPackageDump(
  text: string,
  cursor: string | null,
  visit: (record: DumpRecord) => void,
  options: DumpScanOptions = {},
): DumpScan {
  const { slice, wantDetail } = options;
  const cursorNorm = cursor === null ? null : normalizeIso(cursor);
  const ceiling = options.notAfter === undefined ? null : normalizeIso(options.notAfter);
  const scan: DumpScan = { maxUpdated: null, records: 0, failed: 0, aborted: false };
  let read = 0;

  for (let start = text.indexOf(OBJECT_START); start !== -1; ) {
    const sep = recordSeparator(text, start);
    const region = text.slice(start, sep === -1 ? lastRecordEnd(text) : sep + RECORD_END_LENGTH);
    start = sep === -1 ? -1 : sep + RECORD_SEP_HEAD;
    scan.records += 1;

    const updatedAt = closesRecord(region) ? region.indexOf(UPDATED) : -1;
    const stamp = updatedAt === -1 ? null : stampAt(region, updatedAt, UPDATED);
    let record: DumpRecord | null = null;
    if (stamp !== null) {
      if ((ceiling === null || stamp <= ceiling) && (scan.maxUpdated === null || stamp > scan.maxUpdated)) scan.maxUpdated = stamp;
      if (cursorNorm !== null && stamp < cursorNorm) continue;
      if (slice !== undefined) {
        const seq = sequenceOf(region, updatedAt);
        if (seq !== null && seq % slice.count !== slice.index) continue;
      }
      record = extract(region, updatedAt, stamp, wantDetail);
    }

    if (record !== null) {
      read += 1;
      visit(record);
    } else {
      scan.failed += 1;
      if (read === 0 && scan.failed >= EARLY_ABORT_FAILURES) {
        scan.aborted = true;
        break;
      }
    }
  }
  return scan;
}
