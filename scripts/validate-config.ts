// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, DeliveryMode, SourceConfig, StoreKind, WebhookSubscription } from '../src/core/types.ts';
import {
  DELIVERY_MODES,
  DIGEST_INTERVAL_MAX_BOUND,
  DIGEST_INTERVAL_MIN_BOUND,
  isDigestInterval,
  isRecord,
  SNOWFLAKE_RE,
  SUBSCRIPTION_ID_RE,
  unknownKeys,
  validateFilter,
  validateSubscriptionFilter,
} from '../src/core/validation.ts';

export { SNOWFLAKE_RE, SUBSCRIPTION_ID_RE, validateSubscriptionFilter };

const STORES: readonly StoreKind[] = ['thunderstore', 'hexium', 'nexus'];
const COMMUNITY_RE = /^[a-z0-9][a-z0-9_-]*$/;
/** Discord webhook URL shape: https://discord.com/api/webhooks/<id>/<token>. */
const WEBHOOK_URL_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;
const REPO_URL_RE = /https?:\/\/[^\s)]+/;

const CONFIG_KEYS = ['userAgent', 'sources'];
const SOURCE_KEYS = ['id', 'store', 'community', 'enabled'];
const SUBSCRIPTION_KEYS = [
  'id',
  'guildId',
  'webhookUrl',
  'threadId',
  'filter',
  'mode',
  'digestIntervalMin',
  'enabled',
];

export type ConfigResult =
  | { ok: true; config: AppConfig; warnings: string[] }
  | { ok: false; errors: string[] };

export type SubscriptionResult =
  | { ok: true; subscription: WebhookSubscription }
  | { ok: false; errors: string[] };

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
  if (raw.threadId !== undefined && raw.threadId !== null && (typeof raw.threadId !== 'string' || !SNOWFLAKE_RE.test(raw.threadId))) {
    errors.push('threadId: must be a numeric Discord snowflake (17-20 digits)');
  }
  if (typeof raw.mode !== 'string' || !(DELIVERY_MODES as readonly string[]).includes(raw.mode)) {
    errors.push(`mode: must be one of ${DELIVERY_MODES.join(', ')}`);
  }
  const interval = raw.digestIntervalMin;
  if (!isDigestInterval(interval)) {
    errors.push(`digestIntervalMin: must be an integer between ${DIGEST_INTERVAL_MIN_BOUND} and ${DIGEST_INTERVAL_MAX_BOUND}`);
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
      threadId: (raw.threadId as string | null | undefined) ?? null,
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
