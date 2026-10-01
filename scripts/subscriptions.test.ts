// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  buildListSql,
  buildRemoveSql,
  buildSetEnabledSql,
  buildSetFilterSql,
  parseCli,
  planCommand,
} from './subscriptions.ts';

const SCHEMA = readFileSync(join(import.meta.dirname, '../schema.sql'), 'utf8');
const TOKEN = 'SECRETtoken_abc-123XYZ';
const HOOK = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function addSub(db: DatabaseSync, id: string, webhook = HOOK, filter = '{}', enabled = 1, threadId: string | null = null): void {
  db.prepare('INSERT INTO subscriptions (id, guild_id, webhook_url, thread_id, filter, mode, digest_interval_min, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    '123456789012345678',
    webhook,
    threadId,
    filter,
    'digest',
    30,
    enabled,
  );
}

function addOutbox(db: DatabaseSync, subscriptionId: string, eventId: string, opts: { delivered?: boolean; parked?: boolean } = {}): void {
  db.prepare('INSERT INTO outbox (id, subscription_id, event_id, attempts, next_attempt_at, parked, delivered_at) VALUES (?, ?, ?, 0, ?, ?, ?)').run(
    `${subscriptionId}:${eventId}`,
    subscriptionId,
    eventId,
    '2026-01-01T00:00:00.000Z',
    opts.parked ? 1 : 0,
    opts.delivered ? '2026-01-01T00:00:00.000Z' : null,
  );
}

const outboxIds = (db: DatabaseSync): string[] =>
  (db.prepare('SELECT id FROM outbox ORDER BY id').all() as { id: string }[]).map((r) => r.id);

describe('list SQL', () => {
  it('shows the columns an operator needs and a masked webhook, never the token', () => {
    const db = freshDb();
    addSub(db, 'main', HOOK, '{"kinds":["new"]}');
    addSub(db, 'other', 'https://discordapp.com/api/webhooks/987654321098765432/anotherTOKEN-9', '{}', 0);
    const rows = db.prepare(buildListSql()).all() as Record<string, unknown>[];
    expect(rows.map((r) => Object.keys(r))).toEqual([
      ['id', 'guild_id', 'mode', 'filter', 'enabled', 'thread_id', 'webhook'],
      ['id', 'guild_id', 'mode', 'filter', 'enabled', 'thread_id', 'webhook'],
    ]);
    expect(rows.map((r) => r.id)).toEqual(['main', 'other']);
    expect(rows[0]).toMatchObject({ mode: 'digest', filter: '{"kinds":["new"]}', enabled: 1, thread_id: null });
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(JSON.stringify(rows)).not.toContain('anotherTOKEN');
    expect(String(rows[0]!.webhook)).toContain('123456789012345678');
  });

  it('shows the thread id of a subscription that targets one, without disturbing the masked webhook', () => {
    const db = freshDb();
    addSub(db, 'threaded', HOOK, '{}', 1, '222233334444555566');
    const rows = db.prepare(buildListSql()).all() as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ thread_id: '222233334444555566' });
    expect(String(rows[0]!.webhook)).toContain('123456789012345678');
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it.each([
    ['a query string', `https://discord.com/api/webhooks/1/${TOKEN}?wait=true`],
    ['no webhook path', `https://example.test/${TOKEN}`],
    ['a trailing slash', `https://discord.com/api/webhooks/1/${TOKEN}/`],
    ['an empty string', ''],
    ['only the prefix', 'https://discord.com/api/webhooks/'],
    ['a doubled path', `https://discord.com/api/webhooks/api/webhooks/${TOKEN}`],
  ])('does not leak the token from a malformed URL with %s', (_label, webhook) => {
    const db = freshDb();
    addSub(db, 'odd', webhook);
    const rows = db.prepare(buildListSql()).all();
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it('is a single read-only statement', () => {
    expect(buildListSql()).toMatch(/^SELECT /);
    expect(buildListSql().match(/;/g)).toHaveLength(1);
  });
});

describe('enable / disable SQL', () => {
  it('flips only the named subscription', () => {
    const db = freshDb();
    addSub(db, 'a');
    addSub(db, 'b');
    db.exec(buildSetEnabledSql('a', false));
    expect(db.prepare('SELECT id, enabled FROM subscriptions ORDER BY id').all()).toEqual([
      { id: 'a', enabled: 0 },
      { id: 'b', enabled: 1 },
    ]);
    db.exec(buildSetEnabledSql('a', true));
    expect(db.prepare('SELECT enabled FROM subscriptions WHERE id = ?').get('a')).toEqual({ enabled: 1 });
  });

  it('cannot be escaped through the id', () => {
    const db = freshDb();
    addSub(db, 'a');
    db.exec(buildSetEnabledSql("x' OR '1'='1", false));
    expect(db.prepare('SELECT enabled FROM subscriptions').all()).toEqual([{ enabled: 1 }]);
  });
});

describe('remove SQL', () => {
  it('deletes the subscription and its pending outbox rows only', () => {
    const db = freshDb();
    addSub(db, 'gone');
    addSub(db, 'kept');
    addOutbox(db, 'gone', 'e1');
    addOutbox(db, 'gone', 'e2', { parked: true });
    addOutbox(db, 'gone', 'e3', { delivered: true });
    addOutbox(db, 'kept', 'e1');
    db.exec(buildRemoveSql('gone'));
    expect((db.prepare('SELECT id FROM subscriptions').all() as { id: string }[]).map((r) => r.id)).toEqual(['kept']);
    expect(outboxIds(db)).toEqual(['gone:e3', 'kept:e1']);
  });

  it('cannot be escaped through the id', () => {
    const db = freshDb();
    addSub(db, 'a');
    addOutbox(db, 'a', 'e1');
    db.exec(buildRemoveSql("x'; DELETE FROM subscriptions; --"));
    expect(db.prepare('SELECT id FROM subscriptions').all()).toHaveLength(1);
    expect(outboxIds(db)).toEqual(['a:e1']);
  });
});

describe('set-filter SQL', () => {
  it('replaces the filter of the named subscription only', () => {
    const db = freshDb();
    addSub(db, 'a', HOOK, '{"kinds":["new"]}');
    addSub(db, 'b', HOOK, '{"kinds":["new"]}');
    db.exec(buildSetFilterSql('a', { packages: ['Author-Mod'], kinds: ['update'] }));
    expect(db.prepare('SELECT id, filter FROM subscriptions ORDER BY id').all()).toEqual([
      { id: 'a', filter: '{"packages":["Author-Mod"],"kinds":["update"]}' },
      { id: 'b', filter: '{"kinds":["new"]}' },
    ]);
  });

  it('escapes quotes inside the filter', () => {
    const db = freshDb();
    addSub(db, 'a');
    db.exec(buildSetFilterSql('a', { packages: ["Bob's'; DROP TABLE subscriptions; --"] }));
    expect(JSON.parse((db.prepare('SELECT filter FROM subscriptions').get() as { filter: string }).filter)).toEqual({
      packages: ["Bob's'; DROP TABLE subscriptions; --"],
    });
  });
});

describe('parseCli', () => {
  it('reads the command, the id and the connection options', () => {
    expect(parseCli(['disable', '--id', 'main'])).toMatchObject({ command: 'disable', id: 'main', database: 'ratatoskr', local: false, sqlOnly: false });
    expect(parseCli(['--', 'enable', '--id', 'main', '--local', '--database', 'db', '--sql-only'])).toMatchObject({
      command: 'enable',
      id: 'main',
      database: 'db',
      local: true,
      sqlOnly: true,
    });
    expect(parseCli(['list']).command).toBe('list');
  });

  it.each([[[]], [['frobnicate']], [['list', 'extra']]])('rejects the arguments %j', (argv) => {
    expect(() => parseCli(argv)).toThrow();
  });

  it.each(['disable', 'enable', 'remove', 'set-filter'])('%s requires --id', (command) => {
    expect(() => parseCli([command, '--package', 'A'])).toThrow(/--id/);
  });

  it.each(['', 'a b', "a'b", 'a;b', '$(x)', 'x'.repeat(65), 'a/b'])('refuses the invalid id %j', (id) => {
    expect(() => parseCli(['remove', '--id', id])).toThrow(/--id/);
  });

  it('list takes no id or filter flags', () => {
    expect(() => parseCli(['list', '--id', 'a'])).toThrow(/list/);
    expect(() => parseCli(['list', '--package', 'A'])).toThrow(/list/);
  });

  it.each(['disable', 'enable', 'remove'])('%s takes no filter flags', (command) => {
    expect(() => parseCli([command, '--id', 'a', '--kind', 'new'])).toThrow(/set-filter/);
  });

  it('set-filter builds the filter from the same flags as add-subscription', () => {
    const cli = parseCli(['set-filter', '--id', 'a', '--package', 'Owner-Name', '--kind', 'update', '--exclude-package', 'Noisy']);
    expect(cli.filter).toEqual({ kinds: ['update'], packages: ['Owner-Name'], excludePackages: ['Noisy'] });
  });

  it('set-filter refuses to run without any filter, so a slip cannot wipe the filter', () => {
    expect(() => parseCli(['set-filter', '--id', 'a'])).toThrow(/at least one/);
  });

  it('set-filter accepts an explicit empty JSON filter and refuses mixing it with flags', () => {
    expect(parseCli(['set-filter', '--id', 'a', '--filter', '{}']).filter).toEqual({});
    expect(() => parseCli(['set-filter', '--id', 'a', '--filter', '{}', '--package', 'A'])).toThrow(/not both/);
  });
});

describe('planCommand', () => {
  it('prints wrangler commands for the remote database by default', () => {
    const plan = planCommand(parseCli(['disable', '--id', 'main']));
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.command).toBe('pnpm run wrangler d1 execute ratatoskr --remote --command "UPDATE subscriptions SET enabled = 0 WHERE id = \'main\';"');
  });

  it('honours --local, --database and --sql-only', () => {
    const local = planCommand(parseCli(['enable', '--id', 'main', '--local', '--database', 'other']));
    if (!local.ok) throw new Error('expected a plan');
    expect(local.command).toContain('wrangler d1 execute other --local --command');
    const sqlOnly = planCommand(parseCli(['enable', '--id', 'main', '--sql-only']));
    if (!sqlOnly.ok) throw new Error('expected a plan');
    expect(sqlOnly.command).toBe("UPDATE subscriptions SET enabled = 1 WHERE id = 'main';");
  });

  it('list prints a read-only wrangler command', () => {
    const plan = planCommand(parseCli(['list']));
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.command).toContain('wrangler d1 execute ratatoskr --remote --command "SELECT ');
    expect(plan.command).not.toMatch(/UPDATE|DELETE|INSERT/);
  });

  it('validates the filter of set-filter and reports every problem', () => {
    const plan = planCommand(parseCli(['set-filter', '--id', 'a', '--source', 'nope', '--package', ' ']));
    if (plan.ok) throw new Error('expected errors');
    expect(plan.errors.join(' | ')).toMatch(/filter\.sources\[0\]/);
    expect(plan.errors.join(' | ')).toMatch(/filter\.packages\[0\]/);
  });

  it('set-filter with valid input yields an UPDATE of the filter column', () => {
    const plan = planCommand(parseCli(['set-filter', '--id', 'a', '--package', 'Owner-Name', '--sql-only']));
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.command).toBe(`UPDATE subscriptions SET filter = '{"packages":["Owner-Name"]}' WHERE id = 'a';`);
  });
});
