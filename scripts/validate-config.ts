// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AppConfig,
  DeliveryMode,
  EventKind,
  SourceConfig,
  StoreKind,
  Subscription,
  SubscriptionFilter,
} from '../src/core/types.ts';

const STORES: readonly StoreKind[] = ['thunderstore', 'hexium', 'nexus'];
const EVENT_KINDS: readonly EventKind[] = ['new', 'update'];
const DELIVERY_MODES: readonly DeliveryMode[] = ['immediate', 'digest'];

const COMMUNITY_RE = /^[a-z0-9][a-z0-9_-]*$/;
/** Subscription ids end up in SQL and shell commands, so they stay in a plain-token alphabet. */
export const SUBSCRIPTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PACKAGE_ENTRY_RE = /^[^\s\x00-\x1f\x7f][^\x00-\x1f\x7f]{0,127}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;
/** Discord webhook URL shape: https://discord.com/api/webhooks/<id>/<token>. */
const WEBHOOK_URL_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;
const REPO_URL_RE = /https?:\/\/[^\s)]+/;

const DIGEST_INTERVAL_MIN_BOUND = 5;
const DIGEST_INTERVAL_MAX_BOUND = 1440;

const CONFIG_KEYS = ['userAgent', 'sources'];
const SOURCE_KEYS = ['id', 'store', 'community', 'enabled'];
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
];
const SUBSCRIPTION_KEYS = [
  'id',
  'guildId',
  'webhookUrl',
  'filter',
  'mode',
  'digestIntervalMin',
  'enabled',
];

export type ConfigResult =
  | { ok: true; config: AppConfig; warnings: string[] }
  | { ok: false; errors: string[] };

export type SubscriptionResult =
  | { ok: true; subscription: Subscription }
  | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unknownKeys(obj: Record<string, unknown>, allowed: string[], path: string): string[] {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${path}: unknown key "${k}"`);
}

function isStore(v: unknown): v is StoreKind {
  return typeof v === 'string' && (STORES as readonly string[]).includes(v);
}

export function validateConfig(raw: unknown): ConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ['config: must be a JSON object'] };
  }
  errors.push(...unknownKeys(raw, CONFIG_KEYS, 'config'));

  const userAgent = raw.userAgent;
  if (typeof userAgent !== 'string' || userAgent.trim() === '') {
    errors.push('userAgent: must be a non-empty string');
  } else if (!REPO_URL_RE.test(userAgent)) {
    errors.push('userAgent: must contain the repository URL (e.g. https://github.com/<owner>/ratatoskr)');
  }

  const sources: SourceConfig[] = [];
  if (!Array.isArray(raw.sources)) {
    errors.push('sources: must be an array');
  } else {
    const seen = new Set<string>();
    raw.sources.forEach((item: unknown, i: number) => {
      const path = `sources[${i}]`;
      if (!isRecord(item)) {
        errors.push(`${path}: must be an object`);
        return;
      }
      errors.push(...unknownKeys(item, SOURCE_KEYS, path));

      let ok = true;
      if (!isStore(item.store)) {
        errors.push(`${path}.store: must be one of ${STORES.join(', ')}`);
        ok = false;
      }
      if (typeof item.community !== 'string' || !COMMUNITY_RE.test(item.community)) {
        errors.push(`${path}.community: must match ${COMMUNITY_RE.source}`);
        ok = false;
      }
      if (typeof item.enabled !== 'boolean') {
        errors.push(`${path}.enabled: must be a boolean`);
        ok = false;
      }
      if (typeof item.id !== 'string' || item.id === '') {
        errors.push(`${path}.id: must be a non-empty string`);
        ok = false;
      } else {
        if (seen.has(item.id)) {
          errors.push(`${path}.id: duplicate source id "${item.id}"`);
          ok = false;
        }
        seen.add(item.id);
        if (
          isStore(item.store) &&
          typeof item.community === 'string' &&
          item.id !== `${item.store}:${item.community}`
        ) {
          errors.push(`${path}.id: must be "${item.store}:${item.community}", got "${item.id}"`);
          ok = false;
        }
      }
      if (!ok) return;

      const source = item as unknown as SourceConfig;
      sources.push({
        id: source.id,
        store: source.store,
        community: source.community,
        enabled: source.enabled,
      });
      if (source.store === 'nexus' && source.enabled) {
        warnings.push(
          `${source.id} is enabled. Nexus requires your own personal API key and compliance with ` +
            `the Nexus API Acceptable Use Policy; see docs/legal.md before deploying.`,
        );
      }
    });
    if (raw.sources.length > 0 && !sources.some((s) => s.enabled)) {
      warnings.push('sources: no source is enabled; the bot will not report anything');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { userAgent: userAgent as string, sources }, warnings };
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

function validateFilter(raw: unknown, errors: string[]): SubscriptionFilter | undefined {
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

export function validateSubscription(raw: unknown): SubscriptionResult {
  if (!isRecord(raw)) {
    return { ok: false, errors: ['subscription: must be an object'] };
  }
  const errors: string[] = [];
  errors.push(...unknownKeys(raw, SUBSCRIPTION_KEYS, 'subscription'));

  if (typeof raw.id !== 'string' || !SUBSCRIPTION_ID_RE.test(raw.id)) {
    errors.push(`id: must match ${SUBSCRIPTION_ID_RE.source}`);
  }
  if (typeof raw.guildId !== 'string' || !SNOWFLAKE_RE.test(raw.guildId)) {
    errors.push('guildId: must be a numeric Discord snowflake (17-20 digits)');
  }
  if (typeof raw.webhookUrl !== 'string' || !WEBHOOK_URL_RE.test(raw.webhookUrl)) {
    errors.push('webhookUrl: must look like https://discord.com/api/webhooks/<id>/<token>');
  }
  if (typeof raw.mode !== 'string' || !(DELIVERY_MODES as readonly string[]).includes(raw.mode)) {
    errors.push(`mode: must be one of ${DELIVERY_MODES.join(', ')}`);
  }
  const interval = raw.digestIntervalMin;
  if (
    typeof interval !== 'number' ||
    !Number.isInteger(interval) ||
    interval < DIGEST_INTERVAL_MIN_BOUND ||
    interval > DIGEST_INTERVAL_MAX_BOUND
  ) {
    errors.push(
      `digestIntervalMin: must be an integer between ${DIGEST_INTERVAL_MIN_BOUND} and ${DIGEST_INTERVAL_MAX_BOUND}`,
    );
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push('enabled: must be a boolean');
  }
  const filter = validateFilter(raw.filter ?? {}, errors);

  if (errors.length > 0 || !filter) return { ok: false, errors };
  return {
    ok: true,
    subscription: {
      id: raw.id as string,
      guildId: raw.guildId as string,
      webhookUrl: raw.webhookUrl as string,
      filter,
      mode: raw.mode as DeliveryMode,
      digestIntervalMin: interval as number,
      enabled: raw.enabled === undefined ? true : (raw.enabled as boolean),
    },
  };
}

function main(): void {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ratatoskr.config.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`validate-config: cannot read ${path}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const result = validateConfig(raw);
  if (!result.ok) {
    console.error('validate-config: ratatoskr.config.json is invalid');
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  for (const w of result.warnings) console.warn(`WARNING: ${w}`);
  const enabled = result.config.sources.filter((s) => s.enabled).length;
  console.log(
    `validate-config: OK (${result.config.sources.length} sources, ${enabled} enabled)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
