// SPDX-License-Identifier: AGPL-3.0-or-later
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRunLog } from '../core/report.ts';
import { runTick } from '../core/tick.ts';
import type { CapUsage, DiscordMessage } from '../core/types.ts';
import { FakeAdapter, FIXED_NOW_ISO, makeSubscription, okPoll } from '../testing/fakes.ts';
import { makeHarness } from '../testing/harness.ts';
import { createFakeFetch, fixture, json, text, type FakeFetch } from '../sources/__fixtures__/fake-fetch.ts';
import { NexusAdapter } from '../sources/nexus.ts';
import { BotSender } from './bot-sender.ts';
import { DiscordSender } from './discord-sender.ts';

const PREFIX = 'SENTINEL';
const NEXUS_KEY = `${PREFIX}-NEXUS-KEY-7f3a91c2`;
const HOOK_ID = '123456789012345678';
const SUB_TOKEN = `${PREFIX}-SUB-TOKEN-b81d44e0a2c9f6d7`;
const ALERT_TOKEN = `${PREFIX}-ALERT-TOKEN-5c07e9b3a1d8f2e4`;
const SUB_WEBHOOK = `https://discord.com/api/webhooks/${HOOK_ID}/${SUB_TOKEN}`;
const ALERT_WEBHOOK = `https://discord.com/api/webhooks/${HOOK_ID}/${ALERT_TOKEN}`;

const NX = 'nexus:valheim';
const nexusConfig = { id: NX, store: 'nexus' as const, community: 'valheim', enabled: true };
const scheduled = Date.parse(FIXED_NOW_ISO);

/** Every body echoes the secrets, so a body that reached a log or an error would show. */
const echo = (status: number, headers: Record<string, string> = {}): Response =>
  json({ message: `rejected ${NEXUS_KEY} ${SUB_TOKEN} ${ALERT_TOKEN}` }, { status, headers });

type Upstream = [name: string, respond: () => Response | Promise<Response>];

/** Failures any upstream can produce; the rejections carry the fixed texts the platform gives. */
const FAILURES: Upstream[] = [
  ['HTTP 400', () => echo(400)],
  ['HTTP 401', () => echo(401)],
  ['HTTP 403', () => echo(403)],
  ['HTTP 404', () => echo(404)],
  ['HTTP 429 with Retry-After', () => echo(429, { 'retry-after': '30' })],
  ['HTTP 429 with a malformed body', () => new Response(`not json ${NEXUS_KEY} ${SUB_TOKEN}`, { status: 429 })],
  ['HTTP 500', () => echo(500)],
  ['HTTP 503', () => echo(503)],
  ['a redirect to another host', () => new Response('', { status: 302, headers: { location: 'https://evil.example/collect' } })],
  ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ['a timeout', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))],
];

/** Bodies only a Nexus listing can be given. */
const BAD_NEXUS_BODIES: Upstream[] = [
  ['an HTML body', () => new Response(`<html>${NEXUS_KEY}</html>`, { status: 200 })],
  ['malformed JSON', () => new Response(`{"mods": [${NEXUS_KEY}`, { status: 200 })],
  ['JSON of the wrong shape', () => json({ error: NEXUS_KEY })],
  ['an oversized body', () => new Response(`${NEXUS_KEY}${'x'.repeat(7 * 1024 * 1024)}`, { status: 200 })],
];

const show = (arg: unknown): string => (typeof arg === 'string' ? arg : inspect(arg, { depth: 6 }));

const consoleOutput = (): string =>
  (['warn', 'log', 'error', 'info', 'debug'] as const)
    .flatMap((method) => vi.mocked(console[method]).mock.calls.map((args) => args.map(show).join(' ')))
    .join('\n');

/** Every secret starts with `PREFIX`, so a fragment of one (a parser error quoting a few characters) shows too. */
function expectNoSecret(label: string, ...texts: string[]): void {
  for (const output of texts) {
    expect(output, `${label}: a secret or a fragment of one`).not.toContain(PREFIX);
    expect(output, `${label}: a webhook URL`).not.toContain('/webhooks/');
  }
}

beforeEach(() => {
  for (const method of ['warn', 'log', 'error', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

interface Recorded {
  url: string;
  redirect: RequestInit['redirect'];
}

/** Wraps a fake fetch so the `redirect` mode of every request is on record too. */
function recording(fake: FakeFetch): { fetch: typeof fetch; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    recorded.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, redirect: init?.redirect });
    return fake.fetch(input, init);
  }) as typeof fetch;
  return { fetch: wrapped, recorded };
}

describe('the Nexus API key never reaches a log, an error or the run log', () => {
  function setup(fake: FakeFetch) {
    const rec = recording(fake);
    const h = makeHarness({ subscriptions: [makeSubscription()] });
    h.deps.adapters = [new NexusAdapter(nexusConfig)];
    h.deps.secrets = { NEXUS_API_KEY: NEXUS_KEY };
    h.deps.fetch = rec.fetch;
    h.store.sources.set(NX, { id: NX, cursor: '2026-01-01T00:00:00.000000Z', etag: null, bootstrapped: true, lastOkAt: FIXED_NOW_ISO });
    return { h, rec };
  }

  async function runAndCollect(fake: FakeFetch, label: string) {
    const { h, rec } = setup(fake);
    const report = await runTick(h.deps, scheduled);
    const runLog = formatRunLog({ cron: '*/5 * * * *', report, elapsedMs: 1 });
    expectNoSecret(label, consoleOutput(), runLog, inspect(report, { depth: 8 }));
    expect(fake.calls.filter((call) => call.url.includes('evil.example')), `${label}: a request to another host`).toHaveLength(0);
    return rec;
  }

  it('sends the key as the apikey header to the Nexus host only, never following a redirect (the control that makes the cases below meaningful)', async () => {
    const fake = createFakeFetch([['api.nexusmods.com', () => json([])]]);
    const { h } = setup(fake);
    await runTick(h.deps, scheduled);
    const calls = fake.callsTo('api.nexusmods.com');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.headers.apikey === NEXUS_KEY)).toBe(true);
    expect(fake.calls.filter((call) => !call.url.includes('api.nexusmods.com'))).toHaveLength(0);
  });

  it('asks fetch not to follow redirects on every request that carries the key', async () => {
    const fake = createFakeFetch([['api.nexusmods.com', () => json([])]]);
    const rec = await runAndCollect(fake, 'redirect mode');
    const credentialed = rec.recorded.filter((r) => r.url.includes('api.nexusmods.com'));
    expect(credentialed.length).toBeGreaterThan(0);
    expect(credentialed.every((r) => r.redirect === 'manual')).toBe(true);
  });

  it.each([...FAILURES, ...BAD_NEXUS_BODIES])('keeps the key out of every output when Nexus answers the listings with %s', async (name, respond) => {
    await runAndCollect(createFakeFetch([['', respond]]), name);
  });

  it.each(FAILURES)('keeps the key out of every output when the listings succeed and a mod lookup answers with %s', async (name, respond) => {
    const fake = createFakeFetch([
      ['/mods/updated.json', () => text(fixture('nexus-updated.json'))],
      ['/mods/latest_added.json', () => text(fixture('nexus-latest-added.json'))],
      ['/mods/', respond],
    ]);
    await runAndCollect(fake, `mod lookup, ${name}`);
    expect(fake.callsTo('/mods/1').length, 'the mod lookups were reached').toBeGreaterThan(0);
  });

  it('keeps the key out of the output when the source is enabled but has no key set', async () => {
    const fake = createFakeFetch([['', () => json([])]]);
    const { h } = setup(fake);
    h.deps.secrets = {};
    const report = await runTick(h.deps, scheduled);
    expectNoSecret('no key', consoleOutput(), formatRunLog({ cron: 'c', report, elapsedMs: 1 }));
    expect(fake.calls).toHaveLength(0);
  });
});

describe('Discord webhook tokens never reach a log, an error or the run log', () => {
  function setup(respond: Upstream[1]) {
    const fake = createFakeFetch([['discord.com', respond]]);
    const adapter = new FakeAdapter({ id: 'thunderstore:valheim' });
    const h = makeHarness({ adapters: [adapter], subscriptions: [makeSubscription({ webhookUrl: SUB_WEBHOOK, mode: 'immediate' })] });
    h.deps.sender = new DiscordSender(fake.fetch);
    h.deps.alertWebhookUrl = ALERT_WEBHOOK;
    h.store.sources.set('thunderstore:valheim', { id: 'thunderstore:valheim', cursor: 'c', etag: null, bootstrapped: true, lastOkAt: FIXED_NOW_ISO });
    h.store.seedPackages('thunderstore:valheim', { 'Owner-Mod': '1.0.0' });
    const usage: CapUsage = {
      id: 'index-lines',
      label: 'package index line cap',
      unit: 'lines',
      limit: 3500,
      value: 3300,
      exceeded: false,
      consequence: 'Updates are not detected.',
      constant: 'HEXIUM_INDEX_MAX_LINES',
    };
    adapter.enqueue(okPoll([{ ...h.store.packages.values().next().value!, version: '1.1.0' }], { capUsage: [usage] }));
    return { h, fake };
  }

  it('posts a mod update to the subscription webhook and an alert to the alert webhook (the controls that make the cases below meaningful)', async () => {
    const { h, fake } = setup(() => new Response('', { status: 204 }));
    await runTick(h.deps, scheduled);
    expect(fake.callsTo(SUB_TOKEN)).toHaveLength(1);
    expect(fake.callsTo(ALERT_TOKEN)).toHaveLength(1);
  });

  it.each(FAILURES)('keeps both tokens out of every output when Discord answers with %s', async (name, respond) => {
    const { h, fake } = setup(respond);
    const report = await runTick(h.deps, scheduled);
    expectNoSecret(name, consoleOutput(), formatRunLog({ cron: '*/5 * * * *', report, elapsedMs: 1 }), inspect(report, { depth: 8 }));
    expect(fake.callsTo('discord.com').length, 'Discord was reached').toBeGreaterThan(0);
  });

  it('keeps the token out of the output when the webhook URL is not a Discord webhook', async () => {
    const sender = new DiscordSender(createFakeFetch([]).fetch);
    const result = await sender.send({ kind: 'webhook', url: `https://evil.example/hooks/${HOOK_ID}/${SUB_TOKEN}` }, { content: 'x', allowed_mentions: { parse: [] } });
    expect(result).toMatchObject({ ok: false, retryable: false });
    expectNoSecret('malformed webhook', consoleOutput(), inspect(result));
  });
});

describe('the Discord bot token never reaches a log, an error or a result', () => {
  const BOT_TOKEN = `${PREFIX}-BOT-TOKEN-9e2b6d41c7a08f35`;
  const CHANNEL = '223456789012345678';
  const MESSAGE_ID = '323456789012345678';
  const MESSAGE: DiscordMessage = { content: 'x', allowed_mentions: { parse: [] } };

  const botEcho = (status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response =>
    json({ message: `rejected ${BOT_TOKEN}`, ...extra }, { status, headers });

  const BOT_FAILURES: Upstream[] = [
    ['HTTP 400', () => botEcho(400)],
    ['HTTP 401', () => botEcho(401)],
    ['HTTP 403', () => botEcho(403)],
    ['HTTP 404', () => botEcho(404)],
    ['HTTP 404 with code 10003', () => botEcho(404, { code: 10003 })],
    ['HTTP 400 with code 50083', () => botEcho(400, { code: 50083 })],
    ['HTTP 429 with Retry-After', () => botEcho(429, {}, { 'retry-after': '30' })],
    ['HTTP 429 with a malformed body', () => new Response(`not json ${BOT_TOKEN}`, { status: 429 })],
    ['HTTP 500', () => botEcho(500)],
    ['a body of the wrong shape', () => botEcho(200)],
    ['a redirect to another host', () => new Response('', { status: 302, headers: { location: 'https://evil.example/collect' } })],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a timeout', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))],
  ];

  const operations: [string, (sender: BotSender) => Promise<unknown>][] = [
    ['send', (s) => s.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)],
    ['send into a thread', (s) => s.send({ kind: 'bot', channelId: CHANNEL, threadId: MESSAGE_ID }, MESSAGE)],
    ['forum post', (s) => s.createForumPost(CHANNEL, 'name', MESSAGE)],
    ['thread on a message', (s) => s.openThreadOnMessage(CHANNEL, MESSAGE_ID, 'name')],
  ];

  it('sends the token in the authorization header only (the control that makes the cases below meaningful)', async () => {
    const fake = createFakeFetch([['discord.com', () => json({ id: MESSAGE_ID })]]);
    await new BotSender(BOT_TOKEN, fake.fetch).send({ kind: 'bot', channelId: CHANNEL }, MESSAGE);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.headers.authorization).toBe(`Bot ${BOT_TOKEN}`);
    expect(fake.calls[0]!.url).not.toContain(BOT_TOKEN);
  });

  describe.each(operations)('%s', (_name, run) => {
    it.each(BOT_FAILURES)('keeps the token out of every output when Discord answers with %s', async (name, respond) => {
      const fake = createFakeFetch([['discord.com', respond]]);
      const result = await run(new BotSender(BOT_TOKEN, fake.fetch));
      expect(fake.calls.length, 'Discord was reached').toBeGreaterThan(0);
      expectNoSecret(name, consoleOutput(), inspect(result, { depth: 6 }));
    });
  });

  it.each([
    ['a webhook target', (s: BotSender) => s.send({ kind: 'webhook', url: SUB_WEBHOOK }, MESSAGE)],
    ['a malformed channel id', (s: BotSender) => s.send({ kind: 'bot', channelId: BOT_TOKEN }, MESSAGE)],
    ['a malformed message id', (s: BotSender) => s.openThreadOnMessage(CHANNEL, BOT_TOKEN, 'name')],
  ])('keeps the token out of every output for %s', async (name, run) => {
    const fake = createFakeFetch([]);
    const result = await run(new BotSender(BOT_TOKEN, fake.fetch));
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(fake.calls).toHaveLength(0);
    expectNoSecret(name, consoleOutput(), inspect(result));
  });
});
