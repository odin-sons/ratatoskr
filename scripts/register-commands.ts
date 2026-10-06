// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DISCORD_API_BASE, DISCORD_SEND_TIMEOUT_MS, PROJECT } from '../src/core/constants.ts';
import { SNOWFLAKE_RE } from '../src/core/validation.ts';
import { COMMAND_DEFINITIONS, type CommandDefinition } from '../src/interactions/definitions.ts';

const USAGE = `Usage: pnpm register-commands [--dry-run]

Registers the slash commands with Discord (a bulk overwrite of the application's global commands).
Needs DISCORD_APP_ID and DISCORD_BOT_TOKEN in the environment or in .env.

Options:
  --dry-run   Print the command definitions as JSON; no network call, no credentials needed
  --help      Show this help`;

export interface RegisterEnv {
  DISCORD_APP_ID?: string;
  DISCORD_BOT_TOKEN?: string;
}

export type RegisterResult = { ok: true; count: number } | { ok: false; error: string };

/** The error never carries the token or the response body. */
export async function registerCommands(env: RegisterEnv, fetchImpl: typeof fetch, definitions: readonly CommandDefinition[] = COMMAND_DEFINITIONS): Promise<RegisterResult> {
  const appId = env.DISCORD_APP_ID?.trim();
  const token = env.DISCORD_BOT_TOKEN?.trim();
  if (!appId || !token) return { ok: false, error: 'DISCORD_APP_ID and DISCORD_BOT_TOKEN must both be set' };
  if (!SNOWFLAKE_RE.test(appId)) return { ok: false, error: 'DISCORD_APP_ID must be a numeric Discord snowflake (17-20 digits)' };
  let res: Response;
  try {
    res = await fetchImpl(`${DISCORD_API_BASE}/applications/${appId}/commands`, {
      method: 'PUT',
      headers: {
        authorization: `Bot ${token}`,
        'content-type': 'application/json',
        'user-agent': `DiscordBot (${PROJECT.repoUrl}, ${PROJECT.version})`,
      },
      body: JSON.stringify(definitions),
      redirect: 'manual',
      signal: AbortSignal.timeout(DISCORD_SEND_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `request failed: ${err instanceof Error ? err.name : 'error'}` };
  }
  if (!res.ok) return { ok: false, error: `Discord answered HTTP ${res.status}` };
  return { ok: true, count: definitions.length };
}

export function parseCli(argv: string[]): { dryRun: boolean; help: boolean } {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    strict: true,
    options: { 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
  });
  return { dryRun: values['dry-run'] as boolean, help: values.help as boolean };
}

async function main(): Promise<void> {
  let options: ReturnType<typeof parseCli>;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`register-commands: ${(err as Error).message}\n`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.dryRun) {
    console.log(JSON.stringify(COMMAND_DEFINITIONS, null, 2));
    return;
  }
  const result = await registerCommands(process.env, fetch);
  if (!result.ok) {
    console.error(`register-commands: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`register-commands: registered ${result.count} commands`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
