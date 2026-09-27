// SPDX-License-Identifier: AGPL-3.0-or-later
import { eventId } from '../../core/ids.ts';
import type { DiscordMessage, EventKind, ModEvent, StoreKind } from '../../core/types.ts';
import { PROJECT_FIELD } from '../layout.ts';

export const NOW = new Date('2026-09-19T12:00:00Z');
export const STORE_KINDS: StoreKind[] = ['thunderstore', 'hexium', 'nexus'];

export interface EventSeed {
  store: StoreKind;
  kind: EventKind;
  name: string;
  owner: string;
  url: string;
  versionFrom: string | null;
  versionTo: string;
  sizeBytes: number | null;
  description: string | null;
  changelog: string | null;
  changelogUrl: string | null;
  alsoOn: { store: StoreKind; url: string }[];
  downloadUrl: string | null;
  downloads: number | null;
  likes: number | null;
  websiteUrl: string | null;
  iconUrl: string | null;
  categories: string[];
  updatedAt: string;
  createdAt: string;
}

export function makeEvent(seed: Partial<EventSeed> = {}, index = 0): ModEvent {
  const s: EventSeed = {
    store: 'thunderstore',
    kind: 'update',
    name: `Mod${index}`,
    owner: `Author${index % 20}`,
    url: `https://thunderstore.io/c/valheim/p/Author${index % 20}/Mod${index}/`,
    versionFrom: '1.2.3',
    versionTo: '1.2.4',
    sizeBytes: 2_516_582,
    description: null,
    changelog: null,
    changelogUrl: null,
    alsoOn: [],
    downloadUrl: null,
    downloads: null,
    likes: null,
    websiteUrl: null,
    iconUrl: 'https://gcdn.thunderstore.io/live/repository/icons/x.png',
    categories: [],
    updatedAt: '2026-09-19T11:30:00Z',
    createdAt: '2026-09-19T11:30:00Z',
    ...seed,
  };
  const packageId = `${s.owner}-${s.name}-${index}`;
  return {
    id: eventId(`${s.store}:valheim`, packageId, s.versionTo),
    kind: s.kind,
    versionFrom: s.versionFrom,
    versionTo: s.versionTo,
    changelog: s.changelog,
    changelogUrl: s.changelogUrl,
    createdAt: s.createdAt,
    alsoOn: s.alsoOn,
    pkg: {
      source: `${s.store}:valheim`,
      store: s.store,
      packageId,
      owner: s.owner,
      name: s.name,
      version: s.versionTo,
      url: s.url,
      iconUrl: s.iconUrl,
      description: s.description,
      categories: s.categories,
      isNsfw: false,
      isDeprecated: false,
      updatedAt: s.updatedAt,
      sizeBytes: s.sizeBytes,
      downloadUrl: s.downloadUrl,
      downloads: s.downloads,
      likes: s.likes,
      websiteUrl: s.websiteUrl,
    },
  };
}

export function realisticUpdates(n: number, store: StoreKind = 'thunderstore'): ModEvent[] {
  return Array.from({ length: n }, (_, i) =>
    makeEvent({ store, name: `Valheim Mod Name ${i}`, versionTo: `2.${i % 10}.${i % 7}`, versionFrom: `2.${i % 10}.${(i % 7) + 1}` }, i),
  );
}

/** True when the last embed of the message ends with the project field. */
export function endsWithProjectField(msg: DiscordMessage): boolean {
  const fields = msg.embeds?.at(-1)?.fields;
  const last = fields?.at(-1);
  return last !== undefined && last.name === PROJECT_FIELD.name && last.value === PROJECT_FIELD.value && last.inline !== true;
}

export function unixSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}
