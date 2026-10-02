// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { AppConfig, SourceConfig } from '../core/types.ts';
import { HexiumAdapter } from './hexium.ts';
import { adapterFor, createAdapters } from './index.ts';
import { NexusAdapter } from './nexus.ts';
import { ThunderstoreAdapter } from './thunderstore.ts';

const store = { getAllKnownVersions: async () => new Map<string, string>(), getKnownVersions: async () => new Map<string, string>() };

const sources: SourceConfig[] = [
  { id: 'thunderstore:valheim', store: 'thunderstore', community: 'valheim', enabled: true },
  { id: 'hexium:valheim', store: 'hexium', community: 'valheim', enabled: true },
  { id: 'nexus:valheim', store: 'nexus', community: 'valheim', enabled: false },
];

describe('adapter factory', () => {
  it('picks the adapter class by store kind', () => {
    expect(adapterFor(store, sources[0]!)).toBeInstanceOf(ThunderstoreAdapter);
    expect(adapterFor(store, sources[1]!)).toBeInstanceOf(HexiumAdapter);
    expect(adapterFor(store, sources[2]!)).toBeInstanceOf(NexusAdapter);
  });

  it('creates adapters for enabled sources only', () => {
    const config: AppConfig = { sources, userAgent: 'ua' };
    expect(createAdapters(config, store).map((a) => a.config.id)).toEqual(['thunderstore:valheim', 'hexium:valheim']);
  });

  it('exposes reconcile only for Hexium', () => {
    const [ts, hx, nx] = sources.map((s) => adapterFor(store, s));
    expect(ts?.reconcile).toBeUndefined();
    expect(hx?.reconcile).toBeTypeOf('function');
    expect(nx?.reconcile).toBeUndefined();
  });
});
