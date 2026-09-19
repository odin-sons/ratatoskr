// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeFetch, json, makeCtx, makeState, text } from './__fixtures__/fake-fetch.ts';
import { ResponseTooLargeError, UpstreamError, conditionalGet, skipOnError, validatorFrom } from './http.ts';

afterEach(() => vi.restoreAllMocks());

describe('conditionalGet', () => {
  it('always sends the configured User-Agent', async () => {
    const fake = createFakeFetch([['example.test', () => json({ ok: true })]]);
    const ctx = makeCtx(fake);
    await conditionalGet(ctx, 'https://example.test/a');
    expect(fake.calls[0]?.headers['user-agent']).toBe(ctx.userAgent);
  });

  it('sends If-None-Match from the stored ETag and returns not-modified on 304', async () => {
    const fake = createFakeFetch([['example.test', () => new Response(null, { status: 304 })]]);
    const ctx = makeCtx(fake, { state: makeState({ etag: '"abc"' }) });
    const res = await conditionalGet(ctx, 'https://example.test/a');
    expect(res).toEqual({ status: 'not-modified' });
    expect(fake.calls[0]?.headers['if-none-match']).toBe('"abc"');
    expect(fake.calls[0]?.headers['if-modified-since']).toBeUndefined();
  });

  it('round-trips Last-Modified through the etag slot as If-Modified-Since', async () => {
    const first = createFakeFetch([['example.test', () => text('{}', { 'last-modified': 'Sat, 19 Sep 2026 00:01:03 GMT' })]]);
    const res = await conditionalGet(makeCtx(first), 'https://example.test/a');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.etag).toBe('lm:Sat, 19 Sep 2026 00:01:03 GMT');

    const second = createFakeFetch([['example.test', () => new Response(null, { status: 304 })]]);
    await conditionalGet(makeCtx(second, { state: makeState({ etag: res.etag }) }), 'https://example.test/a');
    expect(second.calls[0]?.headers['if-modified-since']).toBe('Sat, 19 Sep 2026 00:01:03 GMT');
    expect(second.calls[0]?.headers['if-none-match']).toBeUndefined();
  });

  it('prefers ETag over Last-Modified when both are present', () => {
    expect(validatorFrom(new Headers({ etag: '"e"', 'last-modified': 'x' }))).toBe('"e"');
    expect(validatorFrom(new Headers())).toBeNull();
  });

  it('is unconditional when validator is null', async () => {
    const fake = createFakeFetch([['example.test', () => json({})]]);
    await conditionalGet(makeCtx(fake, { state: makeState({ etag: '"abc"' }) }), 'https://example.test/a', { validator: null });
    expect(fake.calls[0]?.headers['if-none-match']).toBeUndefined();
  });

  it('throws UpstreamError with parsed Retry-After on 429', async () => {
    const fake = createFakeFetch([['example.test', () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })]]);
    const err = await conditionalGet(makeCtx(fake), 'https://example.test/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(429);
    expect((err as UpstreamError).retryAfterSeconds).toBe(30);
  });

  it('parses an HTTP-date Retry-After relative to ctx.now', async () => {
    const fake = createFakeFetch([
      ['example.test', () => new Response('', { status: 503, headers: { 'retry-after': 'Sat, 19 Sep 2026 00:06:00 GMT' } })],
    ]);
    const err = (await conditionalGet(makeCtx(fake), 'https://example.test/a').catch((e: unknown) => e)) as UpstreamError;
    expect(err.retryAfterSeconds).toBe(60);
  });

  it('treats other non-2xx as errors', async () => {
    const fake = createFakeFetch([]);
    await expect(conditionalGet(makeCtx(fake), 'https://example.test/missing')).rejects.toBeInstanceOf(UpstreamError);
  });

  it('rejects a declared Content-Length above the limit', async () => {
    const fake = createFakeFetch([['example.test', () => new Response('x', { headers: { 'content-length': '999' } })]]);
    await expect(conditionalGet(makeCtx(fake), 'https://example.test/a', { maxBytes: 100 })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('aborts a streamed body that exceeds the limit', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(60));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const fake = createFakeFetch([['example.test', () => new Response(body)]]);
    await expect(conditionalGet(makeCtx(fake), 'https://example.test/a', { maxBytes: 100 })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('reassembles multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('héllo — wörld');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of bytes) controller.enqueue(new Uint8Array([b]));
        controller.close();
      },
    });
    const fake = createFakeFetch([['example.test', () => new Response(body)]]);
    const res = await conditionalGet(makeCtx(fake), 'https://example.test/a');
    expect(res.status === 'ok' && res.text).toBe('héllo — wörld');
  });

  describe('credentials', () => {
    const credentials = { header: 'apikey', value: 'SECRET', host: 'api.example.test' };

    it('attaches the credential only to the matching host', async () => {
      const fake = createFakeFetch([['example.test', () => json({})]]);
      const ctx = makeCtx(fake);
      await conditionalGet(ctx, 'https://api.example.test/x', { credentials });
      await conditionalGet(ctx, 'https://other.example.test/x', { credentials });
      expect(fake.calls[0]?.headers.apikey).toBe('SECRET');
      expect(fake.calls[1]?.headers.apikey).toBeUndefined();
    });

    it('does not follow redirects on credentialed requests', async () => {
      let init: RequestInit | undefined;
      const fetchImpl = (async (_url: unknown, i?: RequestInit) => {
        init = i;
        return new Response('', { status: 302, headers: { location: 'https://evil.test/' } });
      }) as typeof fetch;
      const ctx = { ...makeCtx(createFakeFetch([])), fetch: fetchImpl };
      await expect(conditionalGet(ctx, 'https://api.example.test/x', { credentials })).rejects.toBeInstanceOf(UpstreamError);
      expect(init?.redirect).toBe('manual');
    });

    it('refuses sensitive headers passed through the generic header option', async () => {
      const ctx = makeCtx(createFakeFetch([]));
      await expect(conditionalGet(ctx, 'https://x.test/', { headers: { apikey: 'k' } })).rejects.toThrow();
      await expect(conditionalGet(ctx, 'https://x.test/', { headers: { Authorization: 'k' } })).rejects.toThrow();
    });

    it('never puts the credential into an error message', async () => {
      const fake = createFakeFetch([['example.test', () => new Response('no', { status: 500 })]]);
      const err = (await conditionalGet(makeCtx(fake), 'https://api.example.test/x?apikey=SECRET', { credentials }).catch((e: unknown) => e)) as Error;
      expect(err.message).not.toContain('SECRET');
    });
  });
});

describe('skipOnError', () => {
  it('logs one line with the source id and returns skipped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(skipOnError('thunderstore:valheim', new UpstreamError('https://x.test/a?q=1', 429, 12))).toEqual({ status: 'skipped' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('thunderstore:valheim');
    expect(line).toContain('429');
    expect(line).toContain('retry-after 12s');
    expect(line).not.toContain('q=1');
  });
});
