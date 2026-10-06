// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERACTION_BODY_MAX_BYTES } from '../core/constants.ts';
import { generateKeyPair, interactionPayload, sign, signedRequest, NOW_TIMESTAMP, type TestKeyPair } from '../testing/signing.ts';
import worker, { type Env } from './worker.ts';

/** A D1 stand-in that fails the test on any use: the endpoint must not touch storage before the signature passes. */
const forbiddenDb = new Proxy({} as object, {
  get(_target, property) {
    throw new Error(`D1 touched: ${String(property)}`);
  },
}) as D1Database;

let keys: TestKeyPair;
let otherKeys: TestKeyPair;
let pending: Promise<unknown>[];

const ctx = (): ExecutionContext => ({ waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} }) as unknown as ExecutionContext;
const envWith = (over: Partial<Env> = {}): Env => ({ DB: forbiddenDb, DISCORD_PUBLIC_KEY: keys.publicKeyHex, ...over });
const call = (request: Request, env: Env = envWith()): Promise<Response> => Promise.resolve(worker.fetch!(request as never, env, ctx()));

beforeAll(async () => {
  keys = await generateKeyPair();
  otherKeys = await generateKeyPair();
});

beforeEach(() => {
  pending = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('POST /interactions', () => {
  it('answers a signed PING with a PONG', async () => {
    const res = await call(await signedRequest(keys, { type: 1 }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ type: 1 });
  });

  it('answers an unknown command with an ephemeral message in the configured language', async () => {
    const res = await call(await signedRequest(keys, interactionPayload({ data: { name: 'nope' } })), envWith({ LANGUAGE: 'ru' }));
    const body = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toBe('Неизвестная команда.');
  });

  it('rejects a tampered body with 401', async () => {
    const request = await signedRequest(keys, { type: 1 });
    const tampered = new Request(request.url, { method: 'POST', headers: request.headers, body: '{"type":2}' });
    expect((await call(tampered)).status).toBe(401);
  });

  it('rejects a tampered timestamp with 401', async () => {
    const body = '{"type":1}';
    const headers = { 'x-signature-ed25519': await sign(keys.privateKey, NOW_TIMESTAMP, body), 'x-signature-timestamp': '1790000001' };
    expect((await call(new Request('https://worker.example/interactions', { method: 'POST', headers, body }))).status).toBe(401);
  });

  it('rejects a request signed with another key with 401', async () => {
    expect((await call(await signedRequest(otherKeys, { type: 1 }))).status).toBe(401);
  });

  it.each([
    ['both signature headers', {}],
    ['the signature', { 'x-signature-timestamp': NOW_TIMESTAMP }],
    ['the timestamp', { 'x-signature-ed25519': 'ab'.repeat(64) }],
    ['a hex signature', { 'x-signature-ed25519': 'zz'.repeat(64), 'x-signature-timestamp': NOW_TIMESTAMP }],
    ['a signature of the wrong length', { 'x-signature-ed25519': 'ab'.repeat(63), 'x-signature-timestamp': NOW_TIMESTAMP }],
    ['an empty timestamp', { 'x-signature-ed25519': 'ab'.repeat(64), 'x-signature-timestamp': '' }],
    ['an oversized timestamp', { 'x-signature-ed25519': 'ab'.repeat(64), 'x-signature-timestamp': '1'.repeat(1000) }],
  ])('rejects a request with %s missing or malformed with 401, without throwing', async (_name, headers) => {
    const request = new Request('https://worker.example/interactions', { method: 'POST', headers, body: '{"type":1}' });
    expect((await call(request)).status).toBe(401);
  });

  it.each([
    ['not hex', 'not-a-key'],
    ['the wrong length', 'ab'.repeat(31)],
    ['an all-zero point', '00'.repeat(32)],
  ])('answers 401 and never throws when the configured public key is %s', async (_name, publicKey) => {
    const res = await call(await signedRequest(keys, { type: 1 }), envWith({ DISCORD_PUBLIC_KEY: publicKey }));
    expect(res.status).toBe(401);
  });

  it('answers 503 without touching anything when no public key is configured', async () => {
    const request = await signedRequest(keys, { type: 1 });
    expect((await call(request, envWith({ DISCORD_PUBLIC_KEY: undefined }))).status).toBe(503);
    expect((await call(await signedRequest(keys, { type: 1 }), envWith({ DISCORD_PUBLIC_KEY: '' }))).status).toBe(503);
  });

  it('rejects an oversized body, declared or streamed, with 401', async () => {
    const big = JSON.stringify({ type: 1, pad: 'x'.repeat(INTERACTION_BODY_MAX_BYTES) });
    expect((await call(await signedRequest(keys, big))).status).toBe(401);
    const request = await signedRequest(keys, big);
    request.headers.delete('content-length');
    expect((await call(request)).status).toBe(401);
  });

  it('answers 400 to a correctly signed body that is not JSON or not an interaction', async () => {
    expect((await call(await signedRequest(keys, 'not json'))).status).toBe(400);
    expect((await call(await signedRequest(keys, { type: 'x' }))).status).toBe(400);
    expect((await call(await signedRequest(keys, interactionPayload({ token: 'bad token!' })))).status).toBe(400);
  });

  it('never touches D1 for any of the requests above (the forbidden database throws on use)', async () => {
    const res = await call(await signedRequest(keys, { type: 1 }));
    expect(res.status).toBe(200);
  });
});

describe('every other route', () => {
  it.each([
    ['GET /interactions', 'GET', 'https://worker.example/interactions'],
    ['PUT /interactions', 'PUT', 'https://worker.example/interactions'],
    ['HEAD /interactions', 'HEAD', 'https://worker.example/interactions'],
    ['POST /', 'POST', 'https://worker.example/'],
    ['POST /interactions/', 'POST', 'https://worker.example/interactions/'],
    ['POST /interactions/extra', 'POST', 'https://worker.example/interactions/extra'],
    ['POST /Interactions', 'POST', 'https://worker.example/Interactions'],
    ['GET /', 'GET', 'https://worker.example/'],
  ])('%s answers 404 with an empty body', async (_name, method, url) => {
    const res = await call(new Request(url, { method, ...(method === 'POST' ? { body: '{"type":1}' } : {}) }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('answers a signed PING sent to another path with 404', async () => {
    const res = await call(await signedRequest(keys, { type: 1 }, { url: 'https://worker.example/other' }));
    expect(res.status).toBe(404);
  });
});

describe('CPU budget', () => {
  it('serves a signed PING round trip, verification included, far inside the 10 ms Worker CPU limit', async () => {
    const env = envWith();
    const requests = await Promise.all(Array.from({ length: 22 }, () => signedRequest(keys, { type: 1 })));
    await call(requests[0]!, env);
    let best = Number.POSITIVE_INFINITY;
    for (const request of requests.slice(1)) {
      const start = performance.now();
      const res = await call(request, env);
      best = Math.min(best, performance.now() - start);
      expect(res.status).toBe(200);
    }
    expect(best).toBeLessThan(3);
  });
});
