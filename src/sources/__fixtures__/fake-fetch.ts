// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PollContext } from '../../core/ports.ts';
import type { SourceState } from '../../core/types.ts';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
  callsTo(fragment: string): RecordedCall[];
}

/** Routes match by substring of the full URL, first match wins. Unmatched requests answer 404. */
export function createFakeFetch(routes: Array<[string, Responder]>): FakeFetch {
  const calls: RecordedCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers };
    calls.push(call);
    for (const [fragment, responder] of routes) {
      if (url.includes(fragment)) return responder(call);
    }
    return new Response('not found', { status: 404 });
  };
  return {
    fetch: impl as typeof fetch,
    calls,
    callsTo: (fragment) => calls.filter((c) => c.url.includes(fragment)),
  };
}

export function fixture(name: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), 'utf8');
}

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export function text(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

export function makeState(over: Partial<SourceState> = {}): SourceState {
  return { id: 'test:src', cursor: null, etag: null, bootstrapped: true, lastOkAt: null, ...over };
}

export function makeCtx(fake: FakeFetch, over: Partial<PollContext> = {}): PollContext {
  return {
    fetch: fake.fetch,
    userAgent: 'ratatoskr-test/0.0.0 (+https://example.invalid/ratatoskr)',
    state: makeState(),
    tickIndex: 1,
    now: new Date('2026-09-19T00:05:00Z'),
    secrets: {},
    ...over,
  };
}
