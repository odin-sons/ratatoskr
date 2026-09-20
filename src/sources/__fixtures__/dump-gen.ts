// SPDX-License-Identifier: AGPL-3.0-or-later

export interface GenRecord {
  n: number;
  updated?: string;
  versions?: number;
  nsfw?: string;
  deprecated?: string;
  updatedField?: string;
  versionOrder?: 'newest-first' | 'oldest-first' | 'shuffled';
  /** Every version item ends with an array value instead of `file_size`. */
  arrayTail?: 'values' | 'empty';
  /** Multiplies the description length of every version item. */
  descriptionScale?: number;
}

const DEPENDENCIES = '"dependencies":["denikson-BepInExPack_Valheim-5.4.2350","ValheimModding-Jotunn-2.28.0","Foo-Bar-1.2.3","Baz-Qux-0.0.1"]';
const DESCRIPTION = 'Adds decoration building pieces. Paintings, statues, trophies and more for every biome you can find. '.repeat(4);

export function stampFor(n: number, minutes = 0): string {
  return new Date(Date.UTC(2026, 0, 1) + n * 60_000 + minutes * 60_000).toISOString().replace('Z', '000Z');
}

export function versionItem(n: number, i: number, created: string, arrayTail?: 'values' | 'empty', descriptionScale = 1): string {
  const parts = [
    `"name":"P${n}"`,
    `"full_name":"Owner${n}-P${n}-1.0.${i}"`,
    `"description":"${DESCRIPTION.repeat(descriptionScale)}"`,
    `"icon":"https://cdn.hexium.gg/upload/${n}/icon.png"`,
    `"version_number":"1.0.${i}"`,
    DEPENDENCIES,
    '"suggestions":[]',
    `"download_url":"https://cdn.hexium.gg/upload/${n}/1.0.${i}.zip"`,
    `"downloads":${i * 7}`,
    `"date_created":"${created}"`,
    '"website_url":"https://example.invalid/site"',
    '"is_active":true',
    `"uuid4":"${(n * 100 + i).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000"`,
    `"file_size":${218_650 + i}`,
  ];
  if (arrayTail !== undefined) parts.push(`"tags":${arrayTail === 'empty' ? '[]' : '["a","b"]'}`);
  return `{${parts.join(',')}}`;
}

export function record(spec: GenRecord): string {
  const { n } = spec;
  const count = spec.versions ?? 1 + (n % 6);
  const updated = spec.updated ?? stampFor(n);
  const items: string[] = [];
  for (let i = 0; i < count; i += 1) items.push(versionItem(n, i, stampFor(n, -(count - 1 - i)), spec.arrayTail, spec.descriptionScale));
  const order = spec.versionOrder ?? 'newest-first';
  if (order === 'newest-first') items.reverse();
  else if (order === 'shuffled') items.splice(Math.floor(items.length / 2), 0, ...items.splice(0, 1));
  const updatedValue = spec.updatedField ?? `"${updated}"`;
  return (
    `{"name":"P${n}","full_name":"Owner${n}-P${n}","owner":"Owner${n}",` +
    `"package_url":"https://valheim.hexium.gg/mods/Owner${n}/P${n}","donation_link":null,` +
    `"date_created":"2026-01-01T00:00:00.000000Z","date_updated":${updatedValue},` +
    `"uuid4":"${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000","rating_score":0,"is_pinned":false,` +
    `"is_deprecated":${spec.deprecated ?? 'false'},"has_nsfw_content":${spec.nsfw ?? 'false'},` +
    `"categories":["Comfort","Pieces","Client & Server"],"versions":[${items.join(',')}]}`
  );
}

/** Compact array of `count` records, about 4.4 MB at 1112 records. */
export function dump(count = 1112, over: (n: number) => Partial<GenRecord> = () => ({})): string {
  const out: string[] = [];
  for (let n = 1; n <= count; n += 1) out.push(record({ n, ...over(n) }));
  return `[${out.join(',')}]`;
}
