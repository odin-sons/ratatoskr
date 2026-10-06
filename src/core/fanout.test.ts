// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { makeEvent, makeSubscription } from '../testing/fakes.ts';
import { MemoryStore } from '../testing/memory-store.ts';
import { fanOut, nextDigestBoundary } from './fanout.ts';
import { compileFilter } from './filter.ts';
import { outboxId } from './ids.ts';

const compiled = (sub = makeSubscription()) => ({ sub, filter: compileFilter(sub.filter) });

describe('nextDigestBoundary', () => {
  it('aligns to the next multiple of the interval since epoch', () => {
    expect(nextDigestBoundary(new Date('2026-09-19T12:07:00.000Z'), 30)).toBe('2026-09-19T12:30:00.000Z');
    expect(nextDigestBoundary(new Date('2026-09-19T12:31:00.000Z'), 30)).toBe('2026-09-19T13:00:00.000Z');
    expect(nextDigestBoundary(new Date('2026-09-19T12:07:00.000Z'), 60)).toBe('2026-09-19T13:00:00.000Z');
    expect(nextDigestBoundary(new Date('2026-09-19T12:07:00.000Z'), 15)).toBe('2026-09-19T12:15:00.000Z');
  });

  it('keeps a time that is already on a boundary', () => {
    expect(nextDigestBoundary(new Date('2026-09-19T12:30:00.000Z'), 30)).toBe('2026-09-19T12:30:00.000Z');
  });

  it('falls back to the default for invalid intervals', () => {
    expect(nextDigestBoundary(new Date('2026-09-19T12:07:00.000Z'), 0)).toBe('2026-09-19T12:30:00.000Z');
    expect(nextDigestBoundary(new Date('2026-09-19T12:07:00.000Z'), Number.NaN)).toBe('2026-09-19T12:30:00.000Z');
  });
});

describe('fanOut', () => {
  const now = new Date('2026-09-19T12:07:00.000Z');

  it('creates immediate rows due now and digest rows due at the boundary', async () => {
    const imm = compiled(makeSubscription({ id: 'imm', mode: 'immediate' }));
    const dig = compiled(makeSubscription({ id: 'dig', mode: 'digest', digestIntervalMin: 30 }));
    const ev = makeEvent();
    const { rows } = await fanOut([ev], [imm, dig], new MemoryStore(), now);
    expect(rows).toEqual([
      { id: outboxId('imm', ev.id), subscriptionId: 'imm', eventId: ev.id, attempts: 0, nextAttemptAt: now.toISOString() },
      { id: outboxId('dig', ev.id), subscriptionId: 'dig', eventId: ev.id, attempts: 0, nextAttemptAt: '2026-09-19T12:30:00.000Z' },
    ]);
  });

  it('skips subscriptions whose filter rejects the event', async () => {
    const sub = compiled(makeSubscription({ filter: { kinds: ['update'] } }));
    const { rows } = await fanOut([makeEvent()], [sub], new MemoryStore(), now);
    expect(rows).toEqual([]);
  });

  it('flags new events and watchlist hits as detailed, not other updates, for a digest subscription', async () => {
    const sub = compiled(makeSubscription({ mode: 'digest', filter: { watchlist: ['Star-Mod'] } }));
    const fresh = makeEvent({ pkg: { packageId: 'A-New' } });
    const hit = makeEvent({ kind: 'update', versionFrom: '0.1.0', pkg: { owner: 'Star', name: 'Mod', packageId: 'Star-Mod' } });
    const plain = makeEvent({ kind: 'update', versionFrom: '0.1.0', pkg: { packageId: 'A-Plain', name: 'Plain' } });
    const { detailedEventIds } = await fanOut([fresh, hit, plain], [sub], new MemoryStore(), now);
    expect([...detailedEventIds].sort()).toEqual([fresh.id, hit.id].sort());
  });

  it('flags every event an immediate subscription receives as detailed, updates included', async () => {
    const sub = compiled(makeSubscription({ mode: 'immediate' }));
    const fresh = makeEvent({ pkg: { packageId: 'A-New' } });
    const plain = makeEvent({ kind: 'update', versionFrom: '0.1.0', pkg: { packageId: 'A-Plain', name: 'Plain' } });
    const { detailedEventIds } = await fanOut([fresh, plain], [sub], new MemoryStore(), now);
    expect([...detailedEventIds].sort()).toEqual([fresh.id, plain.id].sort());
  });

  it('flags an update as detailed when any receiving subscription is immediate, and not when only a digest receives it', async () => {
    const digest = compiled(makeSubscription({ id: 'dig', mode: 'digest' }));
    const immediate = compiled(makeSubscription({ id: 'imm', mode: 'immediate', filter: { sources: ['thunderstore:valheim'] } }));
    const forBoth = makeEvent({ kind: 'update', versionFrom: '0.1.0', pkg: { packageId: 'A-Both', source: 'thunderstore:valheim' } });
    const digestOnly = makeEvent({ kind: 'update', versionFrom: '0.1.0', pkg: { packageId: 'B-Digest', source: 'hexium:valheim', store: 'hexium' } });
    const { detailedEventIds } = await fanOut([forBoth, digestOnly], [digest, immediate], new MemoryStore(), now);
    expect([...detailedEventIds]).toEqual([forBoth.id]);
  });

  it('does not flag an event that no subscription receives', async () => {
    const imm = compiled(makeSubscription({ mode: 'immediate', filter: { kinds: ['new'] } }));
    const update = makeEvent({ kind: 'update', versionFrom: '0.1.0', pkg: { packageId: 'A-Upd' } });
    const { detailedEventIds, rows } = await fanOut([update], [imm], new MemoryStore(), now);
    expect(rows).toEqual([]);
    expect(detailedEventIds.size).toBe(0);
  });

  describe('cross-store lookups', () => {
    const counting = (store = new MemoryStore()) => {
      const calls: string[][] = [];
      return {
        calls,
        store: {
          recentEventsByReleaseKeys: (keys: string[], since: string) => {
            calls.push(keys);
            return store.recentEventsByReleaseKeys(keys, since);
          },
        },
      };
    };

    it('queries once for the whole batch, with each release key once', async () => {
      const { calls, store } = counting();
      const events = Array.from({ length: 30 }, (_, i) => makeEvent({ pkg: { packageId: `O${i}-M`, owner: `O${i}`, name: 'M' } }));
      const subs = [compiled(makeSubscription({ id: 'a' })), compiled(makeSubscription({ id: 'b' }))];
      await fanOut(events, subs, store, now);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(30);
      expect(new Set(calls[0]).size).toBe(30);
    });

    it('does not query when no event needs a cross-store check', async () => {
      const { calls, store } = counting();
      const noDedup = compiled(makeSubscription({ filter: { dedupAcrossStores: false } }));
      await fanOut([makeEvent()], [noDedup], store, now);
      const rejecting = compiled(makeSubscription({ filter: { kinds: ['update'] } }));
      await fanOut([makeEvent()], [rejecting], store, now);
      await fanOut([], [compiled()], store, now);
      expect(calls).toEqual([]);
    });

    it('only asks about events some dedup-enabled subscription would receive', async () => {
      const { calls, store } = counting();
      const wanted = makeEvent({ pkg: { packageId: 'A-New', owner: 'A', name: 'New' } });
      const nsfw = makeEvent({ pkg: { packageId: 'B-Nsfw', owner: 'B', name: 'Nsfw', isNsfw: true } });
      await fanOut([wanted, nsfw], [compiled()], store, now);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(1);
    });

    it('suppresses only when the other-store event also matches that subscription filter', async () => {
      const memory = new MemoryStore();
      const ts = makeEvent({ pkg: { store: 'thunderstore', owner: 'Au', name: 'Mod', version: '1.0.0' } });
      const hx = makeEvent({ pkg: { store: 'hexium', owner: 'Au', name: 'Mod', version: '1.0.0' } });
      await memory.commit({
        source: ts.pkg.source,
        packages: [],
        events: [ts],
        outbox: [],
        state: { id: ts.pkg.source, cursor: null, etag: null, bootstrapped: true, lastOkAt: null },
      });
      const open = compiled(makeSubscription({ id: 'open' }));
      const hxOnly = compiled(makeSubscription({ id: 'hx-only', filter: { sources: [hx.pkg.source] } }));
      const { rows } = await fanOut([hx], [open, hxOnly], memory, now);
      expect(rows.map((r) => r.subscriptionId)).toEqual(['hx-only']);
    });
  });
});

describe('fanOut: paused subscriptions', () => {
  const now = new Date('2026-09-19T12:07:00.000Z');
  const nowSeconds = now.getTime() / 1000;
  const rowsFor = async (pausedUntil: number | undefined): Promise<string[]> => {
    const paused = compiled(makeSubscription({ id: 'paused', mode: 'immediate', pausedUntil }));
    const active = compiled(makeSubscription({ id: 'active', mode: 'immediate' }));
    const { rows } = await fanOut([makeEvent()], [paused, active], new MemoryStore(), now);
    return rows.map((r) => r.subscriptionId);
  };

  it('queues nothing for a subscription paused until a later time, and still serves the others', async () => {
    expect(await rowsFor(nowSeconds + 60)).toEqual(['active']);
  });

  it('queues nothing for an open-ended pause', async () => {
    expect(await rowsFor(Number.MAX_SAFE_INTEGER)).toEqual(['active']);
  });

  it('resumes by itself once the pause time has passed, the boundary second included', async () => {
    expect(await rowsFor(nowSeconds)).toEqual(['paused', 'active']);
    expect(await rowsFor(nowSeconds - 1)).toEqual(['paused', 'active']);
  });

  it('treats 0 and an absent value as not paused', async () => {
    expect(await rowsFor(0)).toEqual(['paused', 'active']);
    expect(await rowsFor(undefined)).toEqual(['paused', 'active']);
  });

  it('does not queue the events of the pause afterwards', async () => {
    const paused = compiled(makeSubscription({ id: 'paused', mode: 'immediate', pausedUntil: nowSeconds + 3600 }));
    const during = await fanOut([makeEvent({ pkg: { owner: 'Au', name: 'During' } })], [paused], new MemoryStore(), now);
    const after = await fanOut([makeEvent({ pkg: { owner: 'Au', name: 'After' } })], [paused], new MemoryStore(), new Date(now.getTime() + 2 * 3_600_000));
    expect(during.rows).toEqual([]);
    expect(after.rows.map((r) => r.subscriptionId)).toEqual(['paused']);
    expect(after.rows[0]!.eventId).toBe(makeEvent({ pkg: { owner: 'Au', name: 'After' } }).id);
  });
});
