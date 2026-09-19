// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  buildInsertSql,
  buildWranglerCommand,
  parseCli,
  shellDoubleQuote,
  sqlString,
} from './add-subscription.ts';
import type { Subscription } from '../src/core/types.ts';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abc_DEF-123';

function sub(overrides: Partial<Subscription> = {}): Subscription {
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
      `INSERT INTO subscriptions (id, guild_id, webhook_url, filter, mode, digest_interval_min, enabled) VALUES ('sub-1', '123456789012345678', '${WEBHOOK}', '{"allowNsfw":true}', 'digest', 30, 1);`,
    );
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
      'wrangler d1 execute ratatoskr --remote --command "SELECT 1;"',
    );
    expect(buildWranglerCommand('SELECT 1;', 'db', true)).toContain('--local');
  });
});

describe('parseCli', () => {
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
