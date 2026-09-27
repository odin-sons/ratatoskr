// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { makeEvent } from '../testing/fakes.ts';
import { bestOf } from '../testing/timing.ts';
import { compileFilter, isWatchlistHit, matchesFilter, parseFilter } from './filter.ts';

describe('matchesFilter', () => {
  it('accepts everything by default', () => {
    expect(matchesFilter({}, makeEvent())).toBe(true);
    expect(matchesFilter({}, makeEvent({ kind: 'update', versionFrom: '0.9.0' }))).toBe(true);
  });

  it('excludes NSFW unless allowNsfw is exactly true', () => {
    const nsfw = makeEvent({ pkg: { isNsfw: true } });
    expect(matchesFilter({}, nsfw)).toBe(false);
    expect(matchesFilter({ allowNsfw: false }, nsfw)).toBe(false);
    expect(matchesFilter({ allowNsfw: 'true' as unknown as boolean }, nsfw)).toBe(false);
    expect(matchesFilter({ allowNsfw: true }, nsfw)).toBe(true);
  });

  it('restricts by source; empty list means all', () => {
    const ev = makeEvent({ pkg: { source: 'hexium:valheim' } });
    expect(matchesFilter({ sources: ['thunderstore:valheim'] }, ev)).toBe(false);
    expect(matchesFilter({ sources: ['hexium:valheim'] }, ev)).toBe(true);
    expect(matchesFilter({ sources: [] }, ev)).toBe(true);
  });

  it('restricts by kind; empty list means both', () => {
    const upd = makeEvent({ kind: 'update', versionFrom: '0.1.0' });
    expect(matchesFilter({ kinds: ['new'] }, upd)).toBe(false);
    expect(matchesFilter({ kinds: ['update'] }, upd)).toBe(true);
    expect(matchesFilter({ kinds: [] }, upd)).toBe(true);
  });

  it('applies include and exclude categories case-insensitively', () => {
    const ev = makeEvent({ pkg: { categories: ['Tweaks', 'Server-side'] } });
    expect(matchesFilter({ includeCategories: ['tweaks'] }, ev)).toBe(true);
    expect(matchesFilter({ includeCategories: ['Items'] }, ev)).toBe(false);
    expect(matchesFilter({ excludeCategories: ['SERVER-SIDE'] }, ev)).toBe(false);
    expect(matchesFilter({ includeCategories: ['tweaks'], excludeCategories: ['server-side'] }, ev)).toBe(false);
    expect(matchesFilter({ includeCategories: ['items'] }, makeEvent())).toBe(false);
  });

  it('skips deprecated updates but still reports deprecated new packages', () => {
    expect(matchesFilter({}, makeEvent({ kind: 'update', versionFrom: '0.1.0', pkg: { isDeprecated: true } }))).toBe(false);
    expect(matchesFilter({}, makeEvent({ kind: 'new', pkg: { isDeprecated: true } }))).toBe(true);
  });

  it('does not treat the watchlist as a restriction', () => {
    expect(matchesFilter({ watchlist: ['someone-else'] }, makeEvent())).toBe(true);
  });
});

describe('package allowlist and exclusion', () => {
  const ev = makeEvent({ pkg: { owner: 'Author', name: 'CoolMod', packageId: 'Author-CoolMod' } });

  it('delivers only matching packages when the allowlist is non-empty', () => {
    expect(matchesFilter({ packages: ['Author-CoolMod'] }, ev)).toBe(true);
    expect(matchesFilter({ packages: ['Other-Mod'] }, ev)).toBe(false);
    expect(matchesFilter({ packages: ['Other-Mod', 'Author-CoolMod'] }, ev)).toBe(true);
  });

  it('matches a bare owner name', () => {
    expect(matchesFilter({ packages: ['Author'] }, ev)).toBe(true);
    expect(matchesFilter({ packages: ['Other'] }, ev)).toBe(false);
  });

  it('is case-insensitive for ids and owners', () => {
    expect(matchesFilter({ packages: ['author-COOLMOD'] }, ev)).toBe(true);
    expect(matchesFilter({ packages: ['AUTHOR'] }, ev)).toBe(true);
    expect(matchesFilter({ excludePackages: ['author-coolmod'] }, ev)).toBe(false);
  });

  it('does not partial-match names or owners', () => {
    expect(matchesFilter({ packages: ['Auth'] }, ev)).toBe(false);
    expect(matchesFilter({ packages: ['Author-Cool'] }, ev)).toBe(false);
    expect(matchesFilter({ excludePackages: ['Auth'] }, ev)).toBe(true);
  });

  it('matches on the owner-name pair when packageId is a store-specific id', () => {
    const hex = makeEvent({ pkg: { owner: 'Author', name: 'CoolMod', packageId: 'hexium-4711' } });
    expect(matchesFilter({ packages: ['Author-CoolMod'] }, hex)).toBe(true);
    expect(matchesFilter({ packages: ['hexium-4711'] }, hex)).toBe(true);
  });

  it('excludePackages drops matching packages and keeps the rest', () => {
    expect(matchesFilter({ excludePackages: ['Author-CoolMod'] }, ev)).toBe(false);
    expect(matchesFilter({ excludePackages: ['Author'] }, ev)).toBe(false);
    expect(matchesFilter({ excludePackages: ['Other'] }, ev)).toBe(true);
  });

  it('exclusion wins over the allowlist, the watchlist and allowNsfw', () => {
    expect(matchesFilter({ packages: ['Author'], excludePackages: ['Author-CoolMod'] }, ev)).toBe(false);
    expect(matchesFilter({ packages: ['Author-CoolMod'], excludePackages: ['Author'] }, ev)).toBe(false);
    expect(matchesFilter({ watchlist: ['Author'], excludePackages: ['Author'] }, ev)).toBe(false);
    const nsfw = makeEvent({ pkg: { isNsfw: true, owner: 'Author', name: 'CoolMod', packageId: 'Author-CoolMod' } });
    expect(matchesFilter({ allowNsfw: true, excludePackages: ['Author'] }, nsfw)).toBe(false);
  });

  it('empty arrays impose no restriction', () => {
    expect(matchesFilter({ packages: [], excludePackages: [] }, ev)).toBe(true);
  });

  it('composes with the other restrictions', () => {
    const upd = makeEvent({ kind: 'update', versionFrom: '0.1.0', pkg: { owner: 'Author', name: 'CoolMod', packageId: 'Author-CoolMod' } });
    expect(matchesFilter({ packages: ['Author-CoolMod'], kinds: ['update'] }, upd)).toBe(true);
    expect(matchesFilter({ packages: ['Author-CoolMod'], kinds: ['new'] }, upd)).toBe(false);
    expect(matchesFilter({ packages: ['Author-CoolMod'], sources: ['hexium:valheim'] }, upd)).toBe(false);
    expect(matchesFilter({ packages: ['Author-CoolMod'] }, makeEvent({ pkg: { owner: 'Author', name: 'CoolMod', packageId: 'Author-CoolMod', isNsfw: true } }))).toBe(false);
  });

  it('the watchlist still only highlights and never restricts', () => {
    expect(matchesFilter({ watchlist: ['Someone'] }, ev)).toBe(true);
    expect(isWatchlistHit({ watchlist: ['Someone'] }, ev)).toBe(false);
    expect(isWatchlistHit({ packages: ['Author'] }, ev)).toBe(false);
  });

  it('a compiled filter answers repeatedly and for different packages', () => {
    const compiled = compileFilter({ packages: ['Author'], excludePackages: ['Author-Bad'] });
    const bad = makeEvent({ pkg: { owner: 'Author', name: 'Bad', packageId: 'Author-Bad' } });
    const other = makeEvent({ pkg: { owner: 'Zed', name: 'Mod', packageId: 'Zed-Mod' } });
    for (let i = 0; i < 3; i += 1) {
      expect(compiled.matches(ev)).toBe(true);
      expect(compiled.matches(bad)).toBe(false);
      expect(compiled.matches(other)).toBe(false);
    }
  });
});

describe('package key memo', () => {
  it('never serves stale keys when a package object is mutated in place', () => {
    const ev = makeEvent({ pkg: { owner: 'Author', name: 'CoolMod', packageId: 'Author-CoolMod' } });
    const filter = compileFilter({ excludePackages: ['Author-CoolMod'] });
    expect(filter.matches(ev)).toBe(false);
    ev.pkg.name = 'Renamed';
    ev.pkg.packageId = 'Author-Renamed';
    expect(filter.matches(ev)).toBe(true);
  });
});

describe('compiled filter cost', () => {
  const events = Array.from({ length: 200 }, (_, i) =>
    makeEvent({ pkg: { owner: `Owner${i}`, name: `Mod${i}`, packageId: `Owner${i}-Mod${i}`, categories: ['Tools', 'Items'] } }),
  );

  it.each([1, 10, 50])('%i subscriptions x 200 events stays far below the tick budget', (subs) => {
    const compiled = Array.from({ length: subs }, (_, i) =>
      compileFilter({ packages: [`Owner${i}`, `Owner${i + 100}-Mod${i + 100}`], excludePackages: ['Bad-Mod'], includeCategories: ['tools'] }),
    );
    const elapsed = bestOf(5, () => {
      for (const event of events) for (const filter of compiled) filter.matches(event);
    });
    expect(elapsed).toBeLessThan(5 + subs * 0.5);
  });
});

describe('isWatchlistHit', () => {
  const ev = makeEvent({ pkg: { owner: 'Author', name: 'CoolMod', packageId: 'Author-CoolMod' } });

  it('matches full package id or bare owner, case-insensitively', () => {
    expect(isWatchlistHit({ watchlist: ['author-coolmod'] }, ev)).toBe(true);
    expect(isWatchlistHit({ watchlist: ['AUTHOR'] }, ev)).toBe(true);
    expect(isWatchlistHit({ watchlist: ['Other'] }, ev)).toBe(false);
  });

  it('is false without a watchlist', () => {
    expect(isWatchlistHit({}, ev)).toBe(false);
    expect(isWatchlistHit({ watchlist: [] }, ev)).toBe(false);
  });

  it('does not partial-match names', () => {
    expect(isWatchlistHit({ watchlist: ['Auth'] }, ev)).toBe(false);
  });
});

describe('parseFilter', () => {
  it('accepts an empty object and every known key', () => {
    expect(parseFilter({})).toEqual({});
    const full = {
      sources: ['thunderstore:valheim'],
      kinds: ['new', 'update'],
      allowNsfw: true,
      watchlist: ['Star'],
      includeCategories: ['Tools'],
      excludeCategories: ['Misc'],
      dedupAcrossStores: false,
    };
    expect(parseFilter(full)).toEqual(full);
  });

  it('drops unknown keys', () => {
    expect(parseFilter({ allowNsfw: true, extra: 1 })).toEqual({ allowNsfw: true });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['a number', 1],
    ['sources that is not an array', { sources: 'thunderstore:valheim' }],
    ['sources with a non-string', { sources: [1] }],
    ['unknown kind', { kinds: ['new', 'delete'] }],
    ['allowNsfw as a string', { allowNsfw: 'true' }],
    ['allowNsfw as a number', { allowNsfw: 1 }],
    ['dedupAcrossStores as a string', { dedupAcrossStores: 'false' }],
    ['watchlist with a non-string', { watchlist: [null] }],
    ['excludeCategories that is an object', { excludeCategories: {} }],
    ['packages that is a string', { packages: 'Author-CoolMod' }],
    ['packages with a non-string', { packages: [1] }],
    ['excludePackages that is an object', { excludePackages: {} }],
    ['excludePackages with a null', { excludePackages: [null] }],
  ])('rejects %s', (_label, value) => {
    expect(parseFilter(value)).toBeNull();
  });
});
