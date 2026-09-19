// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DIGEST_INTERVAL_MIN } from '../src/core/constants.ts';
import type { Subscription } from '../src/core/types.ts';
import { validateSubscription } from './validate-config.ts';

const DEFAULT_DATABASE = 'ratatoskr';

const USAGE = `Usage: pnpm add-subscription --guild-id <id> (--webhook-url-env <VAR> | --webhook-url <url>) [options]

Prints the wrangler command that inserts a subscription. Nothing is executed.

Options:
  --guild-id <id>            Discord guild id (numeric snowflake). Required.
  --webhook-url-env <VAR>    Read the webhook URL from this environment variable.
  --webhook-url <url>        Webhook URL as an argument (ends up in shell history).
  --mode <mode>              immediate | digest (default: digest)
  --interval <minutes>       Digest interval, 5..1440 (default: ${DEFAULT_DIGEST_INTERVAL_MIN})
  --filter <json>            SubscriptionFilter as a JSON string (default: {})
  --filter-file <path>       SubscriptionFilter read from a JSON file
  --database <name>          D1 database name (default: ${DEFAULT_DATABASE})
  --local                    Target the local D1 database instead of --remote
  --sql-only                 Print only the SQL statement
  --help                     Show this help

The webhook URL is a credential: anyone holding it can post to the channel.
Prefer --webhook-url-env over --webhook-url, and clear your terminal scrollback
after use.`;

export interface CliOptions {
  guildId?: string;
  webhookUrl?: string;
  mode: string;
  interval: number;
  filter: unknown;
  database: string;
  local: boolean;
  sqlOnly: boolean;
  help: boolean;
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildInsertSql(sub: Subscription): string {
  return (
    'INSERT INTO subscriptions (id, guild_id, webhook_url, filter, mode, digest_interval_min, enabled) VALUES (' +
    [
      sqlString(sub.id),
      sqlString(sub.guildId),
      sqlString(sub.webhookUrl),
      sqlString(JSON.stringify(sub.filter)),
      sqlString(sub.mode),
      String(sub.digestIntervalMin),
      sub.enabled ? '1' : '0',
    ].join(', ') +
    ');'
  );
}

/** Quotes for a POSIX shell double-quoted argument. */
export function shellDoubleQuote(value: string): string {
  return `"${value.replace(/[\\"$`]/g, '\\$&')}"`;
}

export function buildWranglerCommand(sql: string, database: string, local: boolean): string {
  return `wrangler d1 execute ${database} ${local ? '--local' : '--remote'} --command ${shellDoubleQuote(sql)}`;
}

export function parseCli(argv: string[], env: Record<string, string | undefined>): CliOptions {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    strict: true,
    options: {
      'guild-id': { type: 'string' },
      'webhook-url': { type: 'string' },
      'webhook-url-env': { type: 'string' },
      mode: { type: 'string', default: 'digest' },
      interval: { type: 'string', default: String(DEFAULT_DIGEST_INTERVAL_MIN) },
      filter: { type: 'string' },
      'filter-file': { type: 'string' },
      database: { type: 'string', default: DEFAULT_DATABASE },
      local: { type: 'boolean', default: false },
      'sql-only': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values['webhook-url'] !== undefined && values['webhook-url-env'] !== undefined) {
    throw new Error('use either --webhook-url or --webhook-url-env, not both');
  }
  if (values.filter !== undefined && values['filter-file'] !== undefined) {
    throw new Error('use either --filter or --filter-file, not both');
  }

  let webhookUrl = values['webhook-url'];
  const envName = values['webhook-url-env'];
  if (envName !== undefined) {
    webhookUrl = env[envName];
    if (webhookUrl === undefined || webhookUrl === '') {
      throw new Error(`environment variable ${envName} is not set`);
    }
  }

  let filterText = values.filter;
  if (values['filter-file'] !== undefined) {
    filterText = readFileSync(values['filter-file'], 'utf8');
  }
  let filter: unknown = {};
  if (filterText !== undefined) {
    try {
      filter = JSON.parse(filterText);
    } catch (err) {
      throw new Error(`filter is not valid JSON: ${(err as Error).message}`);
    }
  }

  return {
    guildId: values['guild-id'],
    webhookUrl,
    mode: values.mode as string,
    interval: Number(values.interval),
    filter,
    database: values.database as string,
    local: values.local as boolean,
    sqlOnly: values['sql-only'] as boolean,
    help: values.help as boolean,
  };
}

function main(): void {
  let opts: CliOptions;
  try {
    opts = parseCli(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`add-subscription: ${(err as Error).message}\n`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const result = validateSubscription({
    id: randomUUID(),
    guildId: opts.guildId,
    webhookUrl: opts.webhookUrl,
    filter: opts.filter,
    mode: opts.mode,
    digestIntervalMin: opts.interval,
  });
  if (!result.ok) {
    console.error('add-subscription: invalid input');
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }

  const sql = buildInsertSql(result.subscription);
  console.error('The output below contains the webhook URL, which is a credential. Do not paste it into shared places.');
  console.log(opts.sqlOnly ? sql : buildWranglerCommand(sql, opts.database, opts.local));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
