// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SourceAdapter, Store } from '../core/ports.ts';
import type { AppConfig, SourceConfig } from '../core/types.ts';
import { HexiumAdapter } from './hexium.ts';
import { NexusAdapter } from './nexus.ts';
import { ThunderstoreAdapter } from './thunderstore.ts';

export function adapterFor(store: Pick<Store, 'getAllKnownVersions' | 'getKnownVersions'>, source: SourceConfig): SourceAdapter {
  switch (source.store) {
    case 'thunderstore':
      return new ThunderstoreAdapter(source);
    case 'hexium':
      return new HexiumAdapter(source, store);
    case 'nexus':
      return new NexusAdapter(source);
  }
}

/** Adapters for enabled sources only. */
export function createAdapters(config: AppConfig, store: Pick<Store, 'getAllKnownVersions' | 'getKnownVersions'>): SourceAdapter[] {
  return config.sources.filter((s) => s.enabled).map((s) => adapterFor(store, s));
}

export { HexiumAdapter } from './hexium.ts';
export { NexusAdapter } from './nexus.ts';
export { ThunderstoreAdapter } from './thunderstore.ts';
