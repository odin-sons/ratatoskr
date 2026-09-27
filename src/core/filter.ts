// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EventKind, ModEvent, PackageSnapshot, SubscriptionFilter } from './types.ts';

export interface CompiledFilter {
  matches(event: ModEvent): boolean;
  isWatchlistHit(event: ModEvent): boolean;
}

function lowerSet(values: string[] | undefined): Set<string> | null {
  return values !== undefined && values.length > 0 ? new Set(values.map((v) => v.toLowerCase())) : null;
}

interface PackageKeys {
  pkg: PackageSnapshot;
  rawId: string;
  rawOwner: string;
  rawName: string;
  id: string;
  ownerName: string;
  owner: string;
}

let lastKeys: PackageKeys | null = null;

/** Lowercased match keys of a package, computed once per package object however many subscriptions ask. */
function keysOf(pkg: PackageSnapshot): PackageKeys {
  const cached = lastKeys;
  if (cached !== null && cached.pkg === pkg && cached.rawId === pkg.packageId && cached.rawOwner === pkg.owner && cached.rawName === pkg.name) {
    return cached;
  }
  return (lastKeys = {
    pkg,
    rawId: pkg.packageId,
    rawOwner: pkg.owner,
    rawName: pkg.name,
    id: pkg.packageId.toLowerCase(),
    ownerName: `${pkg.owner}-${pkg.name}`.toLowerCase(),
    owner: pkg.owner.toLowerCase(),
  });
}

function packageMatcher(values: string[] | undefined): ((pkg: PackageSnapshot) => boolean) | null {
  const set = lowerSet(values);
  if (set === null) return null;
  return (pkg) => {
    const keys = keysOf(pkg);
    return set.has(keys.id) || set.has(keys.ownerName) || set.has(keys.owner);
  };
}

/** Precomputes lookup sets once so per-event checks stay O(categories). */
export function compileFilter(filter: SubscriptionFilter): CompiledFilter {
  const sources = filter.sources !== undefined && filter.sources.length > 0 ? new Set(filter.sources) : null;
  const kinds = filter.kinds !== undefined && filter.kinds.length > 0 ? new Set(filter.kinds) : null;
  const include = lowerSet(filter.includeCategories);
  const exclude = lowerSet(filter.excludeCategories);
  const watchlist = packageMatcher(filter.watchlist);
  const allowed = packageMatcher(filter.packages);
  const excluded = packageMatcher(filter.excludePackages);
  const allowNsfw = filter.allowNsfw === true;

  return {
    matches(event) {
      const pkg = event.pkg;
      if (pkg.isNsfw && !allowNsfw) return false;
      if (sources !== null && !sources.has(pkg.source)) return false;
      if (kinds !== null && !kinds.has(event.kind)) return false;
      if (event.kind === 'update' && pkg.isDeprecated) return false;
      if (excluded !== null && excluded(pkg)) return false;
      if (allowed !== null && !allowed(pkg)) return false;
      if (include !== null || exclude !== null) {
        let included = include === null;
        for (const category of pkg.categories) {
          const c = category.toLowerCase();
          if (exclude !== null && exclude.has(c)) return false;
          if (include !== null && include.has(c)) included = true;
        }
        if (!included) return false;
      }
      return true;
    },
    isWatchlistHit(event) {
      return watchlist !== null && watchlist(event.pkg);
    },
  };
}

export function matchesFilter(filter: SubscriptionFilter, event: ModEvent): boolean {
  return compileFilter(filter).matches(event);
}

export function isWatchlistHit(filter: SubscriptionFilter, event: ModEvent): boolean {
  return compileFilter(filter).isWatchlistHit(event);
}

const EVENT_KINDS: readonly string[] = ['new', 'update'] satisfies EventKind[];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

const STRING_LIST_KEYS = ['sources', 'watchlist', 'packages', 'excludePackages', 'includeCategories', 'excludeCategories'] as const;
const BOOLEAN_KEYS = ['allowNsfw', 'dedupAcrossStores', 'includeChangelog'] as const;

/** Narrows untrusted (stored) JSON to a filter; `null` when any known key has the wrong type. Unknown keys are dropped. */
export function parseFilter(value: unknown): SubscriptionFilter | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const filter: SubscriptionFilter = {};
  for (const key of STRING_LIST_KEYS) {
    const v = input[key];
    if (v === undefined) continue;
    if (!isStringArray(v)) return null;
    filter[key] = v;
  }
  for (const key of BOOLEAN_KEYS) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return null;
    filter[key] = v;
  }
  const kinds = input.kinds;
  if (kinds !== undefined) {
    if (!isStringArray(kinds) || !kinds.every((k) => EVENT_KINDS.includes(k))) return null;
    filter.kinds = kinds as EventKind[];
  }
  return filter;
}
