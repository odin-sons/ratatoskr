// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { makeEvent } from '../testing/fakes.ts';
import { isWatchlistHit, matchesFilter } from './filter.ts';

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
