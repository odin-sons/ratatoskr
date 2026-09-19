// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { makeSnapshot } from '../testing/fakes.ts';
import { diffSnapshots } from './diff.ts';
import { eventId } from './ids.ts';

const now = new Date('2026-09-19T12:00:00.000Z');

describe('diffSnapshots', () => {
  it('emits new for an unknown package', () => {
    const snap = makeSnapshot({ packageId: 'A-B', version: '1.0.0' });
    const { events } = diffSnapshots(new Map(), [snap], now);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'new',
      versionFrom: null,
      versionTo: '1.0.0',
      id: eventId(snap.source, 'A-B', '1.0.0'),
      createdAt: now.toISOString(),
      changelog: null,
      alsoOn: [],
    });
  });

  it('emits update with versionFrom when the version differs', () => {
    const snap = makeSnapshot({ packageId: 'A-B', version: '1.1.0' });
    const { events } = diffSnapshots(new Map([['A-B', '1.0.0']]), [snap], now);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'update', versionFrom: '1.0.0', versionTo: '1.1.0' });
  });

  it('emits nothing for the same version', () => {
    const snap = makeSnapshot({ packageId: 'A-B', version: '1.0.0' });
    expect(diffSnapshots(new Map([['A-B', '1.0.0']]), [snap], now).events).toEqual([]);
  });

  it('never triggers on a timestamp-only change', () => {
    const snap = makeSnapshot({ packageId: 'A-B', version: '1.0.0', updatedAt: '2030-01-01T00:00:00.000Z' });
    expect(diffSnapshots(new Map([['A-B', '1.0.0']]), [snap], now).events).toEqual([]);
  });

  it('dedupes duplicate ids in a batch keeping the newest updatedAt', () => {
    const older = makeSnapshot({ packageId: 'A-B', version: '1.0.0', updatedAt: '2026-09-19T10:00:00.000Z' });
    const newer = makeSnapshot({ packageId: 'A-B', version: '1.0.1', updatedAt: '2026-09-19T11:00:00.000Z' });
    const { events } = diffSnapshots(new Map(), [newer, older], now);
    expect(events.map((e) => e.versionTo)).toEqual(['1.0.1']);
  });

  it('is deterministic across runs', () => {
    const snaps = [makeSnapshot({ packageId: 'A-B' }), makeSnapshot({ packageId: 'C-D' })];
    const a = diffSnapshots(new Map(), snaps, now).events.map((e) => e.id);
    const b = diffSnapshots(new Map(), snaps, now).events.map((e) => e.id);
    expect(a).toEqual(b);
  });
});
