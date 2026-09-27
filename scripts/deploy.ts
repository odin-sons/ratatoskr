// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DISCORD_CUSTOM_EMOJI } from '../src/core/constants.ts';
import { isLanguage, LANGUAGES, type Language } from '../src/i18n/index.ts';

const LOCAL_CONFIG = 'wrangler.local.jsonc';

const EMOJI_VARIABLES = {
  STORE_EMOJI_THUNDERSTORE: 'thunderstore',
  STORE_EMOJI_HEXIUM: 'hexium',
  STORE_EMOJI_NEXUS: 'nexus',
} as const;

export type EmojiResult = { ok: true; emojis: Record<string, string> } | { ok: false; errors: string[] };
export type LanguageResult = { ok: true; language?: Language } | { ok: false; errors: string[] };
export type SingleEmojiResult = { ok: true; emoji?: string } | { ok: false; errors: string[] };
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

/**
 * Reads `RATATOSKR_LANGUAGE` (not `LANGUAGE`, which is the POSIX locale variable and is set on many machines); the Worker
 * variable it feeds is `LANGUAGE`. The error names the variable and the choices, never the value.
 */
export function collectLanguage(env: Record<string, string | undefined>): LanguageResult {
  const value = env.RATATOSKR_LANGUAGE?.trim().toLowerCase();
  if (value === undefined || value === '') return { ok: true };
  if (isLanguage(value)) return { ok: true, language: value };
  return { ok: false, errors: [`RATATOSKR_LANGUAGE must be one of: ${LANGUAGES.join(', ')}`] };
}

/** Reads `RATATOSKR_EMOJI`; the error names the variable, never the value. */
export function collectRatatoskrEmoji(env: Record<string, string | undefined>): SingleEmojiResult {
  const value = env.RATATOSKR_EMOJI?.trim();
  if (value === undefined || value === '') return { ok: true };
  if (DISCORD_CUSTOM_EMOJI.test(value)) return { ok: true, emoji: value };
  return { ok: false, errors: ['RATATOSKR_EMOJI must be full emoji markup like <:name:123456789012345678>'] };
}

export function buildDeployArgs(input: { env: Record<string, string | undefined>; hasLocalConfig: boolean }): DeployArgsResult {
  const stores = collectStoreEmojis(input.env);
  const language = collectLanguage(input.env);
  const source = collectRatatoskrEmoji(input.env);
  const errors = [stores, language, source].flatMap((result) => (result.ok ? [] : result.errors));
  if (errors.length > 0) return { ok: false, errors };
  const args = ['deploy'];
  if (input.hasLocalConfig) args.push('-c', LOCAL_CONFIG);
  if (stores.ok && Object.keys(stores.emojis).length > 0) args.push('--var', `STORE_EMOJIS:${JSON.stringify(stores.emojis)}`);
  if (language.ok && language.language !== undefined) args.push('--var', `LANGUAGE:${language.language}`);
  if (source.ok && source.emoji !== undefined) args.push('--var', `RATATOSKR_EMOJI:${source.emoji}`);
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
