// SPDX-License-Identifier: AGPL-3.0-or-later

const LONG_DEPENDENCIES = `[${Array.from({ length: 60 }, (_, i) => `"Author${i}-Dependency${i}-1.${i}.0"`).join(',')}]`;

/** Dependency lists cycled through the generated lines; every 50th is as long as the longest real line (about 5 KB). */
const DEPENDENCY_SETS = [
  '[]',
  '["denikson-BepInExPack_Valheim-5.4.2351"]',
  '["denikson-BepInExPack_Valheim-5.4.2351","ValheimModding-Jotunn-2.30.1","RandyKnapp-EpicLoot-0.12.8"]',
  '["denikson-BepInExPack_Valheim-5.4.2351","ValheimModding-Jotunn-2.30.1","RandyKnapp-EpicLoot-0.12.8","Smoothbrain-Building-1.2.7","Azumatt-AzuAntiCheat-6.2.0"]',
];

export function indexLine(n: number, version = '1.0.0'): string {
  const deps = n % 50 === 0 ? LONG_DEPENDENCIES : DEPENDENCY_SETS[n % DEPENDENCY_SETS.length]!;
  return `{"namespace":"Owner${n}","name":"Package${n}","version_number":"${version}","file_format":"zip","file_size":${100_000 + n},"dependencies":${deps},"suggestions":[]}`;
}

/** NDJSON shaped like the live package index (about 300 bytes per line): `count` packages, no trailing newline. */
export function syntheticIndex(count: number, versionOf: (n: number) => string = () => '1.0.0'): string {
  const lines: string[] = [];
  for (let n = 1; n <= count; n += 1) lines.push(indexLine(n, versionOf(n)));
  return lines.join('\n');
}
