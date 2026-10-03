// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CADENCE, DEGRADATION } from '../core/constants.ts';
import { createFakeFetch, fixture, makeCtx, makeState, text } from './__fixtures__/fake-fetch.ts';
import { syntheticIndex } from './__fixtures__/index-gen.ts';
import { HexiumAdapter } from './hexium.ts';

const ORIGIN = 'https://valheim.hexium.gg';
const LISTING = `${ORIGIN}/api/experimental/frontend/packages/?page=1`;
const INDEX = `${ORIGIN}/api/experimental/package-index/`;
const config = { id: 'hexium:valheim', store: 'hexium' as const, community: 'valheim', enabled: true };
const state = makeState({ cursor: null, etag: '"h1"' });
const EVERY = CADENCE.hexiumIndexEveryNthTick;

async function poll(tickIndex: number, degradation?: number) {
  const fake = createFakeFetch([
    [LISTING, () => text(fixture('hexium-listing.json'))],
    [INDEX, () => text(syntheticIndex(3))],
  ]);
  const adapter = new HexiumAdapter(config, { getAllKnownVersions: async () => new Map(), getKnownVersions: async () => new Map() });
  const res = await adapter.poll(makeCtx(fake, { tickIndex, state, ...(degradation === undefined ? {} : { degradation }) }));
  return { res, indexReads: fake.callsTo(INDEX).length, listingReads: fake.callsTo(LISTING).length };
}

/** The ticks among the first `count` multiples of the normal cadence on which the index is read. */
async function scanTicks(degradation: number | undefined, count = 6): Promise<number[]> {
  const scanned: number[] = [];
  for (let k = 1; k <= count * EVERY; k += 1) if ((await poll(k, degradation)).indexReads > 0) scanned.push(k);
  return scanned;
}

describe('HexiumAdapter: the index scan under D1 usage degradation', () => {
  it('scans every third tick with no degradation, or with step 1 (which only pauses extras)', async () => {
    const normal = [3, 6, 9, 12, 15, 18];
    expect(await scanTicks(undefined)).toEqual(normal);
    expect(await scanTicks(0)).toEqual(normal);
    expect(await scanTicks(DEGRADATION.pauseExtrasFrom)).toEqual(normal);
  });

  it('scans half as often from step 2', async () => {
    expect(await scanTicks(DEGRADATION.rarerScanFrom)).toEqual([6, 12, 18]);
  });

  it('does not scan at all from step 3, and still reads the listing every tick', async () => {
    expect(await scanTicks(DEGRADATION.pauseScanFrom)).toEqual([]);
    const { res, listingReads } = await poll(3, DEGRADATION.pauseScanFrom);
    expect(listingReads).toBe(1);
    expect(res.status).toBe('ok');
  });

  it('keeps the listing result and reports no index limit usage on a tick whose scan is paused', async () => {
    const { res } = await poll(6, DEGRADATION.pauseScanFrom);
    expect(res.status === 'ok' && res.capUsage).toBeFalsy();
    expect(res.status === 'ok' && res.packages.length).toBeGreaterThan(0);
  });
});
