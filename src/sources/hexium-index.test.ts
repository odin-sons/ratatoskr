// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { bestOf } from '../testing/timing.ts';
import { indexLine, syntheticIndex } from './__fixtures__/index-gen.ts';
import { fixture } from './__fixtures__/fake-fetch.ts';
import { HEXIUM_INDEX_MAX_BYTES, HEXIUM_INDEX_MAX_ITERATIONS, HEXIUM_INDEX_MAX_LINES, HEXIUM_INDEX_MAX_LINE_BYTES } from './budget.ts';
import { scanPackageIndex, seedSliceOf, type IndexEntry } from './hexium-index.ts';

const real = fixture('hexium-package-index.ndjson');

function scan(text: string): { entries: IndexEntry[]; lines: number; failed: number; truncated: boolean } {
  const entries: IndexEntry[] = [];
  const result = scanPackageIndex(text, (e) => entries.push(e));
  return { entries, ...result };
}

describe('scanPackageIndex — live shape', () => {
  it('reads namespace, name, version and size from every line of a real index sample', () => {
    const { entries, lines, failed } = scan(real);
    expect(lines).toBe(12);
    expect(failed).toBe(0);
    expect(entries).toHaveLength(12);
    expect(entries[0]).toEqual({ namespace: 'denikson', name: 'BepInExPack_Valheim', version: '5.4.2351', sizeBytes: 702924 });
    expect(entries.find((e) => e.name === 'DarkWoodFurnitures')).toEqual({ namespace: 'blacks7ar', name: 'DarkWoodFurnitures', version: '1.0.3', sizeBytes: 3220597 });
  });

  it('agrees with a full JSON parse of every line', () => {
    const expected = real.split('\n').map((line) => {
      const o = JSON.parse(line) as { namespace: string; name: string; version_number: string; file_size: number };
      return { namespace: o.namespace, name: o.name, version: o.version_number, sizeBytes: o.file_size };
    });
    expect(scan(real).entries).toEqual(expected);
  });

  it('gives an empty body no lines and no failures', () => {
    expect(scan('')).toMatchObject({ entries: [], lines: 0, failed: 0, truncated: false });
  });
});

describe('scanPackageIndex — reformatted bodies', () => {
  const baseline = scan(real).entries;

  it('reads CRLF line endings, blank lines and a trailing newline the same way', () => {
    const lines = real.split('\n');
    expect(scan(`${lines.join('\r\n')}\r\n`).entries).toEqual(baseline);
    expect(scan(`\n\n${lines.join('\n\n')}\n\n\n`).entries).toEqual(baseline);
    expect(scan(lines.join('\n')).entries).toEqual(baseline);
  });

  it('does not count blank lines as lines', () => {
    expect(scan(`\n${indexLine(1)}\n\n\r\n${indexLine(2)}\n`)).toMatchObject({ lines: 2, failed: 0 });
  });

  it('reads a line without file_size with an unknown size', () => {
    const line = '{"namespace":"a","name":"b","version_number":"1.0.0","file_format":"zip","dependencies":[]}';
    expect(scan(line).entries).toEqual([{ namespace: 'a', name: 'b', version: '1.0.0', sizeBytes: null }]);
  });

  it('ignores a file_size that is not a plain integer', () => {
    for (const size of ['"12"', '-5', '1e3', '1.5', 'null', '99999999999999999999']) {
      const line = `{"namespace":"a","name":"b","version_number":"1.0.0","file_size":${size},"dependencies":[]}`;
      expect(scan(line).entries[0]?.sizeBytes, size).toBeNull();
    }
  });
});

describe('scanPackageIndex — hostile input fails soft', () => {
  it('skips and counts lines that are not the expected object, keeping the readable ones', () => {
    const bad = [
      'not json',
      '{"namespace":"a","name":"b"',
      '{"name":"b","namespace":"a","version_number":"1.0.0"}',
      '{"namespace":"a","name":"b","version_number":""}',
      '{"namespace":"","name":"b","version_number":"1.0.0"}',
      '{"namespace":"a\\u0041","name":"b","version_number":"1.0.0"}',
      '{"namespace":"a","name":"b\\"c","version_number":"1.0.0"}',
      '{"namespace":"a","name":"b","version_number":"1.0.\\n0"}',
      '{"namespace":"a","name":"b","version_number":1}',
      '[{"namespace":"a","name":"b","version_number":"1.0.0"}]',
      '<html>maintenance</html>',
    ];
    const { entries, lines, failed } = scan([indexLine(1), ...bad, indexLine(2)].join('\n'));
    expect(entries.map((e) => e.namespace)).toEqual(['Owner1', 'Owner2']);
    expect(lines).toBe(2 + bad.length);
    expect(failed).toBe(bad.length);
  });

  it.each([
    ['a path traversal name', '..', 'b'],
    ['a dot namespace', '.', 'b'],
    ['a slash', 'a/b', 'c'],
    ['a query character', 'a', 'b?x=1'],
    ['a space', 'a b', 'c'],
    ['a non-ASCII name', 'a', 'bé'],
    ['an over-long name', 'a', 'x'.repeat(129)],
  ])('rejects %s so a lookup URL can never leave its path', (_label, namespace, name) => {
    const line = `{"namespace":"${namespace}","name":"${name}","version_number":"1.0.0","file_size":1}`;
    expect(scan(line)).toMatchObject({ entries: [], failed: 1 });
  });

  it('rejects an over-long version and control characters', () => {
    expect(scan(`{"namespace":"a","name":"b","version_number":"${'1'.repeat(65)}"}`).failed).toBe(1);
    expect(scan('{"namespace":"a","name":"b","version_number":"1.0\u0001"}').failed).toBe(1);
  });

  it('refuses a line above the line cap without reading it, and keeps reading after it', () => {
    const huge = `{"namespace":"a","name":"b","version_number":"1.0.0","dependencies":["${'x'.repeat(HEXIUM_INDEX_MAX_LINE_BYTES)}"]}`;
    const { entries, failed } = scan([indexLine(1), huge, indexLine(2)].join('\n'));
    expect(entries.map((e) => e.namespace)).toEqual(['Owner1', 'Owner2']);
    expect(failed).toBe(1);
  });

  it('treats a JSON array body as one unreadable line', () => {
    const body = JSON.stringify(real.split('\n').map((line) => JSON.parse(line) as unknown));
    expect(scan(body)).toMatchObject({ entries: [], lines: 1, failed: 1 });
  });

  it('stops at the line limit and reports truncation', () => {
    const { entries, truncated } = scan(syntheticIndex(HEXIUM_INDEX_MAX_LINES + 50));
    expect(truncated).toBe(true);
    expect(entries.length).toBeLessThanOrEqual(HEXIUM_INDEX_MAX_LINES);
  });

  it('does not truncate an index of exactly the line limit', () => {
    expect(scan(syntheticIndex(HEXIUM_INDEX_MAX_LINES))).toMatchObject({ lines: HEXIUM_INDEX_MAX_LINES, truncated: false });
  });

  it.each([
    ['newlines', '\n'],
    ['CRLF pairs', '\r\n'],
    ['blank-looking lines with a space', ' \n'],
  ])('refuses a maximum-size body of %s in a few milliseconds', (_label, unit) => {
    const body = unit.repeat(Math.floor(HEXIUM_INDEX_MAX_BYTES / unit.length));
    expect(scan(body).truncated).toBe(true);
    expect(bestOf(5, () => scan(body))).toBeLessThan(5);
  });

  it('accepts a full-size index with a blank line between every line', () => {
    const body = syntheticIndex(HEXIUM_INDEX_MAX_LINES).split('\n').join('\n\n');
    expect(scan(body)).toMatchObject({ lines: HEXIUM_INDEX_MAX_LINES, truncated: false });
  });

  it('bounds the total number of lines it visits, blank or not', () => {
    const blanks = '\n'.repeat(HEXIUM_INDEX_MAX_ITERATIONS + 10);
    expect(scan(`${indexLine(1)}\n${blanks}${indexLine(2)}`)).toMatchObject({ truncated: true });
  });

  it('keeps every index the line cap accepts inside the byte cap, at the live average line size', () => {
    expect(HEXIUM_INDEX_MAX_LINES * 400).toBeLessThan(HEXIUM_INDEX_MAX_BYTES);
    expect(syntheticIndex(HEXIUM_INDEX_MAX_LINES).length).toBeLessThan(HEXIUM_INDEX_MAX_BYTES);
  });

  it('stays linear on many unreadable lines that share a long unterminated prefix', () => {
    const line = `{"namespace":"${'a'.repeat(100)}`;
    const body = Array.from({ length: HEXIUM_INDEX_MAX_LINES }, () => line).join('\n');
    const small = bestOf(5, () => scan(body.slice(0, body.length / 4)));
    const full = bestOf(5, () => scan(body));
    expect(scan(body).failed).toBe(HEXIUM_INDEX_MAX_LINES);
    expect(full).toBeLessThan(Math.max(small * 16, 20));
  });
});

describe('scanPackageIndex — cost', () => {
  it('scans a 1318-line real-shaped index well inside the CPU budget', () => {
    const body = syntheticIndex(1318);
    let count = 0;
    const ms = bestOf(5, () => {
      count = 0;
      scanPackageIndex(body, () => {
        count += 1;
      });
    });
    expect(count).toBe(1318);
    expect(ms).toBeLessThan(10);
  });

  it('grows linearly with the number of lines', () => {
    const small = syntheticIndex(500);
    const large = syntheticIndex(HEXIUM_INDEX_MAX_LINES);
    const noop = () => {};
    const tSmall = bestOf(5, () => scanPackageIndex(small, noop));
    const tLarge = bestOf(5, () => scanPackageIndex(large, noop));
    expect(tLarge).toBeLessThan(Math.max(tSmall * 10 * 4, 30));
  });
});

describe('seedSliceOf', () => {
  it('is stable, in range and spreads a real index over every slice', () => {
    const counts = new Array<number>(8).fill(0);
    for (const e of scan(syntheticIndex(1318)).entries) {
      const slice = seedSliceOf(e.namespace, e.name, 8);
      expect(slice).toBe(seedSliceOf(e.namespace, e.name, 8));
      expect(slice).toBeGreaterThanOrEqual(0);
      expect(slice).toBeLessThan(8);
      counts[slice] = (counts[slice] ?? 0) + 1;
    }
    for (const c of counts) expect(c).toBeGreaterThan(1318 / 8 / 2);
  });

  it('depends on the namespace and the name', () => {
    const slices = new Set<number>();
    for (let i = 0; i < 50; i += 1) slices.add(seedSliceOf(`ns${i}`, 'same', 8));
    expect(slices.size).toBeGreaterThan(4);
    const names = new Set<number>();
    for (let i = 0; i < 50; i += 1) names.add(seedSliceOf('same', `n${i}`, 8));
    expect(names.size).toBeGreaterThan(4);
  });
});
