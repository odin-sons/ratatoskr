// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_SCAN_BYTES } from '../core/constants.ts';
import type { PollContext, PollResult } from '../core/ports.ts';
import { FETCH_TIMEOUT_MS } from './budget.ts';

/** Stored validators are either a raw ETag or `lm:<Last-Modified>` for hosts that only send Last-Modified. */
const LAST_MODIFIED_PREFIX = 'lm:';

const FORBIDDEN_CUSTOM_HEADERS = new Set(['authorization', 'apikey', 'cookie', 'user-agent']);

export interface Credentials {
  header: string;
  value: string;
  /** The value is attached only to requests whose hostname equals this. */
  host: string;
}

export interface GetOptions {
  /** `undefined` = use `ctx.state.etag`; `null` = unconditional. */
  validator?: string | null;
  headers?: Record<string, string>;
  credentials?: Credentials;
  maxBytes?: number;
}

export type GetResult =
  | { status: 'not-modified' }
  | { status: 'ok'; text: string; etag: string | null; headers: Headers };

export class UpstreamError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(url: string, status: number, retryAfterSeconds: number | null = null) {
    super(`HTTP ${status} from ${safeUrl(url)}`);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ResponseTooLargeError extends Error {
  constructor(url: string, limit: number) {
    super(`response from ${safeUrl(url)} exceeds ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

export function validatorFrom(headers: Headers): string | null {
  const etag = headers.get('etag');
  if (etag) return etag;
  const lastModified = headers.get('last-modified');
  return lastModified ? `${LAST_MODIFIED_PREFIX}${lastModified}` : null;
}

function parseRetryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

async function readLimited(response: Response, url: string, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new ResponseTooLargeError(url, limit);
  }
  if (!response.body) {
    const text = await response.text();
    if (text.length > limit) throw new ResponseTooLargeError(url, limit);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new ResponseTooLargeError(url, limit);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(chunks.length === 1 ? chunks[0] : concat(chunks, bytes));
}

function concat(chunks: Uint8Array[], bytes: number): Uint8Array {
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

export async function conditionalGet(ctx: PollContext, url: string, opts: GetOptions = {}): Promise<GetResult> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    if (FORBIDDEN_CUSTOM_HEADERS.has(name.toLowerCase())) {
      throw new Error(`header ${name} must not be passed through opts.headers`);
    }
    headers[name] = value;
  }
  headers['User-Agent'] = ctx.userAgent;

  const target = new URL(url);
  const credentialed = opts.credentials !== undefined && target.hostname === opts.credentials.host;
  if (opts.credentials && credentialed) headers[opts.credentials.header] = opts.credentials.value;

  const validator = opts.validator === undefined ? (ctx.state?.etag ?? null) : opts.validator;
  if (validator) {
    if (validator.startsWith(LAST_MODIFIED_PREFIX)) {
      headers['If-Modified-Since'] = validator.slice(LAST_MODIFIED_PREFIX.length);
    } else {
      headers['If-None-Match'] = validator;
    }
  }

  const response = await ctx.fetch(url, {
    method: 'GET',
    headers,
    redirect: credentialed ? 'manual' : 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status === 304) {
    await response.body?.cancel();
    return { status: 'not-modified' };
  }
  if (!response.ok) {
    await response.body?.cancel();
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'), ctx.now);
    throw new UpstreamError(url, response.status, retryAfter);
  }
  const text = await readLimited(response, url, opts.maxBytes ?? MAX_SCAN_BYTES);
  return { status: 'ok', text, etag: validatorFrom(response.headers), headers: response.headers };
}

/** Logs one line and converts any failure into a skipped poll. Never logs headers or bodies. */
export function skipOnError(sourceId: string, err: unknown): PollResult {
  console.warn(`[${sourceId}] poll skipped: ${describeError(err)}`);
  return { status: 'skipped' };
}

export function describeError(err: unknown): string {
  if (err instanceof UpstreamError) {
    return err.retryAfterSeconds !== null ? `${err.message} (retry-after ${err.retryAfterSeconds}s)` : err.message;
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
}
