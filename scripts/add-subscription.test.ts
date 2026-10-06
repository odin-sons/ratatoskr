// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildInsertSql,
  buildWranglerCommand,
  parseCli,
  planSubscription,
  shellDoubleQuote,
  sqlString,
} from './add-subscription.ts';
import type { WebhookSubscription } from '../src/core/types.ts';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abc_DEF-123';

function sub(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 'sub-1',
    guildId: '123456789012345678',
    webhookUrl: WEBHOOK,
    filter: {},
    mode: 'digest',
    digestIntervalMin: 30,
    enabled: true,
    ...overrides,
  };
}

describe('sqlString', () => {
  it('wraps in single quotes and doubles embedded quotes', () => {
    expect(sqlString('abc')).toBe("'abc'");
    expect(sqlString("O'Brien")).toBe("'O''Brien'");
    expect(sqlString("''")).toBe("''''''");
  });

  it('leaves backslashes and double quotes untouched', () => {
    expect(sqlString('a\\b"c')).toBe("'a\\b\"c'");
  });
});

describe('buildInsertSql', () => {
  it('produces the expected statement', () => {
    expect(buildInsertSql(sub({ filter: { allowNsfw: true } }))).toBe(
      `INSERT INTO subscriptions (id, guild_id, webhook_url, thread_id, filter, mode, digest_interval_min, enabled) VALUES ('sub-1', '123456789012345678', '${WEBHOOK}', NULL, '{"allowNsfw":true}', 'digest', 30, 1);`,
    );
  });

  it('quotes a thread id when one is set', () => {
    expect(buildInsertSql(sub({ threadId: '222233334444555566' }))).toContain(`'${WEBHOOK}', '222233334444555566', '{}'`);
  });

  it('escapes single quotes inside filter JSON', () => {
    const sql = buildInsertSql(
      sub({ filter: { watchlist: ["Bob's-Mod'; DROP TABLE subscriptions;--"] } }),
    );
    expect(sql).toContain(`'{"watchlist":["Bob''s-Mod''; DROP TABLE subscriptions;--"]}'`);
  });
});

describe('shellDoubleQuote', () => {
  it('escapes characters special inside double quotes', () => {
    expect(shellDoubleQuote('a"b$c`d\\e')).toBe('"a\\"b\\$c\\`d\\\\e"');
  });
});

describe('buildWranglerCommand', () => {
  it('targets remote by default and local on request', () => {
    expect(buildWranglerCommand('SELECT 1;', 'ratatoskr', false)).toBe(
      'pnpm run wrangler d1 execute ratatoskr --remote --command "SELECT 1;"',
    );
    expect(buildWranglerCommand('SELECT 1;', 'db', true)).toContain('--local');
  });
});

beforeEach(() => vi.stubEnv('D1_DATABASE_NAME', ''));
afterEach(() => vi.unstubAllEnvs());

describe('parseCli', () => {
  it('defaults --database to ratatoskr, or to D1_DATABASE_NAME when set, and lets the flag win', () => {
    const args = ['--guild-id', '1', '--webhook-url', WEBHOOK];
    expect(parseCli(args, {}).database).toBe('ratatoskr');
    vi.stubEnv('D1_DATABASE_NAME', 'ratatoskr-skyrim');
    expect(parseCli(args, {}).database).toBe('ratatoskr-skyrim');
    expect(parseCli([...args, '--database', 'other'], {}).database).toBe('other');
  });

  it('refuses a --database that is not a plain database name, since it is printed into a shell command', () => {
    const args = ['--guild-id', '1', '--webhook-url', WEBHOOK];
    for (const bad of ['x; rm -rf ~', '$(id)', 'my db', '-flag', '../db']) {
      expect(() => parseCli([...args, '--database', bad], {}), bad).toThrow('--database');
    }
    vi.stubEnv('D1_DATABASE_NAME', 'bad name');
    expect(() => parseCli(args, {})).toThrow('--database');
  });

  it('reads the webhook URL from an environment variable', () => {
    const o = parseCli(['--guild-id', '1', '--webhook-url-env', 'HOOK'], { HOOK: WEBHOOK });
    expect(o.webhookUrl).toBe(WEBHOOK);
    expect(o.mode).toBe('digest');
    expect(o.interval).toBe(30);
    expect(o.filter).toEqual({});
  });

  it('parses a JSON filter', () => {
    const o = parseCli(['--filter', '{"allowNsfw":true}'], {});
    expect(o.filter).toEqual({ allowNsfw: true });
  });

  it('rejects an unset environment variable', () => {
    expect(() => parseCli(['--webhook-url-env', 'MISSING'], {})).toThrow(/MISSING/);
  });

  it('rejects conflicting webhook flags and invalid filter JSON', () => {
    expect(() => parseCli(['--webhook-url', 'x', '--webhook-url-env', 'H'], {})).toThrow();
    expect(() => parseCli(['--filter', '{'], {})).toThrow(/valid JSON/);
  });
});

describe('parseCli --id', () => {
  it('defaults to no id so a random one is generated', () => {
    expect(parseCli([], {}).id).toBeUndefined();
  });

  it.each(['main', 'hexium-channel', 'Author_Mods', 'x'.repeat(64)])('accepts %s', (id) => {
    expect(parseCli(['--id', id], {}).id).toBe(id);
  });

  it.each(['', 'a b', "a'b", 'a;b', 'a"b', '$(x)', 'x'.repeat(65), 'a/b', 'ä'])('rejects %j', (id) => {
    expect(() => parseCli(['--id', id], {})).toThrow(/--id/);
  });
});

describe('parseCli --thread-id', () => {
  it('accepts a numeric snowflake', () => {
    expect(parseCli(['--thread-id', '222233334444555566'], {}).threadId).toBe('222233334444555566');
  });

  it('defaults to no thread id, delivering to the webhook\'s own channel', () => {
    expect(parseCli([], {}).threadId).toBeUndefined();
  });

  it.each(['', 'abc', '123', '1'.repeat(21), '12345678901234567 ', '-12345678901234567'])('rejects %j', (threadId) => {
    expect(() => parseCli(['--thread-id', threadId], {})).toThrow(/--thread-id/);
  });
});

describe('parseCli filter flags', () => {
  it('builds the filter from repeatable flags', () => {
    const o = parseCli(
      [
        '--source', 'hexium:valheim', '--source', 'nexus:valheim',
        '--kind', 'update',
        '--package', 'Owner-Name', '--package', 'Owner',
        '--exclude-package', 'Noisy-Mod',
        '--category', 'Tweaks', '--exclude-category', 'Cosmetics',
        '--allow-nsfw',
      ],
      {},
    );
    expect(o.filter).toEqual({
      sources: ['hexium:valheim', 'nexus:valheim'],
      kinds: ['update'],
      packages: ['Owner-Name', 'Owner'],
      excludePackages: ['Noisy-Mod'],
      includeCategories: ['Tweaks'],
      excludeCategories: ['Cosmetics'],
      allowNsfw: true,
    });
  });

  it('still accepts raw JSON on its own', () => {
    expect(parseCli(['--filter', '{"kinds":["new"]}'], {}).filter).toEqual({ kinds: ['new'] });
  });

  it('refuses to combine raw JSON with the filter flags', () => {
    expect(() => parseCli(['--filter', '{}', '--package', 'A'], {})).toThrow(/--package/);
    expect(() => parseCli(['--filter-file', 'f.json', '--allow-nsfw'], {})).toThrow(/--allow-nsfw/);
    expect(() => parseCli(['--filter', '{}', '--filter-file', 'f.json'], {})).toThrow(/not both/);
  });

  it('rejects an unknown kind', () => {
    expect(() => parseCli(['--kind', 'delete'], {})).toThrow(/--kind/);
  });
});

describe('planSubscription', () => {
  const opts = (argv: string[]) => parseCli(['--guild-id', '123456789012345678', '--webhook-url-env', 'HOOK', ...argv], { HOOK: WEBHOOK });
  const newId = () => 'generated-id';

  it('uses the given id, or a generated one', () => {
    const named = planSubscription(opts(['--id', 'one-mod']), newId);
    expect(named.ok && named.subscription.id).toBe('one-mod');
    const anon = planSubscription(opts([]), newId);
    expect(anon.ok && anon.subscription.id).toBe('generated-id');
  });

  it('emits a plain INSERT so a duplicate id fails instead of replacing', () => {
    const plan = planSubscription(opts(['--id', 'one-mod', '--package', 'Owner-Name', '--kind', 'update']), newId);
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.sql).toMatch(/^INSERT INTO subscriptions /);
    expect(plan.sql).not.toMatch(/OR REPLACE|OR IGNORE|ON CONFLICT|UPSERT/i);
    expect(plan.sql).toContain(`'one-mod'`);
    expect(plan.sql).toContain(`'{"kinds":["update"],"packages":["Owner-Name"]}'`);
  });

  it('escapes quotes in package names inside the SQL and the shell command', () => {
    const plan = planSubscription(opts(['--package', "Bob's-Mod'; DROP TABLE subscriptions;--"]), newId);
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.sql).toContain(`"Bob''s-Mod''; DROP TABLE subscriptions;--"`);
    const command = buildWranglerCommand(plan.sql, 'ratatoskr', false);
    expect(command.startsWith('pnpm run wrangler d1 execute ratatoskr --remote --command "INSERT INTO')).toBe(true);
  });

  it('reports invalid filter values without echoing the webhook URL', () => {
    const plan = planSubscription(opts(['--source', 'nope', '--package', ' ']), newId);
    if (plan.ok) throw new Error('expected errors');
    const text = plan.errors.join(' | ');
    expect(text).toMatch(/filter\.sources\[0\]/);
    expect(text).toMatch(/filter\.packages\[0\]/);
    expect(text).not.toContain(WEBHOOK);
  });

  it('carries the thread id into the subscription and the SQL when given', () => {
    const plan = planSubscription(opts(['--thread-id', '222233334444555566']), newId);
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.subscription.webhookUrl).toBe(WEBHOOK);
    expect(plan.subscription.threadId).toBe('222233334444555566');
    expect(plan.sql).toContain(`'${WEBHOOK}', '222233334444555566'`);
  });

  it('stores a NULL thread id when none is given', () => {
    const plan = planSubscription(opts([]), newId);
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.subscription.threadId).toBeNull();
    expect(plan.sql).toContain(`'${WEBHOOK}', NULL`);
  });

  it('reports a bad webhook URL without echoing it', () => {
    const plan = planSubscription(parseCli(['--guild-id', '123456789012345678', '--webhook-url', 'https://evil.example/x'], {}), newId);
    if (plan.ok) throw new Error('expected errors');
    const text = plan.errors.join(' | ');
    expect(text).toMatch(/webhookUrl/);
    expect(text).not.toContain('evil.example');
  });
});
