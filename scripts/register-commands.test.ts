// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_DEFINITIONS } from '../src/interactions/definitions.ts';
import { createFakeFetch, json } from '../src/sources/__fixtures__/fake-fetch.ts';
import { parseCli, registerCommands } from './register-commands.ts';

const APP_ID = '423456789012345678';
const TOKEN = 'SENTINEL-BOT-TOKEN-zz9';

describe('parseCli', () => {
  it('defaults to a real run and reads --dry-run, dropping a pnpm-forwarded --', () => {
    expect(parseCli([])).toEqual({ dryRun: false, help: false });
    expect(parseCli(['--', '--dry-run'])).toEqual({ dryRun: true, help: false });
    expect(parseCli(['--help']).help).toBe(true);
  });

  it('refuses an unknown flag', () => {
    expect(() => parseCli(['--force'])).toThrow();
  });
});

describe('registerCommands', () => {
  it('PUTs every definition to the application commands with the bot token', async () => {
    const fake = createFakeFetch([['/commands', () => json([])]]);
    const requests: { body: string }[] = [];
    const recording = ((url: string, init?: RequestInit) => {
      requests.push({ body: String(init?.body) });
      return fake.fetch(url, init);
    }) as typeof fetch;
    expect(await registerCommands({ DISCORD_APP_ID: APP_ID, DISCORD_BOT_TOKEN: TOKEN }, recording)).toEqual({ ok: true, count: COMMAND_DEFINITIONS.length });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ url: `https://discord.com/api/v10/applications/${APP_ID}/commands`, method: 'PUT' });
    expect(fake.calls[0]!.headers.authorization).toBe(`Bot ${TOKEN}`);
    expect(JSON.parse(requests[0]!.body)).toEqual(JSON.parse(JSON.stringify(COMMAND_DEFINITIONS)));
  });

  it.each([
    ['both variables missing', {}],
    ['the token missing', { DISCORD_APP_ID: APP_ID }],
    ['the application id missing', { DISCORD_BOT_TOKEN: TOKEN }],
    ['blank values', { DISCORD_APP_ID: ' ', DISCORD_BOT_TOKEN: ' ' }],
  ])('refuses to run with %s and makes no request', async (_name, env) => {
    const fake = createFakeFetch([]);
    const result = await registerCommands(env, fake.fetch);
    expect(result).toEqual({ ok: false, error: 'DISCORD_APP_ID and DISCORD_BOT_TOKEN must both be set' });
    expect(fake.calls).toEqual([]);
  });

  it('refuses an application id that is not a snowflake, so it cannot reshape the URL', async () => {
    const fake = createFakeFetch([]);
    const result = await registerCommands({ DISCORD_APP_ID: '../../users/@me', DISCORD_BOT_TOKEN: TOKEN }, fake.fetch);
    expect(result.ok).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('reports a rejection by status only, never echoing the token or the response body', async () => {
    const fake = createFakeFetch([['/commands', () => json({ message: `bad ${TOKEN}` }, { status: 401 })]]);
    const result = await registerCommands({ DISCORD_APP_ID: APP_ID, DISCORD_BOT_TOKEN: TOKEN }, fake.fetch);
    expect(result).toEqual({ ok: false, error: 'Discord answered HTTP 401' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('reports a network failure by error name only', async () => {
    const failing = (() => Promise.reject(new TypeError(`fetch failed for ${TOKEN}`))) as unknown as typeof fetch;
    const result = await registerCommands({ DISCORD_APP_ID: APP_ID, DISCORD_BOT_TOKEN: TOKEN }, failing);
    expect(result).toEqual({ ok: false, error: 'request failed: TypeError' });
  });
});

describe('the script', () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, 'register-commands.ts'), ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });

  it('--dry-run prints the definitions as JSON without credentials and without a network call', () => {
    const result = run(['--dry-run'], {});
    expect(result.status).toBe(0);
    const printed = JSON.parse(result.stdout) as { name: string; type: number; default_member_permissions?: string }[];
    expect(printed).toEqual(JSON.parse(JSON.stringify(COMMAND_DEFINITIONS)));
    expect(printed.map((c) => [c.name, c.type])).toEqual(expect.arrayContaining([['info', 1]]));
    expect(printed.find((c) => c.name === 'info')).not.toHaveProperty('default_member_permissions');
    expect(printed.some((c) => c.name === 'Mod info')).toBe(false);
  });

  it('exits non-zero without the credentials, saying which are needed and nothing secret', () => {
    const result = run([], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DISCORD_APP_ID and DISCORD_BOT_TOKEN must both be set');
  });
});
