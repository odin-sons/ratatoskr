// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DIGEST_INTERVAL_MIN } from '../src/core/constants.ts';
import type { Subscription } from '../src/core/types.ts';
import { FILTER_FLAG_OPTIONS, FILTER_FLAGS_NOTE, FILTER_FLAGS_USAGE, resolveFilter, type FilterFlagValues } from './filter-flags.ts';
import { SNOWFLAKE_RE, SUBSCRIPTION_ID_RE, validateSubscription } from './validate-config.ts';
import { defaultDatabaseName, isValidDatabaseName } from './wrangler-config.ts';

const defaultDatabase = (): string => defaultDatabaseName(process.env);

const USAGE = `Usage: pnpm add-subscription --guild-id <id> (--webhook-url-env <VAR> | --webhook-url <url>) [options]

Prints the wrangler command that inserts a subscription. Nothing is executed.
Each subscription is one channel webhook with its own filter; add as many as you like.

Options:
  --guild-id <id>            Discord guild id (numeric snowflake). Required.
  --webhook-url-env <VAR>    Read the webhook URL from this environment variable.
  --webhook-url <url>        Webhook URL as an argument (ends up in shell history).
  --thread-id <id>           Deliver into this existing forum post or channel thread instead
                             of the webhook's parent channel (numeric snowflake). The thread
                             must already exist; this never creates one.
  --id <name>                Subscription id, [A-Za-z0-9_-]{1,64} (default: random UUID).
                             Inserting an id that already exists fails; nothing is replaced.
  --mode <mode>              immediate | digest (default: digest)
  --interval <minutes>       Digest interval, 5..1440 (default: ${DEFAULT_DIGEST_INTERVAL_MIN})
${FILTER_FLAGS_USAGE}
  --database <name>          D1 database name (default: ${defaultDatabase()}; D1_DATABASE_NAME in .env sets it)
  --local                    Target the local D1 database instead of --remote
  --sql-only                 Print only the SQL statement
  --help                     Show this help

${FILTER_FLAGS_NOTE}
The webhook URL is a credential: anyone holding it can post to the channel.
Prefer --webhook-url-env over --webhook-url, and clear your terminal scrollback
after use.`;

export interface CliOptions {
  id?: string;
  guildId?: string;
  webhookUrl?: string;
  threadId?: string;
  mode: string;
  interval: number;
  filter: unknown;
  database: string;
  local: boolean;
  sqlOnly: boolean;
  help: boolean;
}

export type SubscriptionPlan =
  | { ok: true; subscription: Subscription; sql: string }
  | { ok: false; errors: string[] };

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A plain INSERT: a duplicate id must fail loudly, never replace an existing subscription. */
export function buildInsertSql(sub: Subscription): string {
  return (
    'INSERT INTO subscriptions (id, guild_id, webhook_url, thread_id, filter, mode, digest_interval_min, enabled) VALUES (' +
    [
      sqlString(sub.id),
      sqlString(sub.guildId),
      sqlString(sub.webhookUrl),
      sub.threadId ? sqlString(sub.threadId) : 'NULL',
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
  return `pnpm run wrangler d1 execute ${database} ${local ? '--local' : '--remote'} --command ${shellDoubleQuote(sql)}`;
}

export function parseCli(argv: string[], env: Record<string, string | undefined>): CliOptions {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    strict: true,
    options: {
      'guild-id': { type: 'string' },
      'webhook-url': { type: 'string' },
      'webhook-url-env': { type: 'string' },
      'thread-id': { type: 'string' },
      id: { type: 'string' },
      mode: { type: 'string', default: 'digest' },
      interval: { type: 'string', default: String(DEFAULT_DIGEST_INTERVAL_MIN) },
      ...FILTER_FLAG_OPTIONS,
      database: { type: 'string', default: defaultDatabase() },
      local: { type: 'boolean', default: false },
      'sql-only': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values['webhook-url'] !== undefined && values['webhook-url-env'] !== undefined) {
    throw new Error('use either --webhook-url or --webhook-url-env, not both');
  }
  if (values.id !== undefined && !SUBSCRIPTION_ID_RE.test(values.id)) {
    throw new Error(`--id must match ${SUBSCRIPTION_ID_RE.source}`);
  }
  if (values['thread-id'] !== undefined && !SNOWFLAKE_RE.test(values['thread-id'])) {
    throw new Error('--thread-id must be a numeric Discord snowflake (17-20 digits)');
  }

  let webhookUrl = values['webhook-url'];
  const envName = values['webhook-url-env'];
  if (envName !== undefined) {
    webhookUrl = env[envName];
    if (webhookUrl === undefined || webhookUrl === '') {
      throw new Error(`environment variable ${envName} is not set`);
    }
  }

  if (!isValidDatabaseName(values.database as string)) throw new Error('--database must be 1-63 letters, digits, hyphens or underscores, starting with a letter or digit');

  return {
    id: values.id,
    guildId: values['guild-id'],
    webhookUrl,
    threadId: values['thread-id'],
    mode: values.mode as string,
    interval: Number(values.interval),
    filter: resolveFilter(values as FilterFlagValues),
    database: values.database as string,
    local: values.local as boolean,
    sqlOnly: values['sql-only'] as boolean,
    help: values.help as boolean,
  };
}

export function planSubscription(opts: CliOptions, newId: () => string): SubscriptionPlan {
  const result = validateSubscription({
    id: opts.id ?? newId(),
    guildId: opts.guildId,
    webhookUrl: opts.webhookUrl,
    threadId: opts.threadId,
    filter: opts.filter,
    mode: opts.mode,
    digestIntervalMin: opts.interval,
  });
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, subscription: result.subscription, sql: buildInsertSql(result.subscription) };
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

  const plan = planSubscription(opts, randomUUID);
  if (!plan.ok) {
    console.error('add-subscription: invalid input');
    for (const e of plan.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }

  console.error('The output below contains the webhook URL, which is a credential. Do not paste it into shared places.');
  console.log(opts.sqlOnly ? plan.sql : buildWranglerCommand(plan.sql, opts.database, opts.local));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
