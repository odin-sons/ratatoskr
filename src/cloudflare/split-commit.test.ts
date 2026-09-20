// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTick } from '../core/tick.ts';
import { FakeAdapter, FakeClock, FakeRenderer, FakeSender, FIXED_NOW_ISO, makeConfig, makeSnapshot, okPoll } from '../testing/fakes.ts';
import { D1Store } from './d1-store.ts';
import { D1Shim } from './testing/d1-shim.ts';

const SCHEMA = readFileSync(join(import.meta.dirname, '../../schema.sql'), 'utf8');
const SOURCE = 'thunderstore:valheim';
const SUBSCRIPTIONS = 5;
const MODS = 300;
const START = Date.parse(FIXED_NOW_ISO);

function setup() {
  const shim = new D1Shim();
  shim.db.exec(SCHEMA);
  for (let i = 0; i < SUBSCRIPTIONS; i++) {
    shim.db
      .prepare('INSERT INTO subscriptions (id, guild_id, webhook_url, filter, mode, digest_interval_min, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .run(`sub-${i}`, '123456789012345678', `https://discord.com/api/webhooks/123456789012345678/tok-${i}`, '{}', 'digest', 30);
  }
  const store = new D1Store(shim.asD1());
  const adapter = new FakeAdapter({ id: SOURCE });
  const clock = new FakeClock(FIXED_NOW_ISO);
  const deps = {
    store,
    sender: new FakeSender(),
    renderer: new FakeRenderer(),
    clock,
    adapters: [adapter],
    config: makeConfig([adapter.config]),
    secrets: {},
    fetch: (() => {
      throw new Error('unexpected fetch');
    }) as unknown as typeof fetch,
  };
  return { shim, store, adapter, clock, deps };
}

const snapshots = (version: string) =>
  Array.from({ length: MODS }, (_, i) => makeSnapshot({ source: SOURCE, packageId: `Owner${i}-Mod${i}`, owner: `Owner${i}`, name: `Mod${i}`, version }));

const count = (shim: D1Shim, table: string): number => (shim.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('a commit split across D1 batches that fails part-way', () => {
  for (const [label, failing] of [
    ['the final batch (source state)', (sql: string) => sql.startsWith('INSERT INTO sources')],
    ['the first package upsert', (sql: string) => sql.startsWith('INSERT INTO packages')],
  ] as const) {
    it(`loses no notification when ${label} fails once and the next tick retries`, async () => {
      const { shim, store, adapter, clock, deps } = setup();
      await store.commit({
        source: SOURCE,
        packages: snapshots('1.0.0'),
        events: [],
        outbox: [],
        state: { id: SOURCE, cursor: '2026-09-19T10:00:00.000000Z', etag: null, bootstrapped: true, lastOkAt: null },
      });

      adapter.enqueue(okPoll(snapshots('1.1.0'), { cursor: '2026-09-19T12:00:00.000000Z' }));
      let failed = false;
      shim.failWhen = (sql) => {
        if (failed || !failing(sql)) return false;
        failed = true;
        return true;
      };
      const first = await runTick(deps, START);
      expect(first.sources[SOURCE]?.status).toBe('error');

      clock.advance(300_000);
      adapter.enqueue(okPoll(snapshots('1.1.0'), { cursor: '2026-09-19T12:00:00.000000Z' }));
      shim.failWhen = null;
      const second = await runTick(deps, START + 300_000);
      expect(second.sources[SOURCE]?.status).toBe('ok');

      expect(count(shim, 'events')).toBe(MODS);
      expect(count(shim, 'outbox')).toBe(MODS * SUBSCRIPTIONS);
    });
  }
});
