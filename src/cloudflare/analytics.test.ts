// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CloudflareUsageReader } from './analytics.ts';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'SENTINEL-ANALYTICS-TOKEN-9d41c7';
const NOW = new Date('2026-10-04T12:00:00.000Z');

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, string> };
}

function fakeFetch(respond: () => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)) as Call['body'],
    });
    return respond();
  };
  return { fetch: impl as typeof fetch, calls };
}

const answer = (account: unknown): Response => new Response(JSON.stringify({ data: { viewer: { accounts: [account] } } }), { status: 200 });

describe('CloudflareUsageReader', () => {
  it('posts the query to the GraphQL API with the bearer token, the account and the UTC date range', async () => {
    const { fetch: f, calls } = fakeFetch(() => answer({ usage: [], storage: [] }));
    await new CloudflareUsageReader(f, ACCOUNT, TOKEN).daily(NOW, 7);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://api.cloudflare.com/client/v4/graphql', method: 'POST' });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body.variables).toEqual({ accountTag: ACCOUNT, start: '2026-09-28', end: '2026-10-04' });
    expect(calls[0]!.body.query).toContain('d1AnalyticsAdaptiveGroups');
    expect(calls[0]!.body.query).toContain('d1StorageAdaptiveGroups');
    expect(calls[0]!.body.query).not.toContain(TOKEN);
  });

  it('returns one entry per day, oldest first, zeros for days without queries', async () => {
    const { fetch: f } = fakeFetch(() => answer({ usage: [{ sum: { rowsRead: 100, rowsWritten: 5 }, dimensions: { date: '2026-10-03' } }], storage: [] }));
    const days = await new CloudflareUsageReader(f, ACCOUNT, TOKEN).daily(NOW, 3);
    expect(days).toEqual([
      { date: '2026-10-02', rowsRead: 0, rowsWritten: 0, databaseBytes: null },
      { date: '2026-10-03', rowsRead: 100, rowsWritten: 5, databaseBytes: null },
      { date: '2026-10-04', rowsRead: 0, rowsWritten: 0, databaseBytes: null },
    ]);
  });

  it('adds up several groups of a day and takes the largest database size', async () => {
    const { fetch: f } = fakeFetch(() =>
      answer({
        usage: [
          { sum: { rowsRead: 100, rowsWritten: 5 }, dimensions: { date: '2026-10-04' } },
          { sum: { rowsRead: 50, rowsWritten: 1 }, dimensions: { date: '2026-10-04' } },
        ],
        storage: [
          { max: { databaseSizeBytes: 6_000_000 }, dimensions: { date: '2026-10-04' } },
          { max: { databaseSizeBytes: 9_500_000 }, dimensions: { date: '2026-10-04' } },
        ],
      }),
    );
    expect(await new CloudflareUsageReader(f, ACCOUNT, TOKEN).daily(NOW, 1)).toEqual([{ date: '2026-10-04', rowsRead: 150, rowsWritten: 6, databaseBytes: 9_500_000 }]);
  });

  it('ignores groups outside the range and values of the wrong type', async () => {
    const { fetch: f } = fakeFetch(() =>
      answer({
        usage: [
          { sum: { rowsRead: 7, rowsWritten: 7 }, dimensions: { date: '2026-09-01' } },
          { sum: { rowsRead: '9', rowsWritten: -3 }, dimensions: { date: '2026-10-04' } },
          { sum: { rowsRead: 1, rowsWritten: 2 }, dimensions: {} },
        ],
        storage: [{ max: { databaseSizeBytes: 'big' }, dimensions: { date: '2026-10-04' } }],
      }),
    );
    expect(await new CloudflareUsageReader(f, ACCOUNT, TOKEN).daily(NOW, 1)).toEqual([{ date: '2026-10-04', rowsRead: 0, rowsWritten: 0, databaseBytes: null }]);
  });

  it('fails on an HTTP error without putting the token in the message', async () => {
    const { fetch: f } = fakeFetch(() => new Response(`forbidden ${TOKEN}`, { status: 403 }));
    let message = '';
    try {
      await new CloudflareUsageReader(f, ACCOUNT, TOKEN).daily(NOW, 1);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe('analytics API answered 403');
    expect(message).not.toContain(TOKEN);
  });

  it('fails on a GraphQL error, naming it', async () => {
    const { fetch: f } = fakeFetch(() => new Response(JSON.stringify({ data: null, errors: [{ message: 'not authorized for that field' }] }), { status: 200 }));
    await expect(new CloudflareUsageReader(f, ACCOUNT, TOKEN).daily(NOW, 1)).rejects.toThrow('analytics API error: not authorized for that field');
  });

  it('fails when the answer has no usage groups at all, instead of reading it as zero usage', async () => {
    for (const account of [{}, { usage: null }, { storage: [] }]) {
      const { fetch: f } = fakeFetch(() => answer(account));
      await expect(new CloudflareUsageReader(f, ACCOUNT, TOKEN).daily(NOW, 1), JSON.stringify(account)).rejects.toThrow('no usage groups');
    }
  });

  it('reads a missing storage list as an unknown database size', async () => {
    const { fetch: f } = fakeFetch(() => answer({ usage: [] }));
    expect(await new CloudflareUsageReader(f, ACCOUNT, TOKEN).daily(NOW, 1)).toEqual([{ date: '2026-10-04', rowsRead: 0, rowsWritten: 0, databaseBytes: null }]);
  });

  it('fails when the answer carries no account', async () => {
    const { fetch: f } = fakeFetch(() => new Response(JSON.stringify({ data: { viewer: { accounts: [] } } }), { status: 200 }));
    await expect(new CloudflareUsageReader(f, ACCOUNT, TOKEN).daily(NOW, 1)).rejects.toThrow('no account');
  });

  it('lets a network failure propagate', async () => {
    const { fetch: f } = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(new CloudflareUsageReader(f, ACCOUNT, TOKEN).daily(NOW, 1)).rejects.toThrow('fetch failed');
  });
});
