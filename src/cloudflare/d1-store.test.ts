// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE } from '../core/constants.ts';
import { drainOutbox } from '../core/drain.ts';
import { eventId, outboxId, releaseKey } from '../core/ids.ts';
import { renderDigest, renderImmediate } from '../render/index.ts';
import { FakeSender, serverError } from '../testing/fakes.ts';
import type { CommitBatch } from '../core/ports.ts';
import { runRedeliveryScenario } from '../testing/redelivery-scenario.ts';
import { runStoreContract, type StoreContractEnv } from '../testing/store-contract.ts';
import type { ModEvent, OutboxRow, PackageSnapshot, SourceState, Subscription } from '../core/types.ts';
import { D1Store } from './d1-store.ts';
import { D1_MAX_BATCH_STATEMENTS } from './limits.ts';
import { D1Shim } from './testing/d1-shim.ts';

const SCHEMA = readFileSync(join(import.meta.dirname, '../../schema.sql'), 'utf8');
const SOURCE = 'thunderstore:valheim';

function pkg(id: string, over: Partial<PackageSnapshot> = {}): PackageSnapshot {
  return {
    source: SOURCE,
    store: 'thunderstore',
    packageId: id,
    owner: id.split('-')[0] ?? 'Owner',
    name: id.split('-')[1] ?? 'Name',
    version: '1.0.0',
    url: `https://thunderstore.io/c/valheim/p/${id}/`,
    iconUrl: 'https://cdn.example/icon.png',
    downloadUrl: 'https://cdn.example/download.zip',
    downloads: 4321,
    likes: 12,
    websiteUrl: 'https://site.example/mod',
    description: 'A mod',
    categories: ['Tools', 'Misc'],
    isNsfw: false,
    isDeprecated: false,
    updatedAt: '2026-09-18T10:00:00.000Z',
    sizeBytes: 1234,
    ...over,
  };
}

function ev(p: PackageSnapshot, over: Partial<ModEvent> = {}): ModEvent {
  return {
    id: eventId(p.source, p.packageId, p.version),
    kind: 'new',
    versionFrom: null,
    versionTo: p.version,
    changelog: null,
    changelogUrl: null,
    createdAt: '2026-09-18T10:00:00.000Z',
    pkg: p,
    alsoOn: [],
    ...over,
  };
}

function ob(subId: string, e: ModEvent, over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: outboxId(subId, e.id),
    subscriptionId: subId,
    eventId: e.id,
    attempts: 0,
    nextAttemptAt: '2026-09-18T10:00:00.000Z',
    ...over,
  };
}

function state(over: Partial<SourceState> = {}): SourceState {
  return { id: SOURCE, cursor: '2026-09-18T10:00:00.000Z', etag: 'W/"abc"', bootstrapped: true, lastOkAt: '2026-09-18T10:00:01.000Z', ...over };
}

function batch(over: Partial<CommitBatch> = {}): CommitBatch {
  return { source: SOURCE, packages: [], events: [], outbox: [], state: state(), ...over };
}

function count(shim: D1Shim, table: string): number {
  return (shim.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function addSub(shim: D1Shim, id: string, over: { enabled?: number; filter?: string; mode?: string; interval?: number | null; threadId?: string | null } = {}): void {
  shim.db
    .prepare('INSERT INTO subscriptions (id, guild_id, webhook_url, thread_id, filter, mode, digest_interval_min, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, '123456789012345678', `https://discord.com/api/webhooks/123456789012345678/tok-${id}`, over.threadId ?? null, over.filter ?? '{}', over.mode ?? 'digest', over.interval === undefined ? 30 : over.interval, over.enabled ?? 1);
}

function botSubscription(id: string): Subscription {
  return {
    id,
    guildId: 'guild-1',
    transport: 'bot',
    channelId: 'chan-1',
    label: 'Valheim news',
    createdBy: 'user-1',
    threadPerMod: true,
    pausedUntil: 0,
    filter: {},
    mode: 'immediate',
    digestIntervalMin: 30,
    enabled: true,
  };
}

function createD1Env(): StoreContractEnv {
  const contractShim = new D1Shim();
  contractShim.db.exec(SCHEMA);
  return {
    store: new D1Store(contractShim.asD1()),
    addSubscription: async (sub) => {
      contractShim.db
        .prepare('INSERT INTO subscriptions (id, guild_id, webhook_url, thread_id, filter, mode, digest_interval_min, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(sub.id, sub.guildId, sub.webhookUrl ?? null, sub.threadId ?? null, JSON.stringify(sub.filter), sub.mode, sub.digestIntervalMin, sub.enabled ? 1 : 0);
    },
    setSubscriptionEnabled: async (id, enabled) => {
      contractShim.db.prepare('UPDATE subscriptions SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    },
  };
}

runStoreContract('D1Store over the D1 shim', createD1Env);
runRedeliveryScenario('D1Store over the D1 shim', createD1Env);

describe('D1 adapter', () => {
  let shim: D1Shim;
  let store: D1Store;

  beforeEach(() => {
    shim = new D1Shim();
    shim.db.exec(SCHEMA);
    store = new D1Store(shim.asD1());
    shim.preparedSql.length = 0;
  });

  afterEach(() => {
    shim.db.close();
  });

  describe('schema.sql', () => {
    it('applies twice without error', () => {
      expect(() => shim.db.exec(SCHEMA)).not.toThrow();
      expect(() => shim.db.exec(SCHEMA)).not.toThrow();
    });

    it('drops the unused events(created_at) index, also from a database created before it was removed', () => {
      shim.db.exec('CREATE INDEX idx_events_created ON events (created_at)');
      shim.db.exec(SCHEMA);
      const names = (shim.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
      expect(names).not.toContain('idx_events_created');
      expect(names).toContain('idx_events_release');
    });
  });

  describe('source state', () => {
    it('returns null for an unknown source', async () => {
      expect(await store.getSourceState(SOURCE)).toBeNull();
    });

    it('round-trips state through commit', async () => {
      await store.commit(batch());
      expect(await store.getSourceState(SOURCE)).toEqual(state());
    });

    it('touchSource updates etag and last_ok_at but not cursor/bootstrapped', async () => {
      await store.commit(batch());
      await store.touchSource(state({ cursor: 'ignored', etag: 'new', bootstrapped: false, lastOkAt: 'later' }));
      expect(await store.getSourceState(SOURCE)).toEqual(state({ etag: 'new', lastOkAt: 'later' }));
    });

    it('touchSource inserts when the source is unknown', async () => {
      await store.touchSource(state({ bootstrapped: false }));
      expect(await store.getSourceState(SOURCE)).toEqual(state({ bootstrapped: false }));
    });
  });

  describe('commit', () => {
    it('persists packages, events, outbox and state', async () => {
      addSub(shim, 'sub1');
      const p = pkg('Owner-Name');
      const e = ev(p);
      await store.commit(batch({ packages: [p], events: [e], outbox: [ob('sub1', e)] }));
      expect(count(shim, 'packages')).toBe(1);
      expect(count(shim, 'events')).toBe(1);
      expect(count(shim, 'outbox')).toBe(1);
      expect(shim.batchSizes).toEqual([4]);
    });

    it('stores release_key on events', async () => {
      const e = ev(pkg('Some-Mod_Name'));
      await store.commit(batch({ packages: [e.pkg], events: [e] }));
      const row = shim.db.prepare('SELECT release_key FROM events').get() as { release_key: string };
      expect(row.release_key).toBe('some|modname|1.0.0');
    });

    it('is one atomic batch: a failing package statement rolls back events, outbox and cursor', async () => {
      await store.commit(batch({ state: state({ cursor: 'old' }) }));
      const good = pkg('Owner-Good');
      const e = ev(good);
      const bad = { ...pkg('Owner-Bad'), version: null as unknown as string };
      await expect(
        store.commit(batch({ packages: [good, bad], events: [e], outbox: [ob('sub1', e)], state: state({ cursor: 'new' }) })),
      ).rejects.toThrow();
      expect(count(shim, 'packages')).toBe(0);
      expect(count(shim, 'events')).toBe(0);
      expect(count(shim, 'outbox')).toBe(0);
      expect((await store.getSourceState(SOURCE))?.cursor).toBe('old');
    });

    it('rolls everything back when the final (cursor) statement fails', async () => {
      const p = pkg('Owner-Name');
      const e = ev(p);
      shim.failWhen = (sql) => sql.includes('INTO sources');
      await expect(store.commit(batch({ packages: [p], events: [e], outbox: [ob('sub1', e)] }))).rejects.toThrow('injected');
      expect(count(shim, 'packages') + count(shim, 'events') + count(shim, 'outbox') + count(shim, 'sources')).toBe(0);
    });

    it('is idempotent on re-commit (INSERT OR IGNORE) and keeps delivered state untouched', async () => {
      const p = pkg('Owner-Name');
      const e = ev(p, { changelog: 'first' });
      const b = batch({ packages: [p], events: [e], outbox: [ob('sub1', e)] });
      await store.commit(b);
      await store.markFailedMany([ob('sub1', e).id], '2026-09-18T11:00:00.000Z', false);
      await store.commit({ ...b, events: [{ ...e, changelog: 'second' }] });
      expect(count(shim, 'events')).toBe(1);
      expect(count(shim, 'outbox')).toBe(1);
      const row = shim.db.prepare('SELECT changelog FROM events').get() as { changelog: string };
      expect(row.changelog).toBe('first');
      const o = shim.db.prepare('SELECT attempts, next_attempt_at FROM outbox').get() as { attempts: number; next_attempt_at: string };
      expect(o).toEqual({ attempts: 1, next_attempt_at: '2026-09-18T11:00:00.000Z' });
    });

    it('upserts packages on conflict', async () => {
      await store.commit(batch({ packages: [pkg('Owner-Name')] }));
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '2.0.0', description: 'changed', categories: ['X'] })] }));
      const map = await store.getAllKnownVersions(SOURCE);
      expect(map.get('Owner-Name')).toBe('2.0.0');
      expect(count(shim, 'packages')).toBe(1);
    });

    it('keeps richer stored fields and sticky NSFW/deprecated flags when a later snapshot lacks them', async () => {
      await store.commit(batch({ packages: [pkg('Owner-Name', { isNsfw: true, isDeprecated: true })] }));
      await store.commit(
        batch({
          packages: [pkg('Owner-Name', { version: '2.0.0', iconUrl: null, downloadUrl: null, downloads: null, description: null, sizeBytes: null, categories: [], isNsfw: false, isDeprecated: false })],
        }),
      );
      const row = shim.db.prepare('SELECT * FROM packages WHERE package_id = ?').get('Owner-Name') as Record<string, unknown>;
      expect(row).toMatchObject({
        latest_version: '2.0.0',
        icon_url: 'https://cdn.example/icon.png',
        download_url: null,
        downloads: 4321,
        description: 'A mod',
        size_bytes: 1234,
        categories: '["Tools","Misc"]',
        is_nsfw: 1,
        is_deprecated: 1,
      });
    });

    it('keeps the download url only for the same version; a new version without one has none', async () => {
      const read = () => (shim.db.prepare('SELECT download_url FROM packages WHERE package_id = ?').get('Owner-Name') as { download_url: string | null }).download_url;
      await store.commit(batch({ packages: [pkg('Owner-Name', { downloadUrl: undefined })] }));
      expect(read()).toBeNull();
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.1.0', downloadUrl: 'https://cdn.example/a.zip' })] }));
      expect(read()).toBe('https://cdn.example/a.zip');
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.1.0', downloadUrl: null })] }));
      expect(read()).toBe('https://cdn.example/a.zip');
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.2.0', downloadUrl: null })] }));
      expect(read()).toBeNull();
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.3.0', downloadUrl: 'https://cdn.example/b.zip' })] }));
      expect(read()).toBe('https://cdn.example/b.zip');
    });

    it('overwrites the stored download count with any new non-null value and keeps it for NULL', async () => {
      const read = () => (shim.db.prepare('SELECT downloads FROM packages WHERE package_id = ?').get('Owner-Name') as { downloads: number | null }).downloads;
      await store.commit(batch({ packages: [pkg('Owner-Name', { downloads: undefined })] }));
      expect(read()).toBeNull();
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.1.0', downloads: 0 })] }));
      expect(read()).toBe(0);
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.2.0', downloads: 900 })] }));
      expect(read()).toBe(900);
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.3.0', downloads: null })] }));
      expect(read()).toBe(900);
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.4.0', downloads: 850 })] }));
      expect(read()).toBe(850);
    });

    it('binds at most 100 parameters per package statement with the 18 package columns', async () => {
      const pkgs = Array.from({ length: 13 }, (_, i) => pkg(`Owner-Mod${i}`));
      shim.preparedSql.length = 0;
      await store.commit(batch({ packages: pkgs }));
      const inserts = shim.preparedSql.filter((sql) => sql.startsWith('INSERT INTO packages'));
      expect(inserts).toHaveLength(3);
      for (const sql of inserts) expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
      expect((await store.getAllKnownVersions(SOURCE)).size).toBe(13);
    });

    it('writes 5 packages per statement: 18 columns x 5 rows = 90 parameters, 6 rows would be 108', async () => {
      const insertsFor = async (n: number): Promise<number[]> => {
        shim.preparedSql.length = 0;
        await store.commit(batch({ packages: Array.from({ length: n }, (_, i) => pkg(`Owner-Mod${i}`)) }));
        return shim.preparedSql.filter((sql) => sql.startsWith('INSERT INTO packages')).map((sql) => (sql.match(/\?/g) ?? []).length);
      };
      expect(await insertsFor(5)).toEqual([90]);
      expect(await insertsFor(6)).toEqual([90, 18]);
    });

    it('tolerates duplicate package ids in one batch (last wins)', async () => {
      await store.commit(batch({ packages: [pkg('Owner-Name'), pkg('Owner-Name', { version: '3.0.0' })] }));
      expect((await store.getAllKnownVersions(SOURCE)).get('Owner-Name')).toBe('3.0.0');
    });

    it('rejects a batch that mixes sources', async () => {
      await expect(store.commit(batch({ packages: [pkg('Owner-Name', { source: 'hexium:valheim' })] }))).rejects.toThrow('mixes sources');
      expect(shim.batchSizes).toEqual([]);
    });

    it('handles an empty batch (state only)', async () => {
      await store.commit(batch());
      expect(shim.batchSizes).toEqual([1]);
    });

    it('splits an oversized commit; cursor lands only in the final batch and a crash leaves state safe', async () => {
      const pkgs = Array.from({ length: 300 }, (_, i) => pkg(`Owner-Mod${i}`));
      const events = pkgs.map((p) => ev(p));
      const outbox = events.map((e) => ob('sub1', e));
      shim.failWhen = (sql) => sql.includes('INTO sources');
      await expect(store.commit(batch({ packages: pkgs, events, outbox }))).rejects.toThrow('injected');
      expect(shim.batchSizes.length).toBeGreaterThan(1);
      expect(count(shim, 'sources')).toBe(0);
      expect(count(shim, 'events')).toBeGreaterThan(0);

      shim.failWhen = null;
      shim.batchSizes.length = 0;
      await store.commit(batch({ packages: pkgs, events, outbox }));
      expect(shim.batchSizes.length).toBeGreaterThan(1);
      expect(Math.max(...shim.batchSizes)).toBeLessThanOrEqual(D1_MAX_BATCH_STATEMENTS);
      expect(count(shim, 'events')).toBe(events.length);
      expect(count(shim, 'outbox')).toBe(outbox.length);
      expect(count(shim, 'packages')).toBe(pkgs.length);
      expect(await store.getSourceState(SOURCE)).not.toBeNull();
    });
  });

  describe('getKnownVersions', () => {
    it('returns only known ids', async () => {
      await store.commit(batch({ packages: [pkg('A-One'), pkg('B-Two', { version: '2.0.0' })] }));
      const map = await store.getKnownVersions(SOURCE, ['A-One', 'B-Two', 'C-Missing']);
      expect([...map.entries()].sort()).toEqual([
        ['A-One', '1.0.0'],
        ['B-Two', '2.0.0'],
      ]);
    });

    it('scopes to the source', async () => {
      await store.commit(batch({ packages: [pkg('A-One')] }));
      expect((await store.getKnownVersions('hexium:valheim', ['A-One'])).size).toBe(0);
    });

    it('returns an empty map without querying for no ids', async () => {
      expect((await store.getKnownVersions(SOURCE, [])).size).toBe(0);
      expect(shim.preparedSql).toEqual([]);
    });

    it('chunks more than 100 ids under the bound-parameter limit in a single batch call', async () => {
      const pkgs = Array.from({ length: 250 }, (_, i) => pkg(`Owner-Mod${i}`));
      await store.commit(batch({ packages: pkgs }));
      shim.preparedSql.length = 0;
      shim.batchSizes.length = 0;
      const map = await store.getKnownVersions(SOURCE, [...pkgs.map((p) => p.packageId), 'Owner-Nope']);
      expect(map.size).toBe(250);
      expect(shim.batchSizes).toEqual([3]);
      for (const sql of shim.preparedSql) {
        expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('getAllKnownVersions', () => {
    it('returns every package of the source', async () => {
      await store.commit(batch({ packages: [pkg('A-One'), pkg('B-Two')] }));
      expect((await store.getAllKnownVersions(SOURCE)).size).toBe(2);
      expect((await store.getAllKnownVersions('nexus:valheim')).size).toBe(0);
    });
  });

  describe('listSubscriptions', () => {
    it('parses filters, applies default interval and skips disabled', async () => {
      addSub(shim, 's1', { filter: '{"kinds":["new"],"allowNsfw":true}', interval: null });
      addSub(shim, 's2', { enabled: 0 });
      const subs = await store.listSubscriptions();
      expect(subs).toEqual([
        {
          id: 's1',
          guildId: '123456789012345678',
          transport: 'webhook',
          webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/tok-s1',
          channelId: null,
          threadId: null,
          label: null,
          createdBy: null,
          threadPerMod: false,
          pausedUntil: 0,
          filter: { kinds: ['new'], allowNsfw: true },
          mode: 'digest',
          digestIntervalMin: 30,
          enabled: true,
        },
      ]);
    });

    it('carries a thread id through, and reports null when the subscription has none', async () => {
      addSub(shim, 's1', { threadId: '222233334444555566' });
      addSub(shim, 's2');
      const subs = await store.listSubscriptions();
      expect(subs.map((s) => [s.id, s.threadId])).toEqual([
        ['s1', '222233334444555566'],
        ['s2', null],
      ]);
    });
  });

  describe('bot subscriptions', () => {
    it('maps every bot column and leaves the webhook null', async () => {
      await store.createSubscription({ ...botSubscription('bot1'), threadId: '222233334444555566', pausedUntil: 1_800_000_000 });
      const [sub] = await store.listSubscriptions();
      expect(sub).toEqual({ ...botSubscription('bot1'), webhookUrl: null, threadId: '222233334444555566', pausedUntil: 1_800_000_000 });
    });

    it('stores text with quotes and SQL fragments literally', async () => {
      const label = "x'; DROP TABLE subscriptions; --";
      await store.createSubscription({ ...botSubscription('bot1'), label });
      await store.updateSubscription('bot1', { label: `${label}!` });
      expect((await store.listSubscriptionsByChannel('chan-1'))[0]!.label).toBe(`${label}!`);
      expect(count(shim, 'subscriptions')).toBe(1);
    });

    it('updates only the named columns in one statement', async () => {
      await store.createSubscription(botSubscription('bot1'));
      shim.preparedSql.length = 0;
      await store.updateSubscription('bot1', { label: 'y', pausedUntil: 9 });
      expect(shim.preparedSql).toEqual(['UPDATE subscriptions SET label = ?, paused_until = ? WHERE id = ?']);
    });

    it('deletes the subscription and its undelivered outbox rows in one transactional batch', async () => {
      addSub(shim, 'sub1');
      const delivered = ev(pkg('A-One'));
      const pending = ev(pkg('B-Two'));
      await store.commit(batch({ packages: [delivered.pkg, pending.pkg], events: [delivered, pending], outbox: [ob('sub1', delivered), ob('sub1', pending)] }));
      await store.markDelivered([ob('sub1', delivered).id], '2026-09-19T00:00:00.000Z');
      shim.batchSizes.length = 0;
      expect(await store.deleteSubscription('sub1')).toBe(true);
      expect(shim.batchSizes).toEqual([2]);
      expect(count(shim, 'subscriptions')).toBe(0);
      expect(shim.db.prepare('SELECT event_id FROM outbox').all()).toEqual([{ event_id: delivered.id }]);
    });

    it('skips a bot row with an unknown transport or a bad filter in the channel and guild lists', async () => {
      await store.createSubscription(botSubscription('good'));
      shim.db.exec('PRAGMA ignore_check_constraints = ON');
      shim.db.prepare("INSERT INTO subscriptions (id, guild_id, transport, channel_id, filter) VALUES ('odd', 'guild-1', 'carrier-pigeon', 'chan-1', '{}')").run();
      shim.db.prepare("INSERT INTO subscriptions (id, guild_id, transport, channel_id, filter) VALUES ('bad', 'guild-1', 'bot', 'chan-1', '{not json')").run();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect((await store.listSubscriptionsByChannel('chan-1')).map((s) => s.id)).toEqual(['good']);
        expect((await store.listSubscriptionsByGuild('guild-1')).map((s) => s.id)).toEqual(['good']);
      } finally {
        warn.mockRestore();
      }
    });

    it('takeDue leaves the rows of a bot subscription alone', async () => {
      await store.createSubscription(botSubscription('bot1'));
      const e = ev(pkg('A-One'));
      await store.commit(batch({ packages: [e.pkg], events: [e], outbox: [ob('bot1', e)] }));
      expect(await store.takeDue('2026-09-19T00:00:00.000Z', 10)).toEqual([]);
      expect(count(shim, 'outbox')).toBe(1);
    });
  });

  describe('malformed subscription rows', () => {
    const MALFORMED: [string, string][] = [
      ['invalid JSON', '{not json'],
      ['JSON null', 'null'],
      ['a JSON array', '[]'],
      ['a wrong-typed field', '{"allowNsfw":"yes"}'],
      ['an unknown kind', '{"kinds":["delete"]}'],
    ];

    it.each(MALFORMED)('listSubscriptions skips a row with %s and returns the others', async (_label, filter) => {
      addSub(shim, 'bad', { filter });
      addSub(shim, 'good');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect((await store.listSubscriptions()).map((s) => s.id)).toEqual(['good']);
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0]![0]);
        expect(line).toContain('bad');
        expect(line).not.toContain('discord.com');
        expect(line).not.toContain('tok-bad');
      } finally {
        warn.mockRestore();
      }
    });

    it('listSubscriptions skips a row with an unknown mode', async () => {
      addSub(shim, 'good');
      shim.db.exec('PRAGMA ignore_check_constraints = ON');
      addSub(shim, 'odd', { mode: 'weekly' });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect((await store.listSubscriptions()).map((s) => s.id)).toEqual(['good']);
      } finally {
        warn.mockRestore();
      }
    });

    it.each(MALFORMED)('takeDue skips due rows of a subscription with %s and still returns the others', async (_label, filter) => {
      addSub(shim, 'bad', { filter });
      addSub(shim, 'good');
      const events = ['A-One', 'B-Two', 'C-Three'].map((id) => ev(pkg(id)));
      await store.commit(
        batch({
          packages: events.map((e) => e.pkg),
          events,
          outbox: [
            ob('bad', events[0]!, { nextAttemptAt: '2026-09-18T10:00:00.000Z' }),
            ob('bad', events[1]!, { nextAttemptAt: '2026-09-18T10:00:01.000Z' }),
            ob('good', events[2]!, { nextAttemptAt: '2026-09-18T10:00:02.000Z' }),
          ],
        }),
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const due = await store.takeDue('2026-09-18T12:00:00.000Z', 10);
        expect(due.map((d) => d.subscription.id)).toEqual(['good']);
        const lines = warn.mock.calls.map((c) => String(c[0]));
        expect(lines.length).toBeLessThanOrEqual(1);
        for (const line of lines) expect(line).not.toContain('tok-bad');
      } finally {
        warn.mockRestore();
      }
    });

    it('takeDue does not let JSON-invalid subscriptions crowd valid ones out of the row limit', async () => {
      addSub(shim, 'bad', { filter: '{oops' });
      addSub(shim, 'good');
      const events = Array.from({ length: 5 }, (_, i) => ev(pkg(`Own${i}-Mod`)));
      await store.commit(
        batch({
          packages: events.map((e) => e.pkg),
          events,
          outbox: [
            ...events.slice(0, 3).map((e, i) => ob('bad', e, { nextAttemptAt: `2026-09-18T10:00:0${i}.000Z` })),
            ...events.slice(3).map((e, i) => ob('good', e, { nextAttemptAt: `2026-09-18T10:01:0${i}.000Z` })),
          ],
        }),
      );
      expect((await store.takeDue('2026-09-18T12:00:00.000Z', 2)).map((d) => d.subscription.id)).toEqual(['good', 'good']);
    });
  });

  describe('takeDue', () => {
    async function seed(): Promise<{ events: ModEvent[] }> {
      addSub(shim, 'sub1');
      const events = ['A-One', 'B-Two', 'C-Three'].map((id, i) =>
        ev(pkg(id, { version: `1.0.${i}`, categories: ['Cat'] }), {
          versionFrom: i === 0 ? null : '0.9.0',
          kind: i === 0 ? 'new' : 'update',
          changelog: `notes ${id}`,
          changelogUrl: `https://cl/${id}`,
        }),
      );
      await store.commit(
        batch({
          packages: events.map((e) => e.pkg),
          events,
          outbox: [
            ob('sub1', events[0]!, { nextAttemptAt: '2026-09-18T10:03:00.000Z' }),
            ob('sub1', events[1]!, { nextAttemptAt: '2026-09-18T10:01:00.000Z' }),
            ob('sub1', events[2]!, { nextAttemptAt: '2026-09-18T10:02:00.000Z' }),
          ],
        }),
      );
      return { events };
    }

    it('joins everything, oldest first', async () => {
      const { events } = await seed();
      const due = await store.takeDue('2026-09-18T12:00:00.000Z', 10);
      expect(due.map((d) => d.event.pkg.packageId)).toEqual(['B-Two', 'C-Three', 'A-One']);
      const first = due[0]!;
      expect(first.row).toEqual({
        id: outboxId('sub1', events[1]!.id),
        subscriptionId: 'sub1',
        eventId: events[1]!.id,
        attempts: 0,
        nextAttemptAt: '2026-09-18T10:01:00.000Z',
      });
      expect(first.subscription.webhookUrl).toContain('/webhooks/');
      expect(first.event).toEqual({
        ...events[1]!,
        pkg: { ...events[1]!.pkg, version: '1.0.1' },
      });
    });

    it('respects the limit and the due time', async () => {
      await seed();
      expect((await store.takeDue('2026-09-18T12:00:00.000Z', 2)).length).toBe(2);
      expect((await store.takeDue('2026-09-18T10:01:30.000Z', 10)).map((d) => d.event.pkg.packageId)).toEqual(['B-Two']);
      expect(await store.takeDue('2026-09-18T10:00:00.000Z', 10)).toEqual([]);
    });

    it('excludes parked rows and disabled subscriptions', async () => {
      const { events } = await seed();
      await store.markFailedMany([outboxId('sub1', events[1]!.id)], '2026-09-18T10:01:00.000Z', true);
      expect((await store.takeDue('2026-09-18T12:00:00.000Z', 10)).length).toBe(2);
      shim.db.exec("UPDATE subscriptions SET enabled = 0 WHERE id = 'sub1'");
      expect(await store.takeDue('2026-09-18T12:00:00.000Z', 10)).toEqual([]);
    });

    it('maps package fields faithfully', async () => {
      const { events } = await seed();
      const [d] = await store.takeDue('2026-09-18T12:00:00.000Z', 1);
      const p = d!.event.pkg;
      expect(p).toEqual({ ...events[1]!.pkg, version: '1.0.1' });
      expect(p.categories).toEqual(['Cat']);
      expect(p.isNsfw).toBe(false);
    });
  });

  describe('markDelivered / markFailedMany / setEventDetails', () => {
    it('markDelivered keeps the rows, stamps delivered_at and chunks large id lists', async () => {
      const pkgs = Array.from({ length: 250 }, (_, i) => pkg(`Owner-Mod${i}`));
      const events = pkgs.map((p) => ev(p));
      const outbox = events.map((e) => ob('sub1', e));
      await store.commit(batch({ packages: pkgs, events, outbox }));
      shim.preparedSql.length = 0;
      await store.markDelivered(outbox.map((o) => o.id), '2026-09-19T00:00:00.000Z');
      expect(count(shim, 'outbox')).toBe(250);
      const stamped = shim.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE delivered_at = ?').get('2026-09-19T00:00:00.000Z') as { n: number };
      expect(stamped.n).toBe(250);
      for (const sql of shim.preparedSql) expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
      await expect(store.markDelivered([], '2026-09-19T00:00:00.000Z')).resolves.toBeUndefined();
    });

    it('markFailedMany bumps attempts and reschedules', async () => {
      const e = ev(pkg('A-One'));
      const o = ob('sub1', e);
      await store.commit(batch({ packages: [e.pkg], events: [e], outbox: [o] }));
      await store.markFailedMany([o.id], '2026-09-18T10:05:00.000Z', false);
      await store.markFailedMany([o.id], '2026-09-18T10:10:00.000Z', false);
      expect(shim.db.prepare('SELECT attempts, next_attempt_at, parked FROM outbox').get()).toEqual({
        attempts: 2,
        next_attempt_at: '2026-09-18T10:10:00.000Z',
        parked: 0,
      });
    });

    it('markFailedMany parks the row', async () => {
      const e = ev(pkg('A-One'));
      const o = ob('sub1', e);
      await store.commit(batch({ packages: [e.pkg], events: [e], outbox: [o] }));
      await store.markFailedMany([o.id], '2026-09-18T10:05:00.000Z', true);
      expect((shim.db.prepare('SELECT parked FROM outbox').get() as { parked: number }).parked).toBe(1);
    });

    it('setEventDetails updates the event, and the package website only when one is given', async () => {
      const e = ev(pkg('A-One', { websiteUrl: null }));
      await store.commit(batch({ packages: [e.pkg], events: [e] }));
      const website = () => (shim.db.prepare('SELECT website_url FROM packages WHERE package_id = ?').get('A-One') as { website_url: string | null }).website_url;
      await store.setEventDetails(e.id, { changelog: 'notes', changelogUrl: 'https://cl', websiteUrl: null });
      expect(shim.db.prepare('SELECT changelog, changelog_url FROM events').get()).toEqual({ changelog: 'notes', changelog_url: 'https://cl' });
      expect(website()).toBeNull();
      await store.setEventDetails(e.id, { changelog: null, changelogUrl: null, websiteUrl: 'https://site.example/' });
      expect(shim.db.prepare('SELECT changelog, changelog_url FROM events').get()).toEqual({ changelog: null, changelog_url: null });
      expect(website()).toBe('https://site.example/');
    });

    it('setEventDetails is one statement without a website and one atomic batch with it', async () => {
      const e = ev(pkg('A-One'));
      await store.commit(batch({ packages: [e.pkg], events: [e] }));
      shim.batchSizes.length = 0;
      await store.setEventDetails(e.id, { changelog: 'n', changelogUrl: null, websiteUrl: null });
      expect(shim.batchSizes).toEqual([]);
      await store.setEventDetails(e.id, { changelog: 'n', changelogUrl: null, websiteUrl: 'https://site.example/' });
      expect(shim.batchSizes).toEqual([2]);
    });

    it('overwrites the stored likes with any new non-null value and keeps them for NULL', async () => {
      const read = () => (shim.db.prepare('SELECT likes FROM packages WHERE package_id = ?').get('Owner-Name') as { likes: number | null }).likes;
      await store.commit(batch({ packages: [pkg('Owner-Name', { likes: undefined })] }));
      expect(read()).toBeNull();
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.1.0', likes: 0 })] }));
      expect(read()).toBe(0);
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.2.0', likes: 900 })] }));
      expect(read()).toBe(900);
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.3.0', likes: null })] }));
      expect(read()).toBe(900);
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.4.0', likes: 850 })] }));
      expect(read()).toBe(850);
    });

    it('keeps the stored website for a snapshot without one and replaces it with a new one', async () => {
      const read = () => (shim.db.prepare('SELECT website_url FROM packages WHERE package_id = ?').get('Owner-Name') as { website_url: string | null }).website_url;
      await store.commit(batch({ packages: [pkg('Owner-Name', { websiteUrl: undefined })] }));
      expect(read()).toBeNull();
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.1.0', websiteUrl: 'https://a.example/' })] }));
      expect(read()).toBe('https://a.example/');
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.2.0', websiteUrl: null })] }));
      expect(read()).toBe('https://a.example/');
      await store.commit(batch({ packages: [pkg('Owner-Name', { version: '1.3.0', websiteUrl: 'https://b.example/' })] }));
      expect(read()).toBe('https://b.example/');
    });
  });

  describe('EXPLAIN QUERY PLAN', () => {
    it('every query the store issues is index-backed (no SCAN)', async () => {
      addSub(shim, 'sub1');
      const called = new Set<string>();
      const spy = new Proxy(store, {
        get(target, name, receiver) {
          const member = Reflect.get(target, name, receiver) as unknown;
          if (typeof member !== 'function') return member;
          return (...args: unknown[]) => {
            called.add(String(name));
            return (member as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      const p = pkg('Owner-Name');
      const e = ev(p);
      const o = ob('sub1', e);
      await spy.getSourceState(SOURCE);
      await spy.commit(batch({ packages: [p], events: [e], outbox: [o] }));
      await spy.touchSource(state());
      await spy.getKnownVersions(SOURCE, ['Owner-Name']);
      await spy.getAllKnownVersions(SOURCE);
      await spy.listSubscriptions();
      await spy.createSubscription(botSubscription('bot1'));
      await spy.updateSubscription('bot1', { label: 'x', pausedUntil: 5 });
      await spy.updateSubscription('bot1', {});
      await spy.listSubscriptionsByChannel('chan-1');
      await spy.listSubscriptionsByGuild('guild-1');
      await spy.putModThread({ channelId: 'chan-1', source: SOURCE, packageId: 'Owner-Name', threadId: 't1', anchorMessageId: null, createdAt: '2026-09-19T00:00:00.000Z' });
      await spy.getModThread('chan-1', SOURCE, 'Owner-Name');
      await spy.deleteModThread('chan-1', SOURCE, 'Owner-Name');
      await spy.putMessage({ messageId: 'm1', channelId: 'chan-1', source: SOURCE, packageId: 'Owner-Name', eventId: e.id, createdAt: '2026-09-19T00:00:00.000Z' });
      await spy.getMessage('m1');
      await spy.purgeMessages('2026-09-20T00:00:00.000Z', 10);
      await spy.searchPackages('Na');
      await spy.searchOwners('Ow');
      await spy.recentEventsByReleaseKeys(['k'], '2026-01-01T00:00:00.000Z');
      await spy.takeDue('2026-09-19T00:00:00.000Z', 10);
      await spy.markFailedMany([o.id], '2026-09-19T00:00:00.000Z', false);
      await spy.rescheduleRows([o.id], '2026-09-19T00:00:00.000Z');
      await spy.existingEventIds([e.id]);
      await spy.setEventDetails(e.id, { changelog: 'x', changelogUrl: null, websiteUrl: null });
      await spy.setEventDetails(e.id, { changelog: 'x', changelogUrl: null, websiteUrl: 'https://site.example/' });
      await spy.markDelivered([o.id], '2026-09-19T00:00:00.000Z');
      await spy.purgeDelivered('2026-09-20T00:00:00.000Z', 10);
      await spy.setAlertState('k', { level: 1, notifiedAt: '2026-09-19T00:00:00.000Z' });
      await spy.getAlertStates(['k']);
      await spy.deleteSubscription('bot1');

      const distinct = [...new Set(shim.preparedSql)];
      expect(distinct.length).toBeGreaterThanOrEqual(25);

      const failures: string[] = [];
      for (const sql of distinct) {
        const plan = shim.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
        const details = plan.map((r) => r.detail).filter((d) => !/CONSTANT ROW/.test(d));
        for (const d of details) {
          if (/^SCAN /.test(d)) failures.push(`${sql.slice(0, 60)} => ${d}`);
        }
      }
      expect(failures).toEqual([]);

      const methods = Object.getOwnPropertyNames(D1Store.prototype).filter((name) => name !== 'constructor');
      expect(methods.filter((name) => !called.has(name))).toEqual([]);
    });

    it('takeDue drives off the partial due index without a sort', async () => {
      await store.takeDue('2026-09-19T00:00:00.000Z', 10);
      const sql = shim.preparedSql.find((s) => s.includes('FROM outbox o'))!;
      const plan = (shim.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);
      expect(plan.some((d) => d.includes('SEARCH o USING INDEX idx_outbox_pending'))).toBe(true);
      expect(plan.some((d) => d.includes('TEMP B-TREE'))).toBe(false);
    });

    it('recentEventsByReleaseKeys uses the release index for every key', async () => {
      await store.recentEventsByReleaseKeys(['k1', 'k2'], 'z');
      const sql = shim.preparedSql.find((s) => s.includes('e.release_key'))!;
      const plan = (shim.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);
      expect(plan.some((d) => d.includes('idx_events_release (release_key=? AND created_at>?)'))).toBe(true);
    });

    it('recentEventsByReleaseKeys sends one batch call for many keys, each statement under the bound-parameter limit', async () => {
      shim.preparedSql.length = 0;
      shim.batchSizes.length = 0;
      await store.recentEventsByReleaseKeys(Array.from({ length: 250 }, (_, i) => `k${i}`), 'z');
      expect(shim.batchSizes).toEqual([3]);
      for (const sql of shim.preparedSql) expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
    });

    it('existingEventIds looks ids up through the primary key', async () => {
      await store.existingEventIds(['a', 'b']);
      const sql = shim.preparedSql.find((s) => s.startsWith('SELECT id FROM events WHERE id IN'))!;
      const plan = (shim.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('a', 'b') as { detail: string }[]).map((r) => r.detail);
      expect(plan.some((d) => d.includes('SEARCH') && d.includes('autoindex'))).toBe(true);
    });

    it.each([
      ['existingEventIds', (ids: string[]) => store.existingEventIds(ids)],
      ['markFailedMany', (ids: string[]) => store.markFailedMany(ids, 'z', false)],
      ['rescheduleRows', (ids: string[]) => store.rescheduleRows(ids, 'z')],
    ])('%s sends one batch of statements under the bound-parameter limit for 400 ids', async (_name, call) => {
      shim.preparedSql.length = 0;
      shim.batchSizes.length = 0;
      await call(Array.from({ length: 400 }, (_, i) => `id${i}`));
      expect(shim.batchSizes).toHaveLength(1);
      expect(shim.batchSizes[0]).toBeLessThanOrEqual(5);
      for (const sql of shim.preparedSql) expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(100);
    });

    const planOf = (sql: string, ...params: unknown[]): string[] =>
      (shim.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[]).map((r) => r.detail);

    it('searchPackages ranges over the case-insensitive name index and needs no sort', async () => {
      await store.searchPackages('Na');
      const plan = planOf(shim.preparedSql.find((q) => q.includes('FROM packages WHERE name COLLATE NOCASE'))!, 'Na', 'Na\u{10FFFF}', 25);
      expect(plan.some((d) => d.includes('SEARCH packages USING INDEX idx_packages_name'))).toBe(true);
      expect(plan.some((d) => d.includes('TEMP B-TREE'))).toBe(false);
    });

    it('searchOwners ranges over the owner index alone, as a covering index, and needs no sort', async () => {
      await store.searchOwners('Ow');
      const plan = planOf(shim.preparedSql.find((q) => q.includes('SELECT owner FROM packages'))!, 'Ow', 'Ow\u{10FFFF}', 500);
      expect(plan.some((d) => d.includes('SEARCH packages USING COVERING INDEX idx_packages_owner'))).toBe(true);
      expect(plan.some((d) => d.includes('TEMP B-TREE'))).toBe(false);
    });

    it('a prefix below the minimum length sends no query at all', async () => {
      shim.preparedSql.length = 0;
      expect(await store.searchPackages('a')).toEqual([]);
      expect(await store.searchOwners('')).toEqual([]);
      expect(shim.preparedSql).toEqual([]);
    });

    it('lists subscriptions by channel and by guild through their indexes', async () => {
      await store.listSubscriptionsByChannel('chan-1');
      await store.listSubscriptionsByGuild('guild-1');
      expect(planOf(shim.preparedSql.find((q) => q.endsWith('WHERE channel_id = ?'))!, 'chan-1').some((d) => d.includes('idx_subscriptions_channel'))).toBe(true);
      expect(planOf(shim.preparedSql.find((q) => q.endsWith('WHERE guild_id = ?'))!, 'guild-1').some((d) => d.includes('idx_subscriptions_guild'))).toBe(true);
    });

    it('purgeMessages deletes through the created_at index', async () => {
      await store.purgeMessages('2026-09-20T00:00:00.000Z', 10);
      const plan = planOf(shim.preparedSql.find((q) => q.startsWith('DELETE FROM messages'))!, '2026-09-20T00:00:00.000Z', 10);
      expect(plan.some((d) => d.includes('idx_messages_created'))).toBe(true);
    });

    it('deleteSubscription finds the outbox rows through the (subscription, event) unique index', async () => {
      await store.deleteSubscription('sub1');
      const plan = planOf(shim.preparedSql.find((q) => q.startsWith('DELETE FROM outbox WHERE subscription_id'))!, 'sub1');
      expect(plan.some((d) => d.includes('SEARCH') && d.includes('autoindex'))).toBe(true);
    });

    it('mod thread and message lookups go through their primary keys', async () => {
      await store.getModThread('c', SOURCE, 'p');
      await store.getMessage('m');
      for (const sql of shim.preparedSql.filter((q) => q.includes('FROM mod_threads') || q.includes('FROM messages WHERE message_id = ?'))) {
        const plan = planOf(sql, ...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 'x'));
        expect(plan.some((d) => d.startsWith('SEARCH') && d.includes('autoindex'))).toBe(true);
      }
    });

    it('purgeDelivered deletes through the delivered index', async () => {
      await store.purgeDelivered('2026-09-20T00:00:00.000Z', 10);
      const sql = shim.preparedSql.find((s) => s.startsWith('DELETE FROM outbox'))!;
      const plan = (shim.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('2026-09-20T00:00:00.000Z', 10) as { detail: string }[]).map((r) => r.detail);
      expect(plan.some((d) => d.includes('idx_outbox_delivered'))).toBe(true);
    });
  });

  describe('corrupt package rows', () => {
    async function seedOne(): Promise<{ e: ModEvent }> {
      addSub(shim, 'sub1');
      const e = ev(pkg('Owner-Name'));
      await store.commit(batch({ packages: [e.pkg], events: [e], outbox: [ob('sub1', e)] }));
      return { e };
    }

    it.each([['not json'], ['{"a":1}'], ['[1,2]'], ['']])('takeDue reads categories %j as an empty list instead of throwing', async (raw) => {
      await seedOne();
      shim.db.prepare('UPDATE packages SET categories = ?').run(raw);
      const due = await store.takeDue('2026-09-19T00:00:00.000Z', 10);
      expect(due).toHaveLength(1);
      expect(due[0]!.event.pkg.categories).toEqual([]);
    });

    it('recentEventsByReleaseKeys tolerates corrupt categories too', async () => {
      const { e } = await seedOne();
      shim.db.prepare('UPDATE packages SET categories = ?').run('not json');
      const found = await store.recentEventsByReleaseKeys([releaseKey(e.pkg, e.versionTo)], '2026-01-01T00:00:00.000Z');
      expect([...found.values()].flat()[0]!.pkg.categories).toEqual([]);
    });

    it('drain parks a package with an unknown store and still delivers the healthy events', async () => {
      addSub(shim, 'sub1', { mode: 'digest' });
      const good = [ev(pkg('Good-One')), ev(pkg('Good-Two'))];
      const bad = ev(pkg('Bad-Mod'));
      shim.db.prepare('INSERT INTO sources (id, bootstrapped) VALUES (?, 1)').run(SOURCE);
      const events = [good[0]!, bad, good[1]!];
      await store.commit(batch({ packages: events.map((e) => e.pkg), events, outbox: events.map((e) => ob('sub1', e)) }));
      shim.db.prepare('UPDATE packages SET store = ? WHERE package_id = ?').run('bogus', 'Bad-Mod');

      const sender = new FakeSender();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const report = await drainOutbox({ store, sender, renderer: { renderDigest, renderImmediate }, now: new Date('2026-09-19T00:00:00.000Z') });
        expect(report).toMatchObject({ failed: 1, parked: 1, deferred: 0 });
        expect(sender.calls).toHaveLength(1);
        expect(warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain(bad.id);
      } finally {
        warn.mockRestore();
      }
      const rows = shim.db.prepare('SELECT event_id, parked, delivered_at IS NOT NULL AS delivered FROM outbox ORDER BY rowid').all() as { event_id: string; parked: number; delivered: number }[];
      expect(rows.map((r) => [r.parked, r.delivered])).toEqual([[0, 1], [1, 0], [0, 1]]);
    });
  });

  describe('drain over D1: bounded statement counts', () => {
    it('fails a digest across the bound-parameter limit with two update statements', async () => {
      addSub(shim, 'sub1', { mode: 'digest' });
      const rowCount = CLOUDFLARE.d1MaxBoundParams - 2 + 1;
      const events = Array.from({ length: rowCount }, (_, i) => ev(pkg(`Owner-Mod${i}`), { kind: 'update', versionFrom: '0.9.0' }));
      await store.commit(batch({ packages: events.map((e) => e.pkg), events, outbox: events.map((e) => ob('sub1', e)) }));
      const sender = new FakeSender();
      sender.fallback = () => serverError(500);
      shim.preparedSql.length = 0;
      shim.batchSizes.length = 0;
      const report = await drainOutbox({ store, sender, renderer: { renderDigest, renderImmediate }, now: new Date('2026-09-19T00:00:00.000Z') });
      expect(report).toMatchObject({ failed: 1, sent: 0 });
      const updates = shim.preparedSql.filter((sql) => sql.startsWith('UPDATE outbox'));
      expect(updates).toHaveLength(2);
      expect(shim.preparedSql.length).toBeLessThanOrEqual(1 + updates.length);
      expect((shim.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE attempts = 1').get() as { n: number }).n).toBe(events.length);
    });
  });
});
