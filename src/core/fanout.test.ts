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

  it('flags new events and watchlist hits as detailed, not other updates', async () => {
    const sub = compiled(makeSubscription({ filter: { watchlist: ['Star-Mod'] } }));
    const fresh = makeEvent({ pkg: { packageId: 'A-New' } });
    const hit = makeEvent({ kind: 'update', versionFrom: '0.1.0', pkg: { owner: 'Star', name: 'Mod', packageId: 'Star-Mod' } });
    const plain = makeEvent({ kind: 'update', versionFrom: '0.1.0', pkg: { packageId: 'A-Plain', name: 'Plain' } });
    const { detailedEventIds } = await fanOut([fresh, hit, plain], [sub], new MemoryStore(), now);
    expect([...detailedEventIds].sort()).toEqual([fresh.id, hit.id].sort());
  });
});
