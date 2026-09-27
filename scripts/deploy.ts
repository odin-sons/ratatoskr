// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DISCORD_CUSTOM_EMOJI } from '../src/core/constants.ts';

const LOCAL_CONFIG = 'wrangler.local.jsonc';

const EMOJI_VARIABLES = {
  STORE_EMOJI_THUNDERSTORE: 'thunderstore',
  STORE_EMOJI_HEXIUM: 'hexium',
  STORE_EMOJI_NEXUS: 'nexus',
} as const;

export type EmojiResult = { ok: true; emojis: Record<string, string> } | { ok: false; errors: string[] };
export type DeployArgsResult = { ok: true; args: string[] } | { ok: false; errors: string[] };

/** Reads the per-store emoji variables; error messages name the variable, never its value. */
export function collectStoreEmojis(env: Record<string, string | undefined>): EmojiResult {
  const emojis: Record<string, string> = {};
  const errors: string[] = [];
  for (const [variable, store] of Object.entries(EMOJI_VARIABLES)) {
    const value = env[variable]?.trim();
    if (value === undefined || value === '') continue;
    if (DISCORD_CUSTOM_EMOJI.test(value)) emojis[store] = value;
    else errors.push(`${variable} must be full emoji markup like <:name:123456789012345678>`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, emojis };
}

export function buildDeployArgs(input: { env: Record<string, string | undefined>; hasLocalConfig: boolean }): DeployArgsResult {
  const emoji = collectStoreEmojis(input.env);
  if (!emoji.ok) return emoji;
  const args = ['deploy'];
  if (input.hasLocalConfig) args.push('-c', LOCAL_CONFIG);
  if (Object.keys(emoji.emojis).length > 0) args.push('--var', `STORE_EMOJIS:${JSON.stringify(emoji.emojis)}`);
  return { ok: true, args };
}

function main(): number {
  const built = buildDeployArgs({ env: process.env, hasLocalConfig: existsSync(LOCAL_CONFIG) });
  if (!built.ok) {
    for (const error of built.errors) console.error(`deploy: ${error}`);
    return 1;
  }
  const wrangler = resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/wrangler/bin/wrangler.js');
  const result = spawnSync(process.execPath, [wrangler, ...built.args, ...process.argv.slice(2)], { stdio: 'inherit' });
  return result.status ?? 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
