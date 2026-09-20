// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventId, outboxId } from '../core/ids.ts';
import { D1Store } from './d1-store.ts';
import { D1Shim } from './testing/d1-shim.ts';

const ROOT = join(import.meta.dirname, '../..');
const SCHEMA = readFileSync(join(ROOT, 'schema.sql'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'migrations/0001_outbox_delivered_at.sql'), 'utf8');

const SOURCE = 'thunderstore:valheim';
const NOW = '2026-09-19T12:00:00.000Z';

/** Database shape before `outbox.delivered_at` existed. */
const SCHEMA_BEFORE_DELIVERED_AT = `
CREATE TABLE sources (id TEXT PRIMARY KEY, cursor TEXT, etag TEXT, bootstrapped INTEGER NOT NULL DEFAULT 0, last_ok_at TEXT);
CREATE TABLE packages (
  source TEXT NOT NULL, package_id TEXT NOT NULL, store TEXT NOT NULL, latest_version TEXT NOT NULL, name TEXT NOT NULL,
  owner TEXT NOT NULL, url TEXT NOT NULL, icon_url TEXT, description TEXT, categories TEXT NOT NULL DEFAULT '[]',
  size_bytes INTEGER, is_nsfw INTEGER NOT NULL DEFAULT 0, is_deprecated INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (source, package_id)
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, package_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('new', 'update')),
  version_from TEXT, version_to TEXT NOT NULL, changelog TEXT, changelog_url TEXT, release_key TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_events_created ON events (created_at);
CREATE INDEX idx_events_release ON events (release_key, created_at);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, webhook_url TEXT NOT NULL, filter TEXT NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'digest' CHECK (mode IN ('immediate', 'digest')), digest_interval_min INTEGER, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_subscriptions_enabled ON subscriptions (enabled);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, event_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, parked INTEGER NOT NULL DEFAULT 0, UNIQUE (subscription_id, event_id)
);
CREATE INDEX idx_outbox_due ON outbox (next_attempt_at) WHERE parked = 0;
`;

function legacyDatabase(): D1Shim {
  const shim = new D1Shim();
  shim.db.exec(SCHEMA_BEFORE_DELIVERED_AT);
  const id = eventId(SOURCE, 'Owner-Mod', '1.0.0');
  shim.db
    .prepare('INSERT INTO packages (source, package_id, store, latest_version, name, owner, url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(SOURCE, 'Owner-Mod', 'thunderstore', '1.0.0', 'Mod', 'Owner', 'https://thunderstore.invalid/Owner/Mod/', NOW);
  shim.db
    .prepare('INSERT INTO events (id, source, package_id, kind, version_to, release_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, SOURCE, 'Owner-Mod', 'new', '1.0.0', 'owner|mod|1.0.0', NOW);
  shim.db
    .prepare('INSERT INTO subscriptions (id, guild_id, webhook_url, filter, mode, digest_interval_min, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('sub1', 'g', 'https://discord.invalid/api/webhooks/1/tok', '{}', 'immediate', null, 1);
  shim.db
    .prepare('INSERT INTO outbox (id, subscription_id, event_id, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?)')
    .run(outboxId('sub1', id), 'sub1', id, 2, NOW);
  return shim;
}

const indexNames = (shim: D1Shim): string[] =>
  (shim.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);

describe('schema upgrade from a database without outbox.delivered_at', () => {
  it('schema.sql alone cannot upgrade it', () => {
    expect(() => legacyDatabase().db.exec(SCHEMA)).toThrow(/delivered_at/);
  });

  it('the migration adds the column and both partial indexes, then schema.sql applies cleanly, twice', () => {
    const shim = legacyDatabase();
    shim.db.exec(MIGRATION);
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    const names = indexNames(shim);
    expect(names).toEqual(expect.arrayContaining(['idx_outbox_pending', 'idx_outbox_delivered', 'idx_events_release']));
    expect(names).not.toContain('idx_outbox_due');
    expect(names).not.toContain('idx_events_created');
  });

  it('keeps pending rows and lets the current queries work on the upgraded database', async () => {
    const shim = legacyDatabase();
    shim.db.exec(MIGRATION);
    shim.db.exec(SCHEMA);
    const store = new D1Store(shim.asD1());

    const [due] = await store.takeDue(NOW, 10);
    expect(due!.row).toMatchObject({ subscriptionId: 'sub1', attempts: 2 });

    await store.markDelivered([due!.row.id], NOW);
    expect(await store.takeDue(NOW, 10)).toEqual([]);
    expect(await store.purgeDelivered('2026-09-20T00:00:00.000Z', 10)).toBe(1);
  });

  it('a fresh install needs no migration', () => {
    const shim = new D1Shim();
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
  });
});
