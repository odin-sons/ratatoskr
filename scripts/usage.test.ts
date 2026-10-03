// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { formatUsage, parseCli } from './usage.ts';

describe('parseCli', () => {
  it('defaults to one day and plain text', () => {
    expect(parseCli([])).toEqual({ days: 1, json: false, help: false });
  });

  it('reads --days and --json, and drops a pnpm-forwarded --', () => {
    expect(parseCli(['--', '--days', '7', '--json'])).toEqual({ days: 7, json: true, help: false });
    expect(parseCli(['--help']).help).toBe(true);
  });

  it('refuses a day count outside 1 to 31', () => {
    for (const bad of ['0', '32', '-1', '2.5', 'many']) expect(() => parseCli(['--days', bad]), bad).toThrow('--days');
  });
});

describe('formatUsage', () => {
  it('prints one line per day with rows, shares of the daily limits and the database size', () => {
    const out = formatUsage([
      { date: '2026-10-02', rowsRead: 191_650, rowsWritten: 8_160, databaseBytes: 6_400_000 },
      { date: '2026-10-03', rowsRead: 0, rowsWritten: 0, databaseBytes: null },
    ]).split('\n');
    expect(out).toEqual([
      '2026-10-02  read 191,650 (3.8 %)  written 8,160 (8.2 %)  largest database 6.4 MB (1.3 %)',
      '2026-10-03  read 0 (0.0 %)  written 0 (0.0 %)  largest database -',
    ]);
  });
});
