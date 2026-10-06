// SPDX-License-Identifier: AGPL-3.0-or-later
import { ALSO_MATCH_MAX_RULES } from './constants.ts';
import type { DeliveryMode, EventKind, FilterRule, SubscriptionFilter } from './types.ts';

export const EVENT_KINDS: readonly EventKind[] = ['new', 'update'];
export const DELIVERY_MODES: readonly DeliveryMode[] = ['immediate', 'digest'];

/** Subscription ids end up in SQL and shell commands, so they stay in a plain-token alphabet. */
export const SUBSCRIPTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// eslint-disable-next-line no-control-regex -- rejects raw control bytes in a package-list entry
export const PACKAGE_ENTRY_RE = /^[^\s\x00-\x1f\x7f][^\x00-\x1f\x7f]{0,127}$/;
export const SNOWFLAKE_RE = /^\d{17,20}$/;

export const DIGEST_INTERVAL_MIN_BOUND = 5;
export const DIGEST_INTERVAL_MAX_BOUND = 1440;

const FILTER_KEYS = [
  'sources',
  'kinds',
  'allowNsfw',
  'watchlist',
  'packages',
  'excludePackages',
  'includeCategories',
  'excludeCategories',
  'dedupAcrossStores',
  'includeChangelog',
  'alsoMatch',
];

const RULE_KEYS = ['sources', 'packages', 'includeCategories'];
const SOURCE_ID_RE = /^[a-z]+:[a-z0-9][a-z0-9_-]*$/;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function unknownKeys(obj: Record<string, unknown>, allowed: string[], path: string): string[] {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${path}: unknown key "${k}"`);
}

export function isDigestInterval(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= DIGEST_INTERVAL_MIN_BOUND && v <= DIGEST_INTERVAL_MAX_BOUND;
}

function stringArray(v: unknown, path: string, errors: string[], pattern?: RegExp): string[] | undefined {
  if (!Array.isArray(v)) {
    errors.push(`${path}: must be an array of strings`);
    return undefined;
  }
  const out: string[] = [];
  v.forEach((item: unknown, i: number) => {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push(`${path}[${i}]: must be a non-empty string`);
    } else if (pattern && !pattern.test(item)) {
      errors.push(`${path}[${i}]: must match ${pattern.source}`);
    } else {
      out.push(item);
    }
  });
  return out;
}

function validateRule(raw: unknown, path: string, errors: string[]): FilterRule | undefined {
  if (!isRecord(raw)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  errors.push(...unknownKeys(raw, RULE_KEYS, path));
  const rule: FilterRule = {};
  if (raw.sources !== undefined) {
    const list = stringArray(raw.sources, `${path}.sources`, errors, SOURCE_ID_RE);
    if (list) rule.sources = list;
  }
  if (raw.packages !== undefined) {
    const list = stringArray(raw.packages, `${path}.packages`, errors, PACKAGE_ENTRY_RE);
    if (list) rule.packages = list;
  }
  if (raw.includeCategories !== undefined) {
    const list = stringArray(raw.includeCategories, `${path}.includeCategories`, errors);
    if (list) rule.includeCategories = list;
  }
  if (!rule.sources?.length && !rule.packages?.length && !rule.includeCategories?.length) errors.push(`${path}: must restrict sources, packages or includeCategories`);
  return rule;
}

export function validateFilter(raw: unknown, errors: string[]): SubscriptionFilter | undefined {
  if (!isRecord(raw)) {
    errors.push('filter: must be an object');
    return undefined;
  }
  errors.push(...unknownKeys(raw, FILTER_KEYS, 'filter'));
  const filter: SubscriptionFilter = {};

  if (raw.sources !== undefined) {
    const sources = stringArray(raw.sources, 'filter.sources', errors, /^[a-z]+:[a-z0-9][a-z0-9_-]*$/);
    if (sources) filter.sources = sources;
  }
  if (raw.kinds !== undefined) {
    if (!Array.isArray(raw.kinds)) {
      errors.push('filter.kinds: must be an array');
    } else {
      const kinds: EventKind[] = [];
      raw.kinds.forEach((k: unknown, i: number) => {
        if (typeof k === 'string' && (EVENT_KINDS as readonly string[]).includes(k)) {
          kinds.push(k as EventKind);
        } else {
          errors.push(`filter.kinds[${i}]: must be one of ${EVENT_KINDS.join(', ')}`);
        }
      });
      filter.kinds = kinds;
    }
  }
  for (const key of ['allowNsfw', 'dedupAcrossStores', 'includeChangelog'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === 'boolean') filter[key] = v;
    else errors.push(`filter.${key}: must be a boolean`);
  }
  for (const key of ['packages', 'excludePackages'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    const list = stringArray(v, `filter.${key}`, errors, PACKAGE_ENTRY_RE);
    if (list) filter[key] = list;
  }
  for (const key of ['watchlist', 'includeCategories', 'excludeCategories'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    const list = stringArray(v, `filter.${key}`, errors);
    if (list) filter[key] = list;
  }
  if (raw.alsoMatch !== undefined) {
    if (!Array.isArray(raw.alsoMatch)) {
      errors.push('filter.alsoMatch: must be an array');
    } else if (raw.alsoMatch.length > ALSO_MATCH_MAX_RULES) {
      errors.push(`filter.alsoMatch: at most ${ALSO_MATCH_MAX_RULES} rules`);
    } else {
      const rules: FilterRule[] = [];
      raw.alsoMatch.forEach((item: unknown, i: number) => {
        const rule = validateRule(item, `filter.alsoMatch[${i}]`, errors);
        if (rule) rules.push(rule);
      });
      filter.alsoMatch = rules;
    }
  }
  return filter;
}

export function validateSubscriptionFilter(
  raw: unknown,
): { ok: true; filter: SubscriptionFilter } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const filter = validateFilter(raw, errors);
  if (errors.length > 0 || !filter) return { ok: false, errors };
  return { ok: true, filter };
}
