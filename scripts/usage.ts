// SPDX-License-Identifier: AGPL-3.0-or-later
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { D1_FREE } from '../src/core/constants.ts';
import type { DailyUsage } from '../src/core/ports.ts';
import { CloudflareUsageReader } from '../src/cloudflare/analytics.ts';

const MAX_DAYS = 31;

const HELP = `Usage: pnpm run usage [--days <1-${MAX_DAYS}>] [--json]

Prints the D1 usage of the whole Cloudflare account per UTC day, as the usage monitor reads it.
Needs CLOUDFLARE_ANALYTICS_TOKEN (Account Analytics: Read) and CLOUDFLARE_ACCOUNT_ID in .env.`;

const percent = (value: number, limit: number): string => `${((value / limit) * 100).toFixed(1)} %`;

/** One line per day: rows read and written with their share of the daily limits, and the largest database. */
export function formatUsage(days: DailyUsage[]): string {
  const lines = days.map((d) => {
    const size = d.databaseBytes === null ? '-' : `${(d.databaseBytes / 1_000_000).toFixed(1)} MB (${percent(d.databaseBytes, D1_FREE.maxDatabaseBytes)})`;
    return `${d.date}  read ${d.rowsRead.toLocaleString('en-US')} (${percent(d.rowsRead, D1_FREE.rowsReadPerDay)})  written ${d.rowsWritten.toLocaleString('en-US')} (${percent(d.rowsWritten, D1_FREE.rowsWrittenPerDay)})  largest database ${size}`;
  });
  return lines.join('\n');
}

export function parseCli(argv: string[]): { days: number; json: boolean; help: boolean } {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: { days: { type: 'string', default: '1' }, json: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
  });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`--days must be a whole number from 1 to ${MAX_DAYS}`);
  return { days, json: values.json as boolean, help: values.help as boolean };
}

async function main(): Promise<number> {
  let cli: ReturnType<typeof parseCli>;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`usage: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (cli.help) {
    console.log(HELP);
    return 0;
  }
  const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN?.trim();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) {
    console.error('usage: CLOUDFLARE_ANALYTICS_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set (see .env.example)');
    return 1;
  }
  try {
    const days = await new CloudflareUsageReader(fetch, accountId, token).daily(new Date(), cli.days);
    console.log(cli.json ? JSON.stringify(days, null, 2) : formatUsage(days));
    return 0;
  } catch (err) {
    console.error(`usage: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
