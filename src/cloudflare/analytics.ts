// SPDX-License-Identifier: AGPL-3.0-or-later
import { MS_PER_DAY, USAGE_API } from '../core/constants.ts';
import type { DailyUsage, UsageReader } from '../core/ports.ts';

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

const QUERY = `query D1Usage($accountTag: String!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      usage: d1AnalyticsAdaptiveGroups(limit: ${USAGE_API.groupLimit}, filter: { date_geq: $start, date_leq: $end }) {
        sum { rowsRead rowsWritten }
        dimensions { date }
      }
      storage: d1StorageAdaptiveGroups(limit: ${USAGE_API.groupLimit}, filter: { date_geq: $start, date_leq: $end }) {
        max { databaseSizeBytes }
        dimensions { date }
      }
    }
  }
}`;

interface Group {
  sum?: { rowsRead?: unknown; rowsWritten?: unknown };
  max?: { databaseSizeBytes?: unknown };
  dimensions?: { date?: unknown };
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const asCount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

/** Reads D1 usage of the whole account from the Cloudflare GraphQL analytics API. The token needs only Account Analytics: Read. */
export class CloudflareUsageReader implements UsageReader {
  private readonly fetchImpl: typeof fetch;
  private readonly accountId: string;
  private readonly token: string;

  constructor(fetchImpl: typeof fetch, accountId: string, token: string) {
    this.fetchImpl = fetchImpl;
    this.accountId = accountId;
    this.token = token;
  }

  async daily(now: Date, days: number): Promise<DailyUsage[]> {
    const end = isoDate(now.getTime());
    const start = isoDate(now.getTime() - (days - 1) * MS_PER_DAY);
    const res = await this.fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ query: QUERY, variables: { accountTag: this.accountId, start, end } }),
      signal: AbortSignal.timeout(USAGE_API.timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`analytics API answered ${res.status}`);
    }
    const body = (await res.json()) as { data?: { viewer?: { accounts?: { usage?: Group[]; storage?: Group[] }[] } }; errors?: { message?: unknown }[] } | null;
    if (body?.errors !== undefined && body.errors !== null && body.errors.length > 0) {
      throw new Error(`analytics API error: ${String(body.errors[0]?.message ?? 'unknown')}`);
    }
    const account = body?.data?.viewer?.accounts?.[0];
    if (account === undefined) throw new Error('analytics API returned no account');
    if (!Array.isArray(account.usage)) throw new Error('analytics API returned no usage groups');
    return this.merge(start, days, account.usage, Array.isArray(account.storage) ? account.storage : []);
  }

  private merge(start: string, days: number, usage: Group[], storage: Group[]): DailyUsage[] {
    const byDate = new Map<string, DailyUsage>();
    for (let i = 0; i < days; i += 1) {
      const date = isoDate(Date.parse(`${start}T00:00:00.000Z`) + i * MS_PER_DAY);
      byDate.set(date, { date, rowsRead: 0, rowsWritten: 0, databaseBytes: null });
    }
    for (const group of usage) {
      const day = typeof group.dimensions?.date === 'string' ? byDate.get(group.dimensions.date) : undefined;
      if (day === undefined) continue;
      day.rowsRead += asCount(group.sum?.rowsRead);
      day.rowsWritten += asCount(group.sum?.rowsWritten);
    }
    for (const group of storage) {
      const day = typeof group.dimensions?.date === 'string' ? byDate.get(group.dimensions.date) : undefined;
      const bytes = group.max?.databaseSizeBytes;
      if (day === undefined || typeof bytes !== 'number' || !Number.isFinite(bytes)) continue;
      day.databaseBytes = Math.max(day.databaseBytes ?? 0, bytes);
    }
    return [...byDate.values()];
  }
}
