// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { dump, record, stampFor } from './__fixtures__/dump-gen.ts';
import { bestOf } from '../testing/timing.ts';
import { fixture } from './__fixtures__/fake-fetch.ts';
import { EARLY_ABORT_FAILURES, scanPackageDump, type DumpRecord } from './hexium-dump.ts';

interface Version {
  version_number: string;
  date_created: string;
  description: string;
  icon: string;
  file_size: number;
}

interface Truth {
  name: string;
  owner: string;
  full_name: string;
  uuid4: string;
  date_updated: string;
  is_deprecated: boolean;
  has_nsfw_content: boolean;
  categories: string[];
  versions: Version[];
}

const raw = fixture('hexium-v1-package.json');
const truth = JSON.parse(raw) as Truth[];
const key = (r: { owner: string; name: string }): string => `${r.owner}-${r.name}`;
const seq = (r: Truth): number => Number.parseInt(r.uuid4.slice(0, 8), 16);

function newest(r: Truth): Version {
  return [...r.versions].sort((a, b) => (a.date_created < b.date_created ? 1 : -1))[0]!;
}

function collect(text: string, cursor: string | null = null, options?: Parameters<typeof scanPackageDump>[3]): { records: DumpRecord[]; scan: ReturnType<typeof scanPackageDump> } {
  const records: DumpRecord[] = [];
  const scan = scanPackageDump(text, cursor, (r) => records.push(r), options);
  return { records, scan };
}

describe('scanPackageDump — full extraction', () => {
  it('matches a JSON.parse ground truth for every fixture record', () => {
    const { records, scan } = collect(raw);
    expect(scan).toMatchObject({ records: truth.length, failed: 0 });
    expect(records).toHaveLength(truth.length);
    const byId = new Map(records.map((r) => [key(r), r]));
    for (const t of truth) {
      const v = newest(t);
      expect(byId.get(t.full_name), t.full_name).toEqual({
        owner: t.owner,
        name: t.name,
        updatedAt: t.date_updated,
        isNsfw: t.has_nsfw_content,
        isDeprecated: t.is_deprecated,
        categories: t.categories,
        version: v.version_number,
        previousVersion: [...t.versions].sort((a, b) => (a.date_created < b.date_created ? 1 : -1))[1]?.version_number ?? null,
        description: v.description || null,
        iconUrl: v.icon || null,
        sizeBytes: v.file_size,
      });
    }
  });

  it('picks the newest version by date_created even when versions[] is oldest-first', () => {
    const odd = truth.find((t) => t.full_name === 'JamesJonesTV-RavenwoodRandomRelics')!;
    expect(odd.versions[0]!.version_number).not.toBe(newest(odd).version_number);
    const { records } = collect(raw);
    expect(records.find((r) => key(r) === odd.full_name)?.version).toBe(newest(odd).version_number);
  });

  it('reports the maximum date_updated over all records, whatever the cursor', () => {
    const max = truth.map((t) => t.date_updated).sort().at(-1)!;
    expect(collect(raw).scan.maxUpdated).toBe(max);
    expect(collect(raw, '2999-01-01T00:00:00Z').scan.maxUpdated).toBe(max);
  });

  it('decodes escapes, quotes and brackets inside strings', () => {
    const record = {
      name: 'Odd',
      full_name: 'Own-Odd',
      owner: 'Own',
      package_url: 'https://x.test/mods/Own/Odd',
      donation_link: null,
      date_created: '2026-01-01T00:00:00.000000Z',
      date_updated: '2026-01-01T00:00:00.000000Z',
      uuid4: '00000001-0000-4000-8000-000000000001',
      rating_score: 0,
      is_pinned: false,
      is_deprecated: false,
      has_nsfw_content: true,
      categories: ['[Beta]', 'Quotes "q"', 'Café'],
      versions: [
        {
          name: 'Odd',
          full_name: 'Own-Odd-1.0.0',
          description: 'He said "hi" \\ back }]} é \u{1F600}',
          icon: 'https://x.test/i.png',
          version_number: '1.0.0',
          dependencies: ['a-b-1.0.0'],
          suggestions: [],
          download_url: 'https://x.test/d.zip',
          downloads: 1,
          date_created: '2026-01-01T00:00:00.000000Z',
          website_url: '',
          is_active: true,
          uuid4: '00000001-0000-4000-8000-000000000002',
          file_size: 42,
        },
      ],
    };
    const { records } = collect(JSON.stringify([record]));
    expect(records).toEqual([
      {
        owner: 'Own',
        name: 'Odd',
        updatedAt: '2026-01-01T00:00:00.000000Z',
        isNsfw: true,
        isDeprecated: false,
        categories: ['[Beta]', 'Quotes "q"', 'Café'],
        version: '1.0.0',
        previousVersion: null,
        description: 'He said "hi" \\ back }]} é \u{1F600}',
        iconUrl: 'https://x.test/i.png',
        sizeBytes: 42,
      },
    ]);
  });

  it('reports NSFW exactly when the flag is true', () => {
    const marker = '"has_nsfw_content":false';
    const at = raw.indexOf(marker);
    const flipped = raw.slice(0, at) + '"has_nsfw_content":true' + raw.slice(at + marker.length);
    const nsfw = collect(flipped).records.filter((r) => r.isNsfw);
    expect(nsfw.map(key)).toEqual([truth[0]!.full_name]);
    expect(collect(raw).records.some((r) => r.isNsfw)).toBe(false);
  });

  it('reports deprecated packages', () => {
    const expected = truth.filter((t) => t.is_deprecated).map((t) => t.full_name).sort();
    expect(collect(raw).records.filter((r) => r.isDeprecated).map(key).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });
});

describe('scanPackageDump — filters', () => {
  it('cursor is inclusive and only extracts matched records', () => {
    const stamps = truth.map((t) => t.date_updated).sort();
    const cursor = stamps[6]!;
    const { records, scan } = collect(raw, cursor);
    expect(records.map(key).sort()).toEqual(truth.filter((t) => t.date_updated >= cursor).map((t) => t.full_name).sort());
    expect(scan.records).toBe(truth.length);
  });

  it('accepts a cursor in non-canonical ISO form', () => {
    const t = truth.find((x) => x.full_name === 'HackThePlanet-ThorsKist')!;
    const asOffset = t.date_updated.replace('.000000Z', '+00:00');
    expect(collect(raw, asOffset).records.map(key)).toContain(t.full_name);
  });

  it('slices partition the dump into disjoint parts that cover every record', () => {
    const parts = [0, 1, 2, 3].map((index) => collect(raw, null, { slice: { index, count: 4 } }).records.map(key));
    expect(parts.flat().sort()).toEqual(truth.map((t) => t.full_name).sort());
    expect(new Set(parts.flat()).size).toBe(truth.length);
    parts.forEach((names, index) => {
      expect(names.sort()).toEqual(truth.filter((t) => seq(t) % 4 === index).map((t) => t.full_name).sort());
    });
  });

  it('lean mode keeps flags and the first listed version but skips detail', () => {
    const { records } = collect(raw, null, { wantDetail: () => false });
    const t = truth.find((x) => x.full_name === 'JamesJonesTV-RavenwoodRandomRelics')!;
    const lean = records.find((r) => key(r) === t.full_name)!;
    expect(lean).toMatchObject({ version: t.versions[0]!.version_number, isDeprecated: true, description: null, iconUrl: null, sizeBytes: null, categories: [] });
    expect(records).toHaveLength(truth.length);
  });

  it('wantDetail selects full extraction per record from the lean version', () => {
    const wanted = 'aBlaze-Blaze';
    const { records } = collect(raw, null, { wantDetail: (o, n) => `${o}-${n}` === wanted });
    for (const r of records) {
      if (key(r) === wanted) expect(r.description).not.toBeNull();
      else expect(r.description).toBeNull();
    }
  });
});

describe('scanPackageDump — hostile input', () => {
  it('finds nothing in an empty, garbage or pretty-printed body', () => {
    expect(collect('').scan.records).toBe(0);
    expect(collect('<html>nope</html>').scan.records).toBe(0);
    expect(collect(JSON.stringify(truth, null, 2)).scan.records).toBe(0);
  });

  it('counts records it cannot read instead of throwing', () => {
    const broken = raw.replace(',"has_nsfw_content":', ',"nsfw":');
    const { records, scan } = collect(broken);
    expect(scan.failed).toBe(1);
    expect(records).toHaveLength(truth.length - 1);
  });

  it('survives a body truncated mid-record', () => {
    const cut = raw.slice(0, Math.floor(raw.length * 0.55));
    expect(() => collect(cut)).not.toThrow();
    expect(collect(cut).records.length).toBeGreaterThan(0);
  });

  it('ignores a date_updated marker that only appears inside an escaped string', () => {
    const record = JSON.parse(JSON.stringify(truth[0])) as Truth & { versions: Version[] };
    record.versions[0]!.description = 'fake \"date_updated\":\"2999-01-01T00:00:00.000000Z\"';
    const { scan } = collect(JSON.stringify([record]));
    expect(scan.records).toBe(1);
    expect(scan.maxUpdated).toBe(record.date_updated);
  });
});

describe('scanPackageDump — CPU cost (documented, loose bounds)', () => {
  function synthetic(count: number): string {
    const out: unknown[] = [];
    for (let i = 0; i < count; i += 1) {
      const t = JSON.parse(JSON.stringify(truth[i % truth.length])) as Truth & { package_url: string };
      t.name = `${t.name}${i}`;
      t.full_name = `${t.owner}-${t.name}`;
      t.uuid4 = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
      t.date_updated = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString().replace('Z', '000Z');
      for (const v of t.versions) v.date_created = t.date_updated;
      out.push(t);
    }
    return JSON.stringify(out);
  }

  it('extracts ~1100 records with full detail, lean, cursor-filtered and sliced', () => {
    const body = synthetic(1112);
    const time = (label: string, fn: () => number): number => {
      let n = 0;
      const ms = bestOf(5, () => {
        n = fn();
      });
      console.info(`[cpu-note] ${label}: ${ms.toFixed(2)} ms (${body.length} bytes, ${n} records, Node warm)`);
      return ms;
    };
    const last = new Date(Date.UTC(2026, 0, 1) + 1110 * 60_000).toISOString();
    const full = time('full', () => collect(body).records.length);
    const lean = time('lean', () => collect(body, null, { wantDetail: () => false }).records.length);
    const cursor = time('cursor', () => collect(body, last).records.length);
    const slice = time('lean slice 1/4', () => collect(body, null, { slice: { index: 1, count: 4 }, wantDetail: () => false }).records.length);
    expect(collect(body).records).toHaveLength(1112);
    expect(collect(body, last).records.length).toBeLessThanOrEqual(3);
    for (const ms of [full, lean, cursor, slice]) expect(ms).toBeLessThan(FULL_SCAN_MS);
  });
});

/** Best of five runs after a warm-up, so a load spike on a shared runner cannot fail a bound. */
function timed<T>(fn: () => T): { value: T; ms: number } {
  let value!: T;
  const ms = bestOf(5, () => {
    value = fn();
  });
  return { value, ms };
}

/** Measured best-of-9 on the 4.1 MB generated dump: 5.9 ms for a full scan of every record, at most 2.0 ms for the fail-fast cases. */
const FULL_SCAN_MS = 25;
const FAST_FAIL_MS = 10;

describe('scanPackageDump — bounded cost on reformatted payloads (real size)', () => {
  const big = dump();

  it('generates a payload of the real dump size', () => {
    expect(big.length).toBeGreaterThan(4_000_000);
    expect(collect(big).records).toHaveLength(1112);
  });

  const broken: Array<[string, (text: string) => string]> = [
    ['a renamed object start', (t) => t.replaceAll('{"name":"', '{"nam":"')],
    ['a missing versions marker', (t) => t.replaceAll(',"versions":[', ',"vers":[')],
    ['newlines between records', (t) => t.replaceAll('}]},{"name":"', '}]},\n{"name":"')],
    ['a pretty-printed body that keeps the date_updated marker', (t) => JSON.stringify(JSON.parse(t), null, 2).replaceAll('"date_updated": "', '"date_updated":"')],
  ];

  it.each(broken)('yields no records and no work blow-up for %s', (_label, mutate) => {
    const text = mutate(big);
    const { value, ms } = timed(() => collect(text));
    expect(value.records).toHaveLength(0);
    expect(value.scan.records === 0 || value.scan.failed > 0).toBe(true);
    expect(ms).toBeLessThan(FAST_FAIL_MS);
  });

  it('gives up after the first failures instead of extracting every record', () => {
    const text = big.replaceAll(',"versions":[', ',"vers":[');
    const { value, ms } = timed(() => collect(text));
    expect(value.scan.aborted).toBe(true);
    expect(value.scan.failed).toBeLessThanOrEqual(EARLY_ABORT_FAILURES);
    expect(ms).toBeLessThan(FAST_FAIL_MS);
  });

  it('fails full extraction fast when date_created markers are gone, lean extraction still works', () => {
    const text = big.replaceAll('"date_created":"', '"created":"');
    const full = timed(() => collect(text));
    expect(full.value.records).toHaveLength(0);
    expect(full.value.scan.aborted).toBe(true);
    expect(full.ms).toBeLessThan(FAST_FAIL_MS);
    const lean = timed(() => collect(text, null, { wantDetail: () => false }));
    expect(lean.value.records).toHaveLength(1112);
    expect(lean.ms).toBeLessThan(FAST_FAIL_MS);
  });

  it('reads records without file_size markers as size unknown, in linear time', () => {
    const text = big.replaceAll('"file_size":', '"size":');
    const { value, ms } = timed(() => collect(text));
    expect(value.records).toHaveLength(1112);
    expect(value.records.every((r) => r.sizeBytes === null)).toBe(true);
    expect(ms).toBeLessThan(FULL_SCAN_MS);
  });

  it.each([
    ['full', undefined],
    ['lean', () => false],
  ] as const)('does not report a mega-record as a readable record (%s), and rejects it fast', (_mode, wantDetail) => {
    const glued = big.replaceAll('}]},{"name":"', '}]}, {"name":"');
    const { value, ms } = timed(() => collect(glued, null, wantDetail === undefined ? undefined : { wantDetail }));
    expect(value.records).toHaveLength(0);
    expect(value.scan.failed).toBeGreaterThan(0);
    expect(ms).toBeLessThan(FAST_FAIL_MS);
  });
});

describe('scanPackageDump — record boundaries', () => {
  it.each(['values', 'empty'] as const)('does not cut a record where a version item ends with an array (%s)', (arrayTail) => {
    const { records, scan } = collect(dump(3, () => ({ versions: 4, arrayTail })));
    expect(scan).toMatchObject({ records: 3, failed: 0 });
    expect(records.map((r) => [r.name, r.version, r.previousVersion])).toEqual([
      ['P1', '1.0.3', '1.0.2'],
      ['P2', '1.0.3', '1.0.2'],
      ['P3', '1.0.3', '1.0.2'],
    ]);
  });

  it.each([
    ['full', undefined, '1.0.398'],
    ['lean', () => false, undefined],
  ] as const)('reads a 400-version record of real-size items in %s mode', (_mode, wantDetail, previousVersion) => {
    const text = dump(3, (n) => (n === 2 ? { versions: 400, descriptionScale: 10 } : {}));
    expect(text.length).toBeGreaterThan(1_500_000);
    const { records, scan } = collect(text, null, wantDetail === undefined ? undefined : { wantDetail });
    expect(scan).toMatchObject({ records: 3, failed: 0 });
    expect(records.map((r) => r.name)).toEqual(['P1', 'P2', 'P3']);
    expect(records[1]?.version).toBe('1.0.399');
    expect(records[1]?.previousVersion).toBe(previousVersion);
  });

  it('keeps the neighbours of a record with an empty versions[] intact', () => {
    const { records, scan } = collect(dump(4, (n) => (n === 2 ? { versions: 0 } : { versions: 2 })));
    expect(records.map((r) => [r.name, r.version, r.previousVersion])).toEqual([
      ['P1', '1.0.1', '1.0.0'],
      ['P3', '1.0.1', '1.0.0'],
      ['P4', '1.0.1', '1.0.0'],
    ]);
    expect(scan).toMatchObject({ records: 4, failed: 1 });
  });

  it('quarantines a last record that is cut short, and still reads the ones before it', () => {
    const text = dump(3);
    const cut = text.slice(0, text.lastIndexOf('"versions":[') + 400);
    const { records, scan } = collect(cut);
    expect(records.map((r) => r.name)).toEqual(['P1', 'P2']);
    expect(scan.failed).toBe(1);
  });

  it('reads the last record when the body ends with whitespace', () => {
    expect(collect(`${dump(3)}\n`).records.map((r) => r.name)).toEqual(['P1', 'P2', 'P3']);
  });

  it.each([
    ['full', undefined],
    ['lean', () => false],
  ] as const)('reports a body whose records lost their separators as one unreadable record (%s)', (_mode, wantDetail) => {
    const glued = dump(40).replaceAll('}]},{"name":"', '}]}, {"name":"');
    const { records, scan } = collect(glued, null, wantDetail === undefined ? undefined : { wantDetail });
    expect(records).toHaveLength(0);
    expect(scan.failed).toBeGreaterThan(0);
  });
});

describe('scanPackageDump — quarantine of unreadable records', () => {
  it('skips a record with an empty versions[] and keeps reading', () => {
    const { records, scan } = collect(dump(6, (n) => (n === 3 ? { versions: 0 } : {})));
    expect(records.map((r) => r.name)).toEqual(['P1', 'P2', 'P4', 'P5', 'P6']);
    expect(scan).toMatchObject({ records: 6, failed: 1, aborted: false });
    expect(scan.maxUpdated).toBe(stampFor(6));
  });

  it('does not let a record without a date_updated stamp corrupt its neighbour', () => {
    const { records, scan } = collect(dump(5, (n) => (n === 3 ? { updatedField: 'null' } : {})));
    expect(records.map((r) => r.name)).toEqual(['P1', 'P2', 'P4', 'P5']);
    expect(records.find((r) => r.name === 'P2')?.version).toBe('1.0.2');
    expect(records.find((r) => r.name === 'P4')?.version).toBe('1.0.4');
    expect(scan.failed).toBe(1);
  });

  it('quarantines lean records too', () => {
    const { records, scan } = collect(dump(4, (n) => (n === 2 ? { versions: 0 } : {})), null, { wantDetail: () => false });
    expect(records.map((r) => r.name)).toEqual(['P1', 'P3', 'P4']);
    expect(scan.failed).toBe(1);
  });

  it('never quarantines a record because a filter skipped it', () => {
    const { scan } = collect(dump(4, (n) => (n === 2 ? { versions: 0 } : {})), stampFor(3));
    expect(scan.failed).toBe(0);
  });
});

describe('scanPackageDump — fail-closed flags', () => {
  it.each([
    ['null', 'null'],
    ['a string', '"false"'],
    ['a number', '0'],
    ['an empty value', ''],
  ])('does not emit a record whose NSFW flag is %s', (_label, value) => {
    const { records, scan } = collect(dump(4, (n) => (n === 2 ? { nsfw: value } : {})));
    expect(records.map((r) => r.name)).toEqual(['P1', 'P3', 'P4']);
    expect(scan.failed).toBe(1);
  });

  it('does not emit a record whose NSFW flag key is missing', () => {
    const text = dump(3).replace(',"has_nsfw_content":false', '');
    const { records, scan } = collect(text);
    expect(records.map((r) => r.name)).toEqual(['P2', 'P3']);
    expect(scan.failed).toBe(1);
  });

  it.each([
    ['null', 'null'],
    ['a string', '"true"'],
    ['a number', '1'],
    ['an object', '{}'],
    ['an empty value', ''],
    ['a misspelt boolean', 'tru'],
    ['a boolean with a suffix', 'falsey'],
  ])('does not emit a record whose deprecated flag is %s', (_label, value) => {
    const { records, scan } = collect(dump(4, (n) => (n === 2 ? { deprecated: value } : {})));
    expect(records.map((r) => r.name)).toEqual(['P1', 'P3', 'P4']);
    expect(scan.failed).toBe(1);
  });

  it('does not emit a record whose deprecated flag key is missing', () => {
    const text = dump(3).replace('"is_deprecated":false,', '');
    const { records, scan } = collect(text);
    expect(records.map((r) => r.name)).toEqual(['P2', 'P3']);
    expect(scan.failed).toBe(1);
  });

  it('applies the same rule to a record that would only get the lean extraction', () => {
    const { records, scan } = collect(dump(3, (n) => (n === 2 ? { deprecated: 'null' } : {})), null, { wantDetail: () => false });
    expect(records.map((r) => r.name)).toEqual(['P1', 'P3']);
    expect(scan.failed).toBe(1);
  });

  it('keeps a deprecated record with a true flag', () => {
    const { records, scan } = collect(dump(2, (n) => (n === 2 ? { deprecated: 'true' } : {})));
    expect(records.map((r) => [r.name, r.isDeprecated])).toEqual([['P1', false], ['P2', true]]);
    expect(scan.failed).toBe(0);
  });
});

describe('scanPackageDump — timestamps', () => {
  it('treats a structurally invalid timestamp as an unreadable record that cannot move maxUpdated', () => {
    const bad = '"zzzzzzzzzzTzzzzzzzzzzzzzzzZ"';
    const { records, scan } = collect(dump(3, (n) => (n === 2 ? { updatedField: bad } : {})));
    expect(records.map((r) => r.name)).toEqual(['P1', 'P3']);
    expect(scan.failed).toBe(1);
    expect(scan.maxUpdated).toBe(stampFor(3));
  });

  it.each(['"2026-13-01T00:00:00.000000Z"', '"2026-01-01T25:00:00.000000Z"', '"2026-01-01T00:61:00.000000Z"'])('rejects the out-of-range stamp %s', (stamp) => {
    const { scan } = collect(dump(2, (n) => (n === 2 ? { updatedField: stamp } : {})));
    expect(scan.failed).toBe(1);
    expect(scan.maxUpdated).toBe(stampFor(1));
  });

  it('still visits a far-future record but keeps it out of maxUpdated when notAfter is given', () => {
    const future = '2999-01-01T00:00:00.000000Z';
    const text = dump(3, (n) => (n === 2 ? { updated: future } : {}));
    expect(collect(text).scan.maxUpdated).toBe(future);
    const capped = collect(text, null, { notAfter: '2030-01-01T00:00:00.000000Z' });
    expect(capped.scan.maxUpdated).toBe(stampFor(3));
    expect(capped.records).toHaveLength(3);
  });
});

describe('scanPackageDump — previousVersion', () => {
  const one = (n: number, over: Partial<Parameters<typeof record>[0]>): DumpRecord => collect(`[${record({ n, ...over })}]`).records[0]!;

  it('is null for a package with a single version', () => {
    expect(one(6, { versions: 1 })).toMatchObject({ version: '1.0.0', previousVersion: null });
  });

  it('is the second-newest version by date_created', () => {
    expect(one(3, { versions: 4 })).toMatchObject({ version: '1.0.3', previousVersion: '1.0.2' });
  });

  it.each(['oldest-first', 'shuffled'] as const)('does not depend on listing order (%s)', (versionOrder) => {
    expect(one(3, { versions: 5, versionOrder })).toMatchObject({ version: '1.0.4', previousVersion: '1.0.3' });
  });

  it('is left out of lean records, where the history is not read', () => {
    const [lean] = collect(`[${record({ n: 3, versions: 4 })}]`, null, { wantDetail: () => false }).records;
    expect(lean?.previousVersion).toBeUndefined();
  });

  it('agrees with a JSON.parse ground truth over the fixture', () => {
    for (const r of collect(raw).records) {
      const t = truth.find((x) => x.full_name === key(r))!;
      const ordered = [...t.versions].sort((a, b) => (a.date_created < b.date_created ? 1 : -1));
      expect(r.previousVersion, t.full_name).toBe(ordered[1]?.version_number ?? null);
    }
  });
});
