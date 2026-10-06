// SPDX-License-Identifier: AGPL-3.0-or-later
import { ALSO_MATCH_MAX_RULES } from './constants.ts';
import type { EventKind, FilterRule, ModEvent, PackageSnapshot, SubscriptionFilter } from './types.ts';

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

function compileRule(rule: FilterRule): (pkg: PackageSnapshot) => boolean {
  const sources = rule.sources !== undefined && rule.sources.length > 0 ? new Set(rule.sources) : null;
  const include = lowerSet(rule.includeCategories);
  const allowed = packageMatcher(rule.packages);
  return (pkg) => {
    if (sources !== null && !sources.has(pkg.source)) return false;
    if (allowed !== null && !allowed(pkg)) return false;
    if (include !== null) {
      for (const category of pkg.categories) if (include.has(category.toLowerCase())) return true;
      return false;
    }
    return true;
  };
}

/** Precomputes lookup sets once so per-event checks stay O(categories x rules). */
export function compileFilter(filter: SubscriptionFilter): CompiledFilter {
  const kinds = filter.kinds !== undefined && filter.kinds.length > 0 ? new Set(filter.kinds) : null;
  const exclude = lowerSet(filter.excludeCategories);
  const watchlist = packageMatcher(filter.watchlist);
  const excluded = packageMatcher(filter.excludePackages);
  const allowNsfw = filter.allowNsfw === true;
  const base = compileRule(filter);
  const rules = (filter.alsoMatch ?? []).map(compileRule);

  return {
    matches(event) {
      const pkg = event.pkg;
      if (pkg.isNsfw && !allowNsfw) return false;
      if (kinds !== null && !kinds.has(event.kind)) return false;
      if (event.kind === 'update' && pkg.isDeprecated) return false;
      if (excluded !== null && excluded(pkg)) return false;
      if (exclude !== null) {
        for (const category of pkg.categories) if (exclude.has(category.toLowerCase())) return false;
      }
      if (base(pkg)) return true;
      for (const rule of rules) if (rule(pkg)) return true;
      return false;
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

/** True when the base rule restricts nothing, so a rule added to it would widen nothing. */
export function describeBaseAcceptsEverything(filter: SubscriptionFilter): boolean {
  return !(filter.sources?.length || filter.packages?.length || filter.includeCategories?.length);
}

const RULE_KEYS = ['sources', 'packages', 'includeCategories'] as const;

function isEmptyRule(rule: FilterRule): boolean {
  return RULE_KEYS.every((key) => !rule[key]?.length);
}

function sameRule(a: FilterRule, b: FilterRule): boolean {
  return RULE_KEYS.every((key) => {
    const left = (a[key] ?? []).map((v) => v.toLowerCase()).sort();
    const right = (b[key] ?? []).map((v) => v.toLowerCase()).sort();
    return left.length === right.length && left.every((v, i) => v === right[i]);
  });
}

/** A copy of `filter` with `rule` added; `null` when the rule is empty or the cap is reached. A rule already present is not added twice. */
export function addRule(filter: SubscriptionFilter, rule: FilterRule): SubscriptionFilter | null {
  if (isEmptyRule(rule)) return null;
  const rules = filter.alsoMatch ?? [];
  if (rules.some((existing) => sameRule(existing, rule))) return { ...filter, alsoMatch: [...rules] };
  if (rules.length >= ALSO_MATCH_MAX_RULES) return null;
  return { ...filter, alsoMatch: [...rules, rule] };
}

/** A copy of `filter` without the rule at `index`; `null` when there is none. The key goes with the last rule. */
export function removeRule(filter: SubscriptionFilter, index: number): SubscriptionFilter | null {
  const rules = filter.alsoMatch ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= rules.length) return null;
  const { alsoMatch: _removed, ...rest } = filter;
  const kept = rules.filter((_, i) => i !== index);
  return kept.length === 0 ? rest : { ...rest, alsoMatch: kept };
}

const STRING_LIST_KEYS = ['sources', 'watchlist', 'packages', 'excludePackages', 'includeCategories', 'excludeCategories'] as const;
const BOOLEAN_KEYS = ['allowNsfw', 'dedupAcrossStores', 'includeChangelog'] as const;

function parseRule(value: unknown): FilterRule | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const rule: FilterRule = {};
  for (const key of RULE_KEYS) {
    const v = input[key];
    if (v === undefined) continue;
    if (!isStringArray(v)) return null;
    rule[key] = v;
  }
  return isEmptyRule(rule) ? null : rule;
}

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
  const alsoMatch = input.alsoMatch;
  if (alsoMatch !== undefined) {
    if (!Array.isArray(alsoMatch) || alsoMatch.length > ALSO_MATCH_MAX_RULES) return null;
    const rules: FilterRule[] = [];
    for (const raw of alsoMatch) {
      const rule = parseRule(raw);
      if (rule === null) return null;
      rules.push(rule);
    }
    filter.alsoMatch = rules;
  }
  const kinds = input.kinds;
  if (kinds !== undefined) {
    if (!isStringArray(kinds) || !kinds.every((k) => EVENT_KINDS.includes(k))) return null;
    filter.kinds = kinds as EventKind[];
  }
  return filter;
}
