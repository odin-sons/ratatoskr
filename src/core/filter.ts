// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EventKind, ModEvent, SubscriptionFilter } from './types.ts';

export interface CompiledFilter {
  matches(event: ModEvent): boolean;
  isWatchlistHit(event: ModEvent): boolean;
}

function lowerSet(values: string[] | undefined): Set<string> | null {
  return values !== undefined && values.length > 0 ? new Set(values.map((v) => v.toLowerCase())) : null;
}

/** Precomputes lookup sets once so per-event checks stay O(categories). */
export function compileFilter(filter: SubscriptionFilter): CompiledFilter {
  const sources = filter.sources !== undefined && filter.sources.length > 0 ? new Set(filter.sources) : null;
  const kinds = filter.kinds !== undefined && filter.kinds.length > 0 ? new Set(filter.kinds) : null;
  const include = lowerSet(filter.includeCategories);
  const exclude = lowerSet(filter.excludeCategories);
  const watchlist = lowerSet(filter.watchlist);
  const allowNsfw = filter.allowNsfw === true;

  return {
    matches(event) {
      const pkg = event.pkg;
      if (pkg.isNsfw && !allowNsfw) return false;
      if (sources !== null && !sources.has(pkg.source)) return false;
      if (kinds !== null && !kinds.has(event.kind)) return false;
      if (event.kind === 'update' && pkg.isDeprecated) return false;
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
      if (watchlist === null) return false;
      const pkg = event.pkg;
      return (
        watchlist.has(pkg.packageId.toLowerCase()) ||
        watchlist.has(`${pkg.owner}-${pkg.name}`.toLowerCase()) ||
        watchlist.has(pkg.owner.toLowerCase())
      );
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

const STRING_LIST_KEYS = ['sources', 'watchlist', 'includeCategories', 'excludeCategories'] as const;
const BOOLEAN_KEYS = ['allowNsfw', 'dedupAcrossStores'] as const;

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
