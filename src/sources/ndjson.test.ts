// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { forEachLine, readNumberField, readStringField, scanNdjsonSince } from './ndjson.ts';

const MARKER = '"date_updated":"';
const parse = (line: string): { id: number; d: string } | null => {
  const o = JSON.parse(line) as { id: number; date_updated: string };
  return { id: o.id, d: o.date_updated };
};
const ids = (rows: { id: number }[]): number[] => rows.map((r) => r.id);
const row = (id: number, d: string, extra = ''): string => `{"id":${id},"date_updated":"${d}"${extra}}`;

describe('forEachLine', () => {
  it('yields offsets for LF, CRLF and a missing trailing newline, skipping blanks', () => {
    const text = 'aa\r\nbb\n\n\r\ncc';
    const seen: string[] = [];
    forEachLine(text, (s, e) => seen.push(text.slice(s, e)));
    expect(seen).toEqual(['aa', 'bb', 'cc']);
  });

  it('handles empty input and a lone newline', () => {
    const seen: string[] = [];
    forEachLine('', (s, e) => seen.push(`${s}-${e}`));
    forEachLine('\n', (s, e) => seen.push(`${s}-${e}`));
    expect(seen).toEqual([]);
  });
});

describe('readStringField / readNumberField', () => {
  it('reads plain values and rejects escapes, absence and unterminated strings', () => {
    expect(readStringField('{"a":"x","b":"y"}', '"b":"')).toBe('y');
    expect(readStringField('{"a":"x\\"z"}', '"a":"')).toBeNull();
    expect(readStringField('{"a":1}', '"b":"')).toBeNull();
    expect(readStringField('{"a":"open', '"a":"')).toBeNull();
  });

  it('reads non-negative integers only', () => {
    expect(readNumberField('{"n":42,"m":1}', '"n":')).toBe(42);
    expect(readNumberField('{"n":-4}', '"n":')).toBeNull();
    expect(readNumberField('{"n":"4"}', '"n":')).toBeNull();
    expect(readNumberField('{}', '"n":')).toBeNull();
  });
});

describe('scanNdjsonSince', () => {
  const lines = [
    row(1, '2026-09-18T10:00:00.000000Z'),
    row(2, '2026-09-18T12:00:00.000000Z'),
    row(3, '2026-09-18T14:00:00.000000Z'),
  ];

  it('returns everything for a null cursor', () => {
    expect(ids(scanNdjsonSince(lines.join('\n'), MARKER, null, parse))).toEqual([1, 2, 3]);
  });

  it('returns only lines strictly newer than the cursor', () => {
    expect(ids(scanNdjsonSince(lines.join('\n'), MARKER, '2026-09-18T12:00:00.000000Z', parse))).toEqual([3]);
  });

  it('handles CRLF line endings', () => {
    const out = scanNdjsonSince(lines.join('\r\n') + '\r\n', MARKER, '2026-09-18T10:00:00Z', parse);
    expect(ids(out)).toEqual([2, 3]);
  });

  it('handles a missing trailing newline and a trailing newline alike', () => {
    expect(ids(scanNdjsonSince(lines.join('\n'), MARKER, null, parse))).toEqual([1, 2, 3]);
    expect(ids(scanNdjsonSince(lines.join('\n') + '\n', MARKER, null, parse))).toEqual([1, 2, 3]);
  });

  it('skips lines lacking the marker without parsing them', () => {
    const text = [lines[0], '{"id":9,"other":true}', '', lines[2]].join('\n');
    let parsed = 0;
    const out = scanNdjsonSince(text, MARKER, null, (l) => {
      parsed += 1;
      return parse(l);
    });
    expect(ids(out)).toEqual([1, 3]);
    expect(parsed).toBe(2);
  });

  it('does not treat a marker inside an escaped string value as a timestamp', () => {
    const tricky = `{"id":7,"note":"say \\"date_updated\\":\\"2099-01-01T00:00:00Z\\"","date_updated":"2026-09-18T10:00:00Z"}`;
    const out = scanNdjsonSince(tricky, MARKER, '2026-09-18T11:00:00Z', parse);
    expect(out).toEqual([]);
  });

  it('skips malformed JSON lines instead of throwing', () => {
    const text = [lines[0], `{"id":5,"date_updated":"2026-09-18T20:00:00Z"`, lines[2]].join('\n');
    expect(ids(scanNdjsonSince(text, MARKER, null, parse))).toEqual([1, 3]);
  });

  it('honours a parse callback returning null', () => {
    const out = scanNdjsonSince(lines.join('\n'), MARKER, null, (l) => {
      const p = parse(l);
      return p !== null && p.id !== 2 ? p : null;
    });
    expect(ids(out)).toEqual([1, 3]);
  });

  it('compares fractional seconds numerically, not lexically', () => {
    const text = [row(1, '2026-09-18T10:00:00Z'), row(2, '2026-09-18T10:00:00.5Z'), row(3, '2026-09-18T10:00:00.000001Z')].join('\n');
    expect(ids(scanNdjsonSince(text, MARKER, '2026-09-18T10:00:00.000000Z', parse))).toEqual([2, 3]);
    expect(ids(scanNdjsonSince(text, MARKER, '2026-09-18T10:00:00.4Z', parse))).toEqual([2]);
  });

  it('treats Z and +00:00 as the same instant and converts other offsets', () => {
    const text = [row(1, '2026-09-18T10:00:00+00:00'), row(2, '2026-09-18T12:00:00+02:00'), row(3, '2026-09-18T10:00:01Z')].join('\n');
    expect(ids(scanNdjsonSince(text, MARKER, '2026-09-18T10:00:00Z', parse))).toEqual([3]);
  });

  it('parses a line whose timestamp cannot be normalised', () => {
    const text = row(1, 'yesterday');
    expect(ids(scanNdjsonSince(text, MARKER, '2026-09-18T10:00:00Z', parse))).toEqual([1]);
  });

  it('only considers the first marker on a line', () => {
    const text = row(1, '2026-09-18T10:00:00Z', ',"nested":{"date_updated":"2099-01-01T00:00:00Z"}') + '\n' + row(2, '2026-09-18T13:00:00Z');
    expect(ids(scanNdjsonSince(text, MARKER, '2026-09-18T11:00:00Z', parse))).toEqual([2]);
  });

  it('returns an empty list for empty input', () => {
    expect(scanNdjsonSince('', MARKER, null, parse)).toEqual([]);
  });
});
