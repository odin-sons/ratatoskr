// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDeployConfig, collectDatabaseId, collectInstanceNames, CONFIG_FILE, stripLeadingSeparator, withGeneratedConfig } from './wrangler-config.ts';

/** Runs an arbitrary wrangler subcommand against the real database id (`D1_DATABASE_ID`) and the instance's names (`WORKER_NAME`, `D1_DATABASE_NAME`). */
function main(): number {
  const databaseId = collectDatabaseId(process.env);
  const names = collectInstanceNames(process.env);
  if (!databaseId.ok || !names.ok) {
    for (const error of [...(databaseId.ok ? [] : databaseId.errors), ...(names.ok ? [] : names.errors)]) console.error(`wrangler: ${error}`);
    return 1;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = buildDeployConfig(readFileSync(join(root, CONFIG_FILE), 'utf8'), databaseId.id, names.names);
  if (!config.ok) {
    for (const error of config.errors) console.error(`wrangler: ${error}`);
    return 1;
  }
  return withGeneratedConfig(root, config.text, (tempConfig) => {
    const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
    const result = spawnSync(process.execPath, [wrangler, '-c', tempConfig, ...stripLeadingSeparator(process.argv.slice(2))], { stdio: 'inherit' });
    return result.status ?? 1;
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
