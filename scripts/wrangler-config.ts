// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_FILE = 'wrangler.jsonc';
const DATABASE_ID_PLACEHOLDER = '"REPLACE_WITH_YOUR_D1_DATABASE_ID"';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DatabaseIdResult = { ok: true; id: string } | { ok: false; errors: string[] };
export type ConfigResult = { ok: true; text: string } | { ok: false; errors: string[] };

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
 * silently leave a second one behind if the placeholder is ever reused for another field).
 */
export function buildDeployConfig(configText: string, databaseId: string): ConfigResult {
  if (!configText.includes(DATABASE_ID_PLACEHOLDER)) return { ok: false, errors: [`${CONFIG_FILE}: expected the placeholder ${DATABASE_ID_PLACEHOLDER}`] };
  return { ok: true, text: configText.split(DATABASE_ID_PLACEHOLDER).join(JSON.stringify(databaseId)) };
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
