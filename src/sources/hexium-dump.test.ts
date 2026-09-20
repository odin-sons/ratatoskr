// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fixture } from './__fixtures__/fake-fetch.ts';
import { scanPackageDump, type DumpRecord } from './hexium-dump.ts';

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
      fn();
      const start = performance.now();
      const runs = 5;
      let n = 0;
      for (let i = 0; i < runs; i += 1) n = fn();
      const ms = (performance.now() - start) / runs;
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
    for (const ms of [full, lean, cursor, slice]) expect(ms).toBeLessThan(80);
  });
});
