// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildWranglerCommand, sqlString } from './add-subscription.ts';
import { FILTER_FLAG_OPTIONS, FILTER_FLAGS_NOTE, FILTER_FLAGS_USAGE, resolveFilter, type FilterFlagValues } from './filter-flags.ts';
import { SUBSCRIPTION_ID_RE, validateSubscriptionFilter } from './validate-config.ts';

const DEFAULT_DATABASE = 'ratatoskr';
const COMMANDS = ['list', 'disable', 'enable', 'remove', 'set-filter'] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `Usage: pnpm subscriptions <command> [options]

Prints the wrangler command for a subscription change. Nothing is executed.

Commands:
  list                       Show id, guild, mode, filter, enabled, thread id and the webhook id (never its token)
  disable --id <name>        Stop delivering to this subscription; keeps its row and filter
  enable --id <name>         Resume a disabled subscription
  remove --id <name>         Delete the subscription and its pending deliveries
  set-filter --id <name> ... Replace the whole filter (see the filter flags below)

Options:
  --id <name>                Subscription id, [A-Za-z0-9_-]{1,64}
${FILTER_FLAGS_USAGE}
  --database <name>          D1 database name (default: ${DEFAULT_DATABASE})
  --local                    Target the local D1 database instead of --remote
  --sql-only                 Print only the SQL statement(s)
  --help                     Show this help

${FILTER_FLAGS_NOTE}
set-filter replaces the filter as a whole: flags you leave out are reset.
Pass --filter '{}' to clear it on purpose. Run "list" first to see the current one.`;

export interface SubscriptionsCli {
  command: Command | 'help';
  id?: string;
  filter?: unknown;
  database: string;
  local: boolean;
  sqlOnly: boolean;
}

export type CommandPlan = { ok: true; command: string } | { ok: false; errors: string[] };

const WEBHOOK_PATH = '/api/webhooks/';

/**
 * Selects the webhook id and thread id, and only when the URL has the expected shape. The token
 * is never selected; anything unexpected prints "(unrecognised)".
 */
export function buildListSql(): string {
  const rest = `CASE WHEN instr(webhook_url, '${WEBHOOK_PATH}') > 0 THEN substr(webhook_url, instr(webhook_url, '${WEBHOOK_PATH}') + ${WEBHOOK_PATH.length}) ELSE '' END`;
  const webhookId = `CASE WHEN instr(rest, '/') > 0 THEN substr(rest, 1, instr(rest, '/') - 1) ELSE '' END`;
  return (
    'SELECT id, guild_id, mode, filter, enabled, thread_id, ' +
    `CASE WHEN wid != '' AND wid NOT GLOB '*[^0-9]*' THEN '...${WEBHOOK_PATH}' || wid || '/<token hidden>' ELSE '(unrecognised)' END AS webhook ` +
    `FROM (SELECT id, guild_id, mode, filter, enabled, thread_id, ${webhookId} AS wid FROM ` +
    `(SELECT id, guild_id, mode, filter, enabled, thread_id, ${rest} AS rest FROM subscriptions)) ORDER BY id;`
  );
}

export function buildSetEnabledSql(id: string, enabled: boolean): string {
  return `UPDATE subscriptions SET enabled = ${enabled ? 1 : 0} WHERE id = ${sqlString(id)};`;
}

/** The subscription goes first: a failure after it leaves harmless orphans, never lost deliveries of a live subscription. */
export function buildRemoveSql(id: string): string {
  const quoted = sqlString(id);
  return `DELETE FROM subscriptions WHERE id = ${quoted}; DELETE FROM outbox WHERE subscription_id = ${quoted} AND delivered_at IS NULL;`;
}

export function buildSetFilterSql(id: string, filter: unknown): string {
  return `UPDATE subscriptions SET filter = ${sqlString(JSON.stringify(filter))} WHERE id = ${sqlString(id)};`;
}

function hasFilterFlags(values: FilterFlagValues): boolean {
  return (
    values.filter !== undefined ||
    values['filter-file'] !== undefined ||
    values['allow-nsfw'] === true ||
    (['source', 'kind', 'package', 'exclude-package', 'category', 'exclude-category'] as const).some((k) => (values[k]?.length ?? 0) > 0)
  );
}

export function parseCli(argv: string[]): SubscriptionsCli {
  const { values, positionals } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    strict: true,
    allowPositionals: true,
    options: {
      id: { type: 'string' },
      ...FILTER_FLAG_OPTIONS,
      database: { type: 'string', default: DEFAULT_DATABASE },
      local: { type: 'boolean', default: false },
      'sql-only': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const base = { database: values.database as string, local: values.local as boolean, sqlOnly: values['sql-only'] as boolean };
  if (values.help) return { command: 'help', ...base };

  const [command, ...extra] = positionals;
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`expected a command: ${COMMANDS.join(', ')}`);
  }
  if (extra.length > 0) throw new Error(`unexpected argument "${extra[0]}"`);
  const name = command as Command;
  const filterFlags = values as FilterFlagValues;

  if (name === 'list') {
    if (values.id !== undefined || hasFilterFlags(filterFlags)) throw new Error('list takes no --id or filter flags');
    return { command: name, ...base };
  }

  if (values.id === undefined) throw new Error(`${name} requires --id`);
  if (!SUBSCRIPTION_ID_RE.test(values.id)) throw new Error(`--id must match ${SUBSCRIPTION_ID_RE.source}`);

  if (name !== 'set-filter') {
    if (hasFilterFlags(filterFlags)) throw new Error(`filter flags are only accepted by set-filter, not ${name}`);
    return { command: name, id: values.id, ...base };
  }
  if (!hasFilterFlags(filterFlags)) {
    throw new Error("set-filter needs at least one filter flag, or --filter '{}' to clear the filter");
  }
  return { command: name, id: values.id, filter: resolveFilter(filterFlags), ...base };
}

export function planCommand(cli: SubscriptionsCli): CommandPlan {
  const sql = buildSql(cli);
  if (!sql.ok) return sql;
  return { ok: true, command: cli.sqlOnly ? sql.sql : buildWranglerCommand(sql.sql, cli.database, cli.local) };
}

function buildSql(cli: SubscriptionsCli): { ok: true; sql: string } | { ok: false; errors: string[] } {
  const id = cli.id as string;
  switch (cli.command) {
    case 'list':
      return { ok: true, sql: buildListSql() };
    case 'disable':
      return { ok: true, sql: buildSetEnabledSql(id, false) };
    case 'enable':
      return { ok: true, sql: buildSetEnabledSql(id, true) };
    case 'remove':
      return { ok: true, sql: buildRemoveSql(id) };
    case 'set-filter': {
      const result = validateSubscriptionFilter(cli.filter);
      if (!result.ok) return result;
      return { ok: true, sql: buildSetFilterSql(id, result.filter) };
    }
    case 'help':
      return { ok: false, errors: ['no command'] };
  }
}

function main(): void {
  let cli: SubscriptionsCli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`subscriptions: ${(err as Error).message}\n`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (cli.command === 'help') {
    console.log(USAGE);
    return;
  }
  const plan = planCommand(cli);
  if (!plan.ok) {
    console.error('subscriptions: invalid input');
    for (const e of plan.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log(plan.command);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
