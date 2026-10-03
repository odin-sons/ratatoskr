// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_FILE = 'wrangler.jsonc';
const DATABASE_ID_PLACEHOLDER = '"REPLACE_WITH_YOUR_D1_DATABASE_ID"';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Worker and D1 database names committed in `wrangler.jsonc`; an instance that sets neither variable keeps them. */
export const DEFAULT_INSTANCE_NAME = 'ratatoskr';
const WORKER_NAME_FIELD = /("name"\s*:\s*)"ratatoskr"/g;
const DATABASE_NAME_FIELD = /("database_name"\s*:\s*)"ratatoskr"/g;
const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DATABASE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** True for a name the scripts accept for the D1 database: it ends up in a printed shell command and in the Cloudflare config. */
export const isValidDatabaseName = (name: string): boolean => DATABASE_NAME_RE.test(name);

export interface InstanceNames {
  workerName: string;
  databaseName: string;
}

export type DatabaseIdResult = { ok: true; id: string } | { ok: false; errors: string[] };
export type NamesResult = { ok: true; names: InstanceNames } | { ok: false; errors: string[] };
export type ConfigResult = { ok: true; text: string } | { ok: false; errors: string[] };

export const defaultNames: InstanceNames = { workerName: DEFAULT_INSTANCE_NAME, databaseName: DEFAULT_INSTANCE_NAME };

/** The D1 database name the scripts target when `--database` is not given: `D1_DATABASE_NAME`, else the committed default. */
export function defaultDatabaseName(env: Record<string, string | undefined>): string {
  const value = env.D1_DATABASE_NAME?.trim();
  return value === undefined || value === '' ? DEFAULT_INSTANCE_NAME : value;
}

/** Reads `WORKER_NAME` and `D1_DATABASE_NAME`; a blank or unset one keeps the default. Errors name the variable, never the value. */
export function collectInstanceNames(env: Record<string, string | undefined>): NamesResult {
  const worker = env.WORKER_NAME?.trim();
  const database = env.D1_DATABASE_NAME?.trim();
  const errors: string[] = [];
  if (worker !== undefined && worker !== '' && !WORKER_NAME_RE.test(worker)) {
    errors.push('WORKER_NAME must be 1-63 lowercase letters, digits or hyphens, starting and ending with a letter or digit (stricter than Cloudflare requires)');
  }
  if (database !== undefined && database !== '' && !DATABASE_NAME_RE.test(database)) {
    errors.push('D1_DATABASE_NAME must be 1-63 letters, digits, hyphens or underscores, starting with a letter or digit');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, names: { workerName: worker || DEFAULT_INSTANCE_NAME, databaseName: database || DEFAULT_INSTANCE_NAME } };
}

/** Reads `D1_DATABASE_ID`; the error names the variable, never the value. */
export function collectDatabaseId(env: Record<string, string | undefined>): DatabaseIdResult {
  const value = env.D1_DATABASE_ID?.trim();
  if (value === undefined || value === '') return { ok: false, errors: ['D1_DATABASE_ID is required (see .env.example)'] };
  if (UUID_RE.test(value)) return { ok: true, id: value };
  return { ok: false, errors: ['D1_DATABASE_ID must look like a D1 database id (a UUID)'] };
}

/**
 * Substitutes the real database id for the committed placeholder in `wrangler.jsonc`'s raw text, so the real id
 * never has to live in a file that could be committed. A literal replace, not a JSONC parse: the file's comments
 * and formatting pass through untouched. Replaces every occurrence (`split`/`join`, not `.replace()`, which would
 * silently leave a second one behind if the placeholder is ever reused for another field). Also renames the Worker
 * and the D1 database when `names` differ from the committed defaults.
 */
export function buildDeployConfig(configText: string, databaseId: string, names: InstanceNames = defaultNames): ConfigResult {
  if (!configText.includes(DATABASE_ID_PLACEHOLDER)) return { ok: false, errors: [`${CONFIG_FILE}: expected the placeholder ${DATABASE_ID_PLACEHOLDER}`] };
  let text = configText.split(DATABASE_ID_PLACEHOLDER).join(JSON.stringify(databaseId));
  const renames: [string, RegExp, string][] = [
    ['"name"', WORKER_NAME_FIELD, names.workerName],
    ['"database_name"', DATABASE_NAME_FIELD, names.databaseName],
  ];
  for (const [field, pattern, value] of renames) {
    if (value === DEFAULT_INSTANCE_NAME) continue;
    const found = text.match(pattern)?.length ?? 0;
    if (found !== 1) return { ok: false, errors: [`${CONFIG_FILE}: expected exactly one ${field}: "${DEFAULT_INSTANCE_NAME}" to rename, found ${found}`] };
    text = text.replace(pattern, (_match, key: string) => `${key}${JSON.stringify(value)}`);
  }
  return { ok: true, text };
}

/**
 * Drops a leading bare `--` from CLI passthrough args: `pnpm run <script> -- --dry-run` forwards the `--` itself
 * into `process.argv` instead of stripping it (confirmed live, not assumed), and wrangler's own parser then reads
 * `--dry-run` as a positional after an end-of-options marker instead of a flag — silently, with no error, running
 * a real command a caller clearly meant to be a dry run.
 */
export function stripLeadingSeparator(args: readonly string[]): string[] {
  return args[0] === '--' ? args.slice(1) : [...args];
}

/**
 * Writes `configText` next to the real `wrangler.jsonc` (under `root`), runs `use` with its path, and always deletes
 * it afterward. Must sit beside the real config, not in a system temp directory: `main` and other paths inside it
 * are relative to the config file's own location, not the process's working directory.
 */
export function withGeneratedConfig<T>(root: string, configText: string, use: (configPath: string) => T): T {
  const tempConfig = join(root, `.wrangler-deploy.${randomUUID()}.jsonc`);
  writeFileSync(tempConfig, configText);
  try {
    return use(tempConfig);
  } finally {
    rmSync(tempConfig, { force: true });
  }
}
