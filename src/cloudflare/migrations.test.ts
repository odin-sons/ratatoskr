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
const MIGRATION_THREAD_ID = readFileSync(join(ROOT, 'migrations/0004_subscription_thread_id.sql'), 'utf8');
const MIGRATION_BOT = readFileSync(join(ROOT, 'migrations/0005_bot_subscriptions.sql'), 'utf8');
const MIGRATION_CHANNEL_KIND = readFileSync(join(ROOT, 'migrations/0006_subscription_channel_kind.sql'), 'utf8');
const MIGRATION_TEMPLATES = readFileSync(join(ROOT, 'migrations/0008_templates.sql'), 'utf8');

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
    expect(() => legacyDatabase().db.exec(SCHEMA)).toThrow(/delivered_at|channel_id/);
  });

  it('the migration adds the column and both partial indexes, then schema.sql applies cleanly, twice', () => {
    const shim = legacyDatabase();
    for (const migration of [MIGRATION, MIGRATION_THREAD_ID, MIGRATION_BOT, MIGRATION_CHANNEL_KIND, MIGRATION_TEMPLATES]) shim.db.exec(migration);
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
    shim.db.exec(MIGRATION_THREAD_ID);
    shim.db.exec(MIGRATION_BOT);
    shim.db.exec(MIGRATION_CHANNEL_KIND);
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
    for (const migration of [MIGRATION, MIGRATION_DOWNLOAD_URL, MIGRATION_LIKES_WEBSITE, MIGRATION_THREAD_ID, MIGRATION_BOT, MIGRATION_CHANNEL_KIND]) shim.db.exec(migration);
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    const columns = (shim.db.prepare("SELECT name FROM pragma_table_info('packages')").all() as { name: string }[]).map((r) => r.name);
    expect(columns).toEqual(expect.arrayContaining(['download_url', 'downloads', 'likes', 'website_url']));
    expect((await new D1Store(shim.asD1()).takeDue(NOW, 10))[0]!.event.pkg).toMatchObject({ likes: null, websiteUrl: null });
  });
});

/** Database shape before `subscriptions.thread_id` existed: the current schema without that column. */
const SCHEMA_BEFORE_THREAD_ID = SCHEMA.replace('  thread_id TEXT,\n', '');

function databaseWithoutThreadId(): D1Shim {
  const shim = new D1Shim();
  shim.db.exec(SCHEMA_BEFORE_THREAD_ID);
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

describe('schema upgrade from a database without subscriptions.thread_id', () => {
  it('the fixture really lacks the column and the current queries fail on it', async () => {
    expect(SCHEMA_BEFORE_THREAD_ID).not.toMatch(/^ +thread_id TEXT,$/m);
    await expect(new D1Store(databaseWithoutThreadId().asD1()).takeDue(NOW, 10)).rejects.toThrow(/thread_id/);
  });

  it('the migration adds the nullable column, keeps the data, and the current queries then work', async () => {
    const shim = databaseWithoutThreadId();
    shim.db.exec(MIGRATION_THREAD_ID);
    const column = shim.db.prepare("SELECT \"notnull\" AS required, type FROM pragma_table_info('subscriptions') WHERE name = 'thread_id'").get();
    expect(column).toEqual({ required: 0, type: 'TEXT' });

    const store = new D1Store(shim.asD1());
    const [due] = await store.takeDue(NOW, 10);
    expect(due!.subscription).toMatchObject({ id: 'sub1', threadId: null });
  });

  it('applies schema.sql cleanly afterwards, twice, and cannot be applied a second time itself', () => {
    const shim = databaseWithoutThreadId();
    shim.db.exec(MIGRATION_THREAD_ID);
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    expect(() => shim.db.exec(MIGRATION_THREAD_ID)).toThrow(/duplicate column/);
  });
});

/** Database shape before the bot columns existed: the current schema with the pre-0005 `subscriptions` table. */
const SCHEMA_BEFORE_BOT = SCHEMA.replace(
  /CREATE TABLE IF NOT EXISTS subscriptions \([\s\S]*?\n\);\nCREATE INDEX IF NOT EXISTS idx_subscriptions_enabled[^\n]*\nCREATE INDEX IF NOT EXISTS idx_subscriptions_channel[^\n]*\nCREATE INDEX IF NOT EXISTS idx_subscriptions_guild[^\n]*\n/,
  `CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  thread_id TEXT,
  filter TEXT NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'digest' CHECK (mode IN ('immediate', 'digest')),
  digest_interval_min INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_enabled ON subscriptions (enabled);
`,
);

function databaseBeforeBot(): D1Shim {
  const shim = new D1Shim();
  shim.db.exec(SCHEMA_BEFORE_BOT);
  const id = eventId(SOURCE, 'Owner-Mod', '1.0.0');
  shim.db
    .prepare('INSERT INTO packages (source, package_id, store, latest_version, name, owner, url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(SOURCE, 'Owner-Mod', 'thunderstore', '1.0.0', 'Mod', 'Owner', 'https://thunderstore.invalid/Owner/Mod/', NOW);
  shim.db
    .prepare('INSERT INTO events (id, source, package_id, kind, version_to, release_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, SOURCE, 'Owner-Mod', 'new', '1.0.0', 'owner|mod|1.0.0', NOW);
  shim.db
    .prepare('INSERT INTO subscriptions (id, guild_id, webhook_url, thread_id, filter, mode, digest_interval_min, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('sub1', 'g', 'https://discord.invalid/api/webhooks/1/tok', '222233334444555566', '{"kinds":["new"]}', 'immediate', null, 1);
  shim.db
    .prepare('INSERT INTO subscriptions (id, guild_id, webhook_url, filter, mode, digest_interval_min, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('off', 'g', 'https://discord.invalid/api/webhooks/2/tok', '{}', 'digest', 15, 0);
  shim.db
    .prepare('INSERT INTO outbox (id, subscription_id, event_id, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?)')
    .run(outboxId('sub1', id), 'sub1', id, 1, NOW);
  return shim;
}

describe('schema upgrade from a database without the bot columns of subscriptions', () => {
  it('the fixture really lacks the bot columns and the current queries fail on it', async () => {
    expect(SCHEMA_BEFORE_BOT).not.toMatch(/channel_id TEXT,$/m);
    expect(SCHEMA_BEFORE_BOT).not.toMatch(/paused_until/);
    await expect(new D1Store(databaseBeforeBot().asD1()).takeDue(NOW, 10)).rejects.toThrow(/transport|channel_id|paused_until/);
  });

  it('adds the bot columns with their defaults and keeps every existing row, filter and queued delivery', async () => {
    const shim = databaseBeforeBot();
    shim.db.exec(MIGRATION_BOT);
    const info = (name: string) =>
      shim.db.prepare("SELECT \"notnull\" AS required, dflt_value AS dflt FROM pragma_table_info('subscriptions') WHERE name = ?").get(name);
    expect(info('webhook_url')).toEqual({ required: 0, dflt: null });
    expect(info('transport')).toEqual({ required: 1, dflt: "'webhook'" });
    expect(info('thread_per_mod')).toEqual({ required: 1, dflt: '0' });
    expect(info('paused_until')).toEqual({ required: 1, dflt: '0' });
    for (const column of ['channel_id', 'label', 'created_by']) expect(info(column)).toEqual({ required: 0, dflt: null });
    shim.db.exec(MIGRATION_CHANNEL_KIND);

    const store = new D1Store(shim.asD1());
    const [due] = await store.takeDue(NOW, 10);
    expect(due!.row).toMatchObject({ subscriptionId: 'sub1', attempts: 1 });
    expect(due!.subscription).toEqual({
      id: 'sub1',
      guildId: 'g',
      transport: 'webhook',
      webhookUrl: 'https://discord.invalid/api/webhooks/1/tok',
      channelId: null,
      threadId: '222233334444555566',
      label: null,
      createdBy: null,
      threadPerMod: false,
      pausedUntil: 0,
      channelKind: 'text',
      filter: { kinds: ['new'] },
      mode: 'immediate',
      digestIntervalMin: 30,
      enabled: true,
    });
    expect((await store.listSubscriptions()).map((s) => s.id)).toEqual(['sub1']);
    expect((await store.listSubscriptionsByGuild('g')).map((s) => s.id).sort()).toEqual(['off', 'sub1']);
  });

  it('accepts a bot subscription without a webhook afterwards and rejects a row with neither destination', async () => {
    const shim = databaseBeforeBot();
    shim.db.exec(MIGRATION_BOT);
    shim.db.exec(MIGRATION_CHANNEL_KIND);
    const store = new D1Store(shim.asD1());
    await store.createSubscription({ id: 'bot1', guildId: 'g', transport: 'bot', channelId: 'c1', filter: {}, mode: 'digest', digestIntervalMin: 30, enabled: true });
    expect((await store.listSubscriptionsByChannel('c1')).map((s) => s.id)).toEqual(['bot1']);
    expect(() => shim.db.prepare("INSERT INTO subscriptions (id, guild_id, transport) VALUES ('x', 'g', 'bot')").run()).toThrow(/CHECK/);
    expect(() => shim.db.prepare("INSERT INTO subscriptions (id, guild_id) VALUES ('y', 'g')").run()).toThrow(/CHECK/);
  });

  it('applies schema.sql cleanly afterwards, twice, and leaves the new tables and indexes in place', () => {
    const shim = databaseBeforeBot();
    shim.db.exec(MIGRATION_BOT);
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    expect(indexNames(shim)).toEqual(
      expect.arrayContaining(['idx_subscriptions_enabled', 'idx_subscriptions_channel', 'idx_subscriptions_guild', 'idx_packages_owner', 'idx_packages_name']),
    );
    const tables = (shim.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['mod_threads']));
    expect(tables).not.toContain('messages');
    expect(tables).not.toContain('subscriptions_new');
  });

  it('applies to a database upgraded through every earlier migration, in order', async () => {
    const shim = legacyDatabase();
    for (const migration of [MIGRATION, MIGRATION_DOWNLOAD_URL, MIGRATION_LIKES_WEBSITE, MIGRATION_THREAD_ID, MIGRATION_BOT, MIGRATION_CHANNEL_KIND]) shim.db.exec(migration);
    shim.db.exec(SCHEMA);
    const [due] = await new D1Store(shim.asD1()).takeDue(NOW, 10);
    expect(due!.subscription).toMatchObject({ id: 'sub1', transport: 'webhook', pausedUntil: 0, threadPerMod: false });
  });
});

describe('schema upgrade from a database without subscriptions.channel_kind', () => {
  const SCHEMA_BEFORE_CHANNEL_KIND = SCHEMA.replace(/ {2}channel_kind TEXT[^\n]*\n/, '');

  function databaseBeforeChannelKind(): D1Shim {
    const shim = new D1Shim();
    shim.db.exec(SCHEMA_BEFORE_CHANNEL_KIND);
    shim.db
      .prepare("INSERT INTO subscriptions (id, guild_id, transport, channel_id, mode) VALUES ('bot1', 'g', 'bot', 'c1', 'immediate')")
      .run();
    return shim;
  }

  it('the fixture really lacks the column and the current queries fail on it', async () => {
    expect(SCHEMA_BEFORE_CHANNEL_KIND).not.toMatch(/^ +channel_kind TEXT/m);
    await expect(new D1Store(databaseBeforeChannelKind().asD1()).listSubscriptions()).rejects.toThrow(/channel_kind/);
  });

  it('adds the column as text for every existing row, accepts forum and rejects other values', async () => {
    const shim = databaseBeforeChannelKind();
    shim.db.exec(MIGRATION_CHANNEL_KIND);
    const store = new D1Store(shim.asD1());
    expect((await store.listSubscriptions()).map((s) => s.channelKind)).toEqual(['text']);
    await store.createSubscription({ id: 'bot2', guildId: 'g', transport: 'bot', channelId: 'c2', channelKind: 'forum', filter: {}, mode: 'immediate', digestIntervalMin: 30, enabled: true });
    expect((await store.listSubscriptionsByChannel('c2'))[0]!.channelKind).toBe('forum');
    expect(() => shim.db.prepare("UPDATE subscriptions SET channel_kind = 'voice' WHERE id = 'bot1'").run()).toThrow(/CHECK/);
  });

  it('is not repeatable, and schema.sql applies cleanly afterwards, twice', () => {
    const shim = databaseBeforeChannelKind();
    shim.db.exec(MIGRATION_CHANNEL_KIND);
    expect(() => shim.db.exec(MIGRATION_CHANNEL_KIND)).toThrow(/duplicate column/);
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
  });
});

describe('schema upgrade from a database without the templates table', () => {
  const SCHEMA_BEFORE_TEMPLATES = SCHEMA.replace(/-- Message templates of a subscription[\s\S]*?WITHOUT ROWID;/, '');

  function databaseBeforeTemplates(): D1Shim {
    const shim = new D1Shim();
    shim.db.exec(SCHEMA_BEFORE_TEMPLATES);
    shim.db.prepare("INSERT INTO subscriptions (id, guild_id, transport, channel_id, mode) VALUES ('bot1', 'g', 'bot', 'c1', 'immediate')").run();
    return shim;
  }

  it('the fixture really lacks the table and the store fails on it', async () => {
    expect(SCHEMA_BEFORE_TEMPLATES).not.toContain('CREATE TABLE IF NOT EXISTS templates');
    await expect(new D1Store(databaseBeforeTemplates().asD1()).getTemplates(['bot1'])).rejects.toThrow(/templates/);
  });

  it('adds the table, keeps the subscriptions, stores both kinds and rejects another kind', async () => {
    const shim = databaseBeforeTemplates();
    shim.db.exec(MIGRATION_TEMPLATES);
    const store = new D1Store(shim.asD1());
    expect((await store.listSubscriptions()).map((s) => s.id)).toEqual(['bot1']);
    await store.setTemplate({ subscriptionId: 'bot1', kind: 'immediate', body: '{name}', updatedAt: NOW });
    await store.setTemplate({ subscriptionId: 'bot1', kind: 'digest_line', body: '{name} {version}', updatedAt: NOW });
    expect(await store.getTemplates(['bot1'])).toHaveLength(2);
    expect(() => shim.db.prepare("INSERT INTO templates (subscription_id, kind, body, updated_at) VALUES ('bot1', 'other', 'x', 'y')").run()).toThrow(/CHECK/);
  });

  it('is safe to repeat, and schema.sql applies cleanly afterwards, twice', () => {
    const shim = databaseBeforeTemplates();
    shim.db.exec(MIGRATION_TEMPLATES);
    expect(() => shim.db.exec(MIGRATION_TEMPLATES)).not.toThrow();
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    expect(() => shim.db.exec(SCHEMA)).not.toThrow();
  });
});
