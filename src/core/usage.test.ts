// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { capLevel, exceededLevel } from './alerts.ts';
import { D1_FREE, MS_PER_DAY, PROJECTION_MIN_ELAPSED_MS } from './constants.ts';
import type { DailyUsage } from './ports.ts';
import { USAGE_SOURCE, degradationLevel, usageCaps } from './usage.ts';

const DATE = '2026-10-04';
const START = Date.parse(`${DATE}T00:00:00.000Z`);
const at = (msIntoDay: number): Date => new Date(START + msIntoDay);
const day = (over: Partial<DailyUsage> = {}): DailyUsage => ({ date: DATE, rowsRead: 0, rowsWritten: 0, databaseBytes: 6_000_000, ...over });
const ids = (d: DailyUsage, now: Date): string[] => usageCaps(d, now).map((c) => c.usage.id);
const find = (d: DailyUsage, now: Date, id: string) => usageCaps(d, now).find((c) => c.usage.id === id)!.usage;

describe('usageCaps', () => {
  it('files every limit under the d1 source with the daily and size limits and the 50/70/85/95 thresholds', () => {
    const caps = usageCaps(day({ rowsRead: 100, rowsWritten: 10 }), at(PROJECTION_MIN_ELAPSED_MS - 1));
    expect(caps.every((c) => c.source === USAGE_SOURCE)).toBe(true);
    expect(caps.map((c) => c.usage.id).slice(0, 3)).toEqual(['rows-read', 'rows-written', 'database-size']);
    const read = caps[0]!.usage;
    expect(read).toMatchObject({ limit: D1_FREE.rowsReadPerDay, value: 100, exceeded: false, constant: 'D1_FREE.rowsReadPerDay', unit: 'rows' });
    expect(read.thresholds).toEqual([0.5, 0.7, 0.85, 0.95]);
    expect(caps[2]!.usage).toMatchObject({ limit: D1_FREE.maxDatabaseBytes, value: 6_000_000, unit: 'bytes' });
  });

  it('leaves the size out when it is unknown', () => {
    expect(ids(day({ databaseBytes: null }), at(1000))).toEqual(['rows-read', 'rows-written', 'rows-read-projected', 'rows-written-projected']);
  });

  it('marks only the database size exceeded when it is reached: a daily limit resets at midnight, a full database does not', () => {
    expect(find(day({ rowsRead: D1_FREE.rowsReadPerDay * 2, rowsWritten: D1_FREE.rowsWrittenPerDay * 2 }), at(1000), 'rows-read').exceeded).toBe(false);
    expect(find(day({ rowsWritten: D1_FREE.rowsWrittenPerDay }), at(1000), 'rows-written').exceeded).toBe(false);
    expect(find(day({ databaseBytes: D1_FREE.maxDatabaseBytes - 1 }), at(1000), 'database-size').exceeded).toBe(false);
    expect(find(day({ databaseBytes: D1_FREE.maxDatabaseBytes }), at(1000), 'database-size').exceeded).toBe(true);
  });

  it('puts usage at the right level for the 50/70/85/95 thresholds', () => {
    const level = (share: number) => capLevel(find(day({ rowsRead: share * D1_FREE.rowsReadPerDay }), at(1000), 'rows-read'));
    expect([0.49, 0.5, 0.69, 0.7, 0.84, 0.85, 0.94, 0.95, 0.99, 1, 1.5].map(level)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4]);
    expect(capLevel(find(day({ databaseBytes: D1_FREE.maxDatabaseBytes }), at(1000), 'database-size'))).toBe(exceededLevel(find(day(), at(1000), 'database-size')));
  });

  describe('projection to 00:00 UTC', () => {
    it('starts after three hours of the day and stops at its end, reporting 0 outside that window so a stored level is lowered', () => {
      const projectedAt = (ms: number): number | null => find(day({ rowsRead: 1000 }), at(ms), 'rows-read-projected').value;
      expect(projectedAt(PROJECTION_MIN_ELAPSED_MS - 1)).toBe(0);
      expect(projectedAt(PROJECTION_MIN_ELAPSED_MS)).toBe(8000);
      expect(projectedAt(MS_PER_DAY)).toBe(0);
      expect(ids(day(), at(1000))).toEqual(['rows-read', 'rows-written', 'database-size', 'rows-read-projected', 'rows-written-projected']);
    });

    it('extrapolates the day so far to a full day', () => {
      const sixHours = at(6 * 3_600_000);
      const projected = find(day({ rowsRead: 1_000_000, rowsWritten: 10_000 }), sixHours, 'rows-read-projected');
      expect(projected.value).toBe(4_000_000);
      expect(find(day({ rowsRead: 1_000_000, rowsWritten: 10_000 }), sixHours, 'rows-written-projected').value).toBe(40_000);
    });

    it('alerts only when the projection passes the limit, and once at that', () => {
      const sixHours = at(6 * 3_600_000);
      const projection = (rowsRead: number) => find(day({ rowsRead }), sixHours, 'rows-read-projected');
      expect(capLevel(projection(1_249_999))).toBe(0);
      expect(capLevel(projection(1_250_000))).toBe(1);
      expect(projection(1_250_000).thresholds).toEqual([1]);
    });
  });
});

describe('degradationLevel', () => {
  const level = (read: number, written: number): number => degradationLevel(day({ rowsRead: read * D1_FREE.rowsReadPerDay, rowsWritten: written * D1_FREE.rowsWrittenPerDay }));

  it('is 0 below 70 % and steps up at 70, 85 and 95 %', () => {
    expect([0, 0.5, 0.69].map((s) => level(s, 0))).toEqual([0, 0, 0]);
    expect([0.7, 0.84].map((s) => level(s, 0))).toEqual([1, 1]);
    expect([0.85, 0.94].map((s) => level(s, 0))).toEqual([2, 2]);
    expect([0.95, 1.2].map((s) => level(s, 0))).toEqual([3, 3]);
  });

  it('follows the larger of the two daily limits', () => {
    expect(level(0.1, 0.86)).toBe(2);
    expect(level(0.96, 0.1)).toBe(3);
    expect(level(0.71, 0.72)).toBe(1);
  });

  it('ignores the database size, which only alerts', () => {
    expect(degradationLevel(day({ databaseBytes: D1_FREE.maxDatabaseBytes }))).toBe(0);
  });
});
