// SPDX-License-Identifier: AGPL-3.0-or-later
import { D1_FREE, DEGRADATION_THRESHOLDS, PROJECT } from './constants.ts';
import { diagramEditUrl, diagramImageUrl, encodeDiagram, xyChartCode } from './mermaid.ts';
import type { DailyUsage } from './ports.ts';
import type { DiscordMessage } from './types.ts';

const EMBED_COLOR = 0x5865f2;
const COLORS = ['#4c9be8', '#b07cf0', '#e8c03a', '#e85d4c'];

const percent = (value: number, limit: number): number => Math.round((value / limit) * 1000) / 10;
const count = (n: number): string => n.toLocaleString('en-US');
const megabytes = (bytes: number | null): string => (bytes === null ? '-' : `${(bytes / 1_000_000).toFixed(1)} MB`);
const shortDate = (date: string): string => date.slice(5);

/** The chart's y-axis: 0 to 100 percent, higher when a day passed its limit. */
function yMax(values: number[]): number {
  const top = Math.max(100, ...values);
  return Math.ceil(top / 10) * 10;
}

/** The weekly D1 usage message: a table, a degradation line, and the usage chart as a mermaid.ink image with an edit link. */
export function buildWeeklyReport(days: DailyUsage[], degradation: number): DiscordMessage {
  const reads = days.map((d) => percent(d.rowsRead, D1_FREE.rowsReadPerDay));
  const writes = days.map((d) => percent(d.rowsWritten, D1_FREE.rowsWrittenPerDay));
  const sizes = days.map((d) => (d.databaseBytes === null ? 0 : percent(d.databaseBytes, D1_FREE.maxDatabaseBytes)));
  const [warn, danger] = [DEGRADATION_THRESHOLDS[0] * 100, DEGRADATION_THRESHOLDS[2] * 100];

  const rows = days.map((d, i) => {
    const day = `${shortDate(d.date)}${i === days.length - 1 ? '*' : ' '}`;
    return `${day}  ${count(d.rowsRead).padStart(9)} ${reads[i]!.toFixed(1).padStart(5)}%  ${count(d.rowsWritten).padStart(7)} ${writes[i]!.toFixed(1).padStart(5)}%  ${megabytes(d.databaseBytes).padStart(8)}`;
  });
  const table = ['day         reads      %    writes      %        db', ...rows].join('\n');

  const code = xyChartCode({
    title: 'D1 usage, % of the daily free limit',
    yTitle: 'percent',
    yMax: yMax([...reads, ...writes, ...sizes]),
    labels: days.map((d) => shortDate(d.date)),
    series: [
      { kind: 'line', values: reads },
      { kind: 'line', values: writes },
      { kind: 'line', values: days.map(() => warn) },
      { kind: 'line', values: days.map(() => danger) },
    ],
    colors: COLORS,
  });
  const encoded = encodeDiagram(code);

  const status = degradation === 0 ? 'Degradation: none.' : `Degradation: step ${degradation} is active (see the usage monitor in docs/spec.md).`;
  const description = [
    `\`\`\`\n${table}\n\`\`\``,
    `Limits: ${count(D1_FREE.rowsReadPerDay)} rows read and ${count(D1_FREE.rowsWrittenPerDay)} rows written a day, ${megabytes(D1_FREE.maxDatabaseBytes)} per database. \\* is today so far.`,
    status,
    `[Open the chart in Mermaid Live](${diagramEditUrl(encoded)})`,
    `-# [ratatoskr v${PROJECT.version}](${PROJECT.repoUrl})`,
  ].join('\n');

  return {
    embeds: [{ title: 'ratatoskr: D1 usage, last 7 days', description, color: EMBED_COLOR, image: { url: diagramImageUrl(encoded) } }],
    allowed_mentions: { parse: [] },
  };
}
