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
const MIGRATION_DOWNLOAD_URL = readFileSync(join(ROOT, 'migrations/0002_package_download_url_and_downloads.sql'), 'utf8');
const MIGRATION_LIKES_WEBSITE = readFileSync(join(ROOT, 'migrations/0003_package_likes_and_website.sql'), 'utf8');

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
    shim.db.exec(MIGRATION_DOWNLOAD_URL);
    shim.db.exec(MIGRATION_LIKES_WEBSITE);
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

/** Database shape before `packages.download_url` and `packages.downloads` existed: the current schema without those columns. */
const SCHEMA_BEFORE_DOWNLOAD_URL = SCHEMA.replace('  download_url TEXT,\n', '').replace('  downloads INTEGER,\n', '');

function databaseWithoutDownloadUrl(): D1Shim {
  const shim = new D1Shim();
  shim.db.exec(SCHEMA_BEFORE_DOWNLOAD_URL);
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
    .run(outboxId('sub1', id), 'sub1', id, 0, NOW);
  return shim;
}

describe('schema upgrade from a database without packages.download_url and packages.downloads', () => {
  it('the fixture really lacks the column and the current queries fail on it', async () => {
    expect(SCHEMA_BEFORE_DOWNLOAD_URL).not.toMatch(/^ +download_url TEXT/m);
    expect(SCHEMA_BEFORE_DOWNLOAD_URL).not.toMatch(/^ +downloads INTEGER/m);
    await expect(new D1Store(databaseWithoutDownloadUrl().asD1()).takeDue(NOW, 10)).rejects.toThrow(/download_url/);
  });

  it('the migration adds both nullable columns, keeps the data, and the current queries then work', async () => {
    const shim = databaseWithoutDownloadUrl();
    shim.db.exec(MIGRATION_DOWNLOAD_URL);
    const downloads = shim.db.prepare("SELECT \"notnull\" AS required, type FROM pragma_table_info('packages') WHERE name = 'downloads'").get();
    expect(downloads).toEqual({ required: 0, type: 'INTEGER' });
    const column = (shim.db.prepare("SELECT \"notnull\" AS required FROM pragma_table_info('packages') WHERE name = 'download_url'").get() as { required: number } | undefined);
    expect(column).toEqual({ required: 0 });
    const store = new D1Store(shim.asD1());
    const [due] = await store.takeDue(NOW, 10);
    expect(due!.event.pkg).toMatchObject({ packageId: 'Owner-Mod', downloadUrl: null, downloads: null });
    await store.commit({
      source: SOURCE,
      packages: [{ ...due!.event.pkg, version: '1.1.0', downloadUrl: 'https://cdn.invalid/mod.zip', downloads: 12 }],
      events: [],
      outbox: [],
      state: { id: SOURCE, cursor: null, etag: null, bootstrapped: true, lastOkAt: null },
    });
    expect((await store.takeDue(NOW, 10))[0]!.event.pkg).toMatchObject({ downloadUrl: 'https://cdn.invalid/mod.zip', downloads: 12 });
  });

  it('applies schema.sql cleanly afterwards, twice, and cannot be applied a second time itself', () => {
    const shim = databaseWithoutDownloadUrl();
    shim.db.exec(MIGRATION_DOWNLOAD_URL);
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    expect(() => shim.db.exec(MIGRATION_DOWNLOAD_URL)).toThrow(/duplicate column/);
  });
});

/** Database shape before `packages.likes` and `packages.website_url` existed: the current schema without those columns. */
const SCHEMA_BEFORE_LIKES = SCHEMA.replace('  likes INTEGER,\n', '').replace('  website_url TEXT,\n', '');

function databaseWithoutLikes(): D1Shim {
  const shim = new D1Shim();
  shim.db.exec(SCHEMA_BEFORE_LIKES);
  const id = eventId(SOURCE, 'Owner-Mod', '1.0.0');
  shim.db
    .prepare('INSERT INTO packages (source, package_id, store, latest_version, name, owner, url, downloads, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(SOURCE, 'Owner-Mod', 'thunderstore', '1.0.0', 'Mod', 'Owner', 'https://thunderstore.invalid/Owner/Mod/', 7, NOW);
  shim.db
    .prepare('INSERT INTO events (id, source, package_id, kind, version_to, release_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, SOURCE, 'Owner-Mod', 'new', '1.0.0', 'owner|mod|1.0.0', NOW);
  shim.db
    .prepare('INSERT INTO subscriptions (id, guild_id, webhook_url, filter, mode, digest_interval_min, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('sub1', 'g', 'https://discord.invalid/api/webhooks/1/tok', '{}', 'immediate', null, 1);
  shim.db
    .prepare('INSERT INTO outbox (id, subscription_id, event_id, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?)')
    .run(outboxId('sub1', id), 'sub1', id, 0, NOW);
  return shim;
}

describe('schema upgrade from a database without packages.likes and packages.website_url', () => {
  it('the fixture really lacks both columns and the current queries fail on it', async () => {
    expect(SCHEMA_BEFORE_LIKES).not.toMatch(/^ +likes INTEGER/m);
    expect(SCHEMA_BEFORE_LIKES).not.toMatch(/^ +website_url TEXT/m);
    await expect(new D1Store(databaseWithoutLikes().asD1()).takeDue(NOW, 10)).rejects.toThrow(/likes|website_url/);
  });

  it('the migration adds both nullable columns, keeps the data, and the current queries then work', async () => {
    const shim = databaseWithoutLikes();
    shim.db.exec(MIGRATION_LIKES_WEBSITE);
    const info = (name: string) => shim.db.prepare('SELECT "notnull" AS required, type FROM pragma_table_info(\'packages\') WHERE name = ?').get(name);
    expect(info('likes')).toEqual({ required: 0, type: 'INTEGER' });
    expect(info('website_url')).toEqual({ required: 0, type: 'TEXT' });

    const store = new D1Store(shim.asD1());
    const [due] = await store.takeDue(NOW, 10);
    expect(due!.event.pkg).toMatchObject({ packageId: 'Owner-Mod', downloads: 7, likes: null, websiteUrl: null });

    await store.commit({
      source: SOURCE,
      packages: [{ ...due!.event.pkg, version: '1.1.0', likes: 12, websiteUrl: 'https://site.invalid/' }],
      events: [],
      outbox: [],
      state: { id: SOURCE, cursor: null, etag: null, bootstrapped: true, lastOkAt: null },
    });
    expect((await store.takeDue(NOW, 10))[0]!.event.pkg).toMatchObject({ downloads: 7, likes: 12, websiteUrl: 'https://site.invalid/' });

    await store.setEventDetails(due!.event.id, { changelog: 'n', changelogUrl: null, websiteUrl: 'https://later.invalid/' });
    expect((await store.takeDue(NOW, 10))[0]!.event.pkg.websiteUrl).toBe('https://later.invalid/');
  });

  it('applies schema.sql cleanly afterwards, twice, and cannot be applied a second time itself', () => {
    const shim = databaseWithoutLikes();
    shim.db.exec(MIGRATION_LIKES_WEBSITE);
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    expect(() => shim.db.exec(MIGRATION_LIKES_WEBSITE)).toThrow(/duplicate column/);
  });

  it('applies to a database whose columns arrived through every earlier migration, in order', async () => {
    const shim = legacyDatabase();
    for (const migration of [MIGRATION, MIGRATION_DOWNLOAD_URL, MIGRATION_LIKES_WEBSITE]) shim.db.exec(migration);
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    const columns = (shim.db.prepare("SELECT name FROM pragma_table_info('packages')").all() as { name: string }[]).map((r) => r.name);
    expect(columns).toEqual(expect.arrayContaining(['download_url', 'downloads', 'likes', 'website_url']));
    expect((await new D1Store(shim.asD1()).takeDue(NOW, 10))[0]!.event.pkg).toMatchObject({ likes: null, websiteUrl: null });
  });
});
