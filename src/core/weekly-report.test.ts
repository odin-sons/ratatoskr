// SPDX-License-Identifier: AGPL-3.0-or-later
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { D1_FREE, PROJECT } from './constants.ts';
import type { DailyUsage } from './ports.ts';
import { buildWeeklyReport } from './weekly-report.ts';

const days = (over: Partial<DailyUsage>[] = []): DailyUsage[] =>
  Array.from({ length: 7 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10),
    rowsRead: 200_000 + i * 1000,
    rowsWritten: 9_000,
    databaseBytes: 6_300_000,
    ...over[i],
  }));

function chartCode(description: string): string {
  const link = /\(https:\/\/mermaid\.live\/edit#pako:([A-Za-z0-9_-]+)\)/.exec(description);
  expect(link, 'a Mermaid Live link').not.toBeNull();
  const base64 = link![1]!.replaceAll('-', '+').replaceAll('_', '/');
  return (JSON.parse(new TextDecoder().decode(inflateSync(Buffer.from(base64, 'base64')))) as { code: string }).code;
}

describe('buildWeeklyReport', () => {
  it('is one embed with a table row per day, a chart image and an edit link, and never pings', async () => {
    const message = await buildWeeklyReport(days(), 0);
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.embeds).toHaveLength(1);
    const embed = message.embeds![0]!;
    expect(embed.title).toBe('ratatoskr: D1 usage, last 7 days');
    const table = embed.description!.split('```')[1]!.trim().split('\n');
    expect(table).toHaveLength(8);
    expect(table[0]).toContain('reads');
    expect(table[1]).toContain('09-28');
    expect(table[7]).toContain('10-04*');
    expect(embed.image!.url).toMatch(/^https:\/\/mermaid\.ink\/img\/pako:[A-Za-z0-9_-]+\?type=png&theme=dark$/);
  });

  it('shows rows, shares of the limits and the database size', async () => {
    const [first] = (await buildWeeklyReport(days([{ rowsRead: 191_650, rowsWritten: 8_160, databaseBytes: 6_400_000 }]), 0)).embeds!;
    const row = first!.description!.split('```')[1]!.trim().split('\n')[1]!;
    expect(row).toContain('191,650');
    expect(row).toContain('3.8%');
    expect(row).toContain('8,160');
    expect(row).toContain('8.2%');
    expect(row).toContain('6.4 MB');
  });

  it('draws the reads, the writes and the 70 and 95 percent lines, as percentages', async () => {
    const embed = (await buildWeeklyReport(days([{ rowsRead: 250_000, rowsWritten: 10_000 }]), 0)).embeds![0]!;
    const code = chartCode(embed.description!).split('\n');
    expect(code[1]).toBe('xychart-beta');
    expect(code).toContain('    y-axis "percent" 0 --> 100');
    const lines = code.filter((l) => l.trim().startsWith('line'));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^ {4}line \[5, /);
    expect(lines[1]).toMatch(/^ {4}line \[10, /);
    expect(lines[2]).toBe('    line [70, 70, 70, 70, 70, 70, 70]');
    expect(lines[3]).toBe('    line [95, 95, 95, 95, 95, 95, 95]');
  });

  it('raises the y-axis when a day went past its limit', async () => {
    const embed = (await buildWeeklyReport(days([{ rowsWritten: D1_FREE.rowsWrittenPerDay * 1.34 }]), 0)).embeds![0]!;
    expect(chartCode(embed.description!)).toContain('0 --> 140');
  });

  it('says whether a degradation step is active', async () => {
    expect((await buildWeeklyReport(days(), 0)).embeds![0]!.description).toContain('Degradation: none.');
    expect((await buildWeeklyReport(days(), 2)).embeds![0]!.description).toContain('step 2 is active');
  });

  it('carries the daily limits and the project link', async () => {
    const description = (await buildWeeklyReport(days(), 0)).embeds![0]!.description!;
    expect(description).toContain('5,000,000 rows read and 100,000 rows written a day');
    expect(description).toContain(`[ratatoskr v${PROJECT.version}](${PROJECT.repoUrl})`);
  });

  it('copes with an unknown database size', async () => {
    const embed = (await buildWeeklyReport(days([{ databaseBytes: null }]), 0)).embeds![0]!;
    expect(embed.description!.split('```')[1]).toContain(' -');
  });

  it('keeps the whole embed description inside Discord limits', async () => {
    const description = (await buildWeeklyReport(days(), 3)).embeds![0]!.description!;
    expect(description.length).toBeLessThan(4096);
  });
});
