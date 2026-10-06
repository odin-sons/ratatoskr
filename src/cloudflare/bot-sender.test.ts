// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubrequestBudget } from '../core/budget.ts';
import { DISCORD_API_BASE, DISCORD_THREAD_NAME_MAX } from '../core/constants.ts';
import type { DiscordMessage } from '../core/types.ts';
import { BotSender } from './bot-sender.ts';

const TOKEN = 'BotTokenSecret_abc-123.xyz';
const CHANNEL = '123456789012345678';
const THREAD = '223456789012345678';
const MESSAGE_ID = '323456789012345678';
const MESSAGE: DiscordMessage = { content: 'hi', allowed_mentions: { parse: [] } };

interface Call {
  url: string;
  init: RequestInit;
  body: unknown;
}

function fakeFetch(respond: () => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url: String(input), init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    return respond();
  };
  return { fetch: impl as typeof fetch, calls };
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function senderWith(respond: () => Response | Promise<Response>) {
  const fake = fakeFetch(respond);
  return { sender: new BotSender(TOKEN, fake.fetch), calls: fake.calls };
}

let logs: string[];

beforeEach(() => {
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BotSender.send', () => {
  it('posts to the channel with the bot authorization and the user agent', async () => {
    const { sender, calls } = senderWith(() => jsonResponse({ id: MESSAGE_ID }));
    const result = await sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE);
    expect(result).toEqual({ ok: true, messageId: MESSAGE_ID, channelId: CHANNEL });
    expect(calls[0]!.url).toBe(`${DISCORD_API_BASE}/channels/${CHANNEL}/messages`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.body).toEqual(MESSAGE);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('authorization')).toBe(`Bot ${TOKEN}`);
    expect(headers.get('user-agent')).toMatch(/^DiscordBot \(/);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the thread id as the channel id when a thread is given', async () => {
    const { sender, calls } = senderWith(() => jsonResponse({ id: MESSAGE_ID }));
    const result = await sender.send({ kind: 'bot', channelId: CHANNEL, threadId: THREAD }, MESSAGE);
    expect(result).toEqual({ ok: true, messageId: MESSAGE_ID, channelId: THREAD });
    expect(calls[0]!.url).toBe(`${DISCORD_API_BASE}/channels/${THREAD}/messages`);
  });

  it('succeeds without ids when the success body carries none', async () => {
    const { sender } = senderWith(() => new Response(null, { status: 204 }));
    expect(await sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toEqual({ ok: true, channelId: CHANNEL });
  });

  it.each([['channel', { kind: 'bot', channelId: 'not-an-id' }], ['thread', { kind: 'bot', channelId: CHANNEL, threadId: '12' }]] as const)(
    'rejects a bad %s id without a request',
    async (_name, target) => {
      const { sender, calls } = senderWith(() => jsonResponse({}));
      expect(await sender.send(target, MESSAGE)).toEqual({ ok: false, retryable: false, status: 0 });
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects a webhook target without a request', async () => {
    const { sender, calls } = senderWith(() => jsonResponse({}));
    expect(await sender.send({ kind: 'webhook', url: 'https://discord.com/api/webhooks/123456789012345678/x' }, MESSAGE)).toEqual({
      ok: false,
      retryable: false,
      status: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it('maps 429 to a retryable result with retryAfterSeconds from the body', async () => {
    const { sender } = senderWith(() => jsonResponse({ retry_after: 1.2 }, 429));
    expect(await sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toEqual({ ok: false, retryable: true, retryAfterSeconds: 2, status: 429 });
  });

  it('falls back to the retry-after header, then to null', async () => {
    const header = senderWith(() => new Response('nope', { status: 429, headers: { 'retry-after': '3' } }));
    expect(await header.sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toMatchObject({ retryAfterSeconds: 3 });
    const none = senderWith(() => new Response('nope', { status: 429 }));
    expect(await none.sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toMatchObject({ retryAfterSeconds: null, status: 429 });
  });

  it.each([500, 502, 503])('maps %i to a retryable result', async (status) => {
    const { sender } = senderWith(() => new Response('oops', { status }));
    expect(await sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toEqual({ ok: false, retryable: true, retryAfterSeconds: null, status });
  });

  it('maps a network error to a retryable result', async () => {
    const { sender } = senderWith(() => Promise.reject(new TypeError('fetch failed')));
    expect(await sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toEqual({ ok: false, retryable: true, retryAfterSeconds: null, status: 0 });
  });

  it('times out a request that never answers and reports it as retryable', async () => {
    const hanging = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    const sender = new BotSender(TOKEN, hanging, 5);
    expect(await sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toEqual({ ok: false, retryable: true, retryAfterSeconds: null, status: 0 });
  });

  it.each([400, 401, 403])('maps %i to a plain non-retryable result', async (status) => {
    const { sender } = senderWith(() => jsonResponse({ code: 50001, message: 'Missing Access' }, status));
    expect(await sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toEqual({ ok: false, retryable: false, status });
  });

  it('flags a 404 as gone', async () => {
    const { sender } = senderWith(() => new Response('not found', { status: 404 }));
    expect(await sender.send({ kind: 'bot', channelId: CHANNEL, threadId: THREAD }, MESSAGE)).toEqual({ ok: false, retryable: false, status: 404, gone: true });
  });

  it('flags error code 10003 as gone whatever the status', async () => {
    const { sender } = senderWith(() => jsonResponse({ code: 10003, message: 'Unknown Channel' }, 400));
    expect(await sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toMatchObject({ ok: false, retryable: false, gone: true });
  });

  it('flags an archived thread (50083) as gone for a thread target only', async () => {
    const { sender } = senderWith(() => jsonResponse({ code: 50083, message: 'Thread is archived' }, 400));
    expect(await sender.send({ kind: 'bot', channelId: CHANNEL, threadId: THREAD }, MESSAGE)).toEqual({ ok: false, retryable: false, status: 400, gone: true });
    expect(await sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toEqual({ ok: false, retryable: false, status: 400 });
  });

  it('never puts the token into a log line', async () => {
    for (const respond of [() => jsonResponse({ message: TOKEN }, 400), () => jsonResponse({}, 500), () => Promise.reject(new TypeError(TOKEN))]) {
      await senderWith(respond).sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE);
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });
});

describe('BotSender.createForumPost', () => {
  it('creates the post and returns the thread and starter message ids', async () => {
    const { sender, calls } = senderWith(() => jsonResponse({ id: THREAD, message: { id: MESSAGE_ID } }, 201));
    const result = await sender.createForumPost(CHANNEL, 'Cool Mod', MESSAGE);
    expect(result).toEqual({ ok: true, threadId: THREAD, messageId: MESSAGE_ID });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${DISCORD_API_BASE}/channels/${CHANNEL}/threads`);
    expect(calls[0]!.body).toEqual({ name: 'Cool Mod', message: MESSAGE });
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Bot ${TOKEN}`);
  });

  it('truncates the name to the thread name limit', async () => {
    const { sender, calls } = senderWith(() => jsonResponse({ id: THREAD, message: { id: MESSAGE_ID } }, 201));
    await sender.createForumPost(CHANNEL, 'x'.repeat(300), MESSAGE);
    expect((calls[0]!.body as { name: string }).name).toHaveLength(DISCORD_THREAD_NAME_MAX);
  });

  it('does not split a surrogate pair when truncating', async () => {
    const { sender, calls } = senderWith(() => jsonResponse({ id: THREAD, message: { id: MESSAGE_ID } }, 201));
    await sender.createForumPost(CHANNEL, '🐿'.repeat(150), MESSAGE);
    expect(Array.from((calls[0]!.body as { name: string }).name)).toHaveLength(DISCORD_THREAD_NAME_MAX);
  });

  it.each([['channel', CHANNEL.slice(2), 'name'], ['name', CHANNEL, '   ']])('rejects a bad %s without a request', async (_what, channel, name) => {
    const { sender, calls } = senderWith(() => jsonResponse({}));
    expect(await sender.createForumPost(channel, name, MESSAGE)).toEqual({ ok: false, retryable: false, status: 0 });
    expect(calls).toHaveLength(0);
  });

  it('reports a success body without ids as a non-retryable failure', async () => {
    const { sender } = senderWith(() => jsonResponse({ id: THREAD }, 201));
    expect(await sender.createForumPost(CHANNEL, 'name', MESSAGE)).toEqual({ ok: false, retryable: false, status: 201 });
  });

  it('maps 429, 5xx, a network error and 404 like send', async () => {
    expect(await senderWith(() => jsonResponse({ retry_after: 4 }, 429)).sender.createForumPost(CHANNEL, 'n', MESSAGE)).toEqual({
      ok: false,
      retryable: true,
      retryAfterSeconds: 4,
      status: 429,
    });
    expect(await senderWith(() => new Response('', { status: 503 })).sender.createForumPost(CHANNEL, 'n', MESSAGE)).toMatchObject({ retryable: true, status: 503 });
    expect(await senderWith(() => Promise.reject(new Error('x'))).sender.createForumPost(CHANNEL, 'n', MESSAGE)).toMatchObject({ retryable: true, status: 0 });
    expect(await senderWith(() => jsonResponse({ code: 10003 }, 404)).sender.createForumPost(CHANNEL, 'n', MESSAGE)).toEqual({
      ok: false,
      retryable: false,
      status: 404,
      gone: true,
    });
  });
});

describe('BotSender.openThreadOnMessage', () => {
  it('opens the thread on the message and returns its id', async () => {
    const { sender, calls } = senderWith(() => jsonResponse({ id: THREAD }, 201));
    expect(await sender.openThreadOnMessage(CHANNEL, MESSAGE_ID, 'Cool Mod')).toEqual({ ok: true, threadId: THREAD });
    expect(calls[0]!.url).toBe(`${DISCORD_API_BASE}/channels/${CHANNEL}/messages/${MESSAGE_ID}/threads`);
    expect(calls[0]!.body).toEqual({ name: 'Cool Mod' });
  });

  it('truncates the name to the thread name limit', async () => {
    const { sender, calls } = senderWith(() => jsonResponse({ id: THREAD }, 201));
    await sender.openThreadOnMessage(CHANNEL, MESSAGE_ID, 'y'.repeat(101));
    expect((calls[0]!.body as { name: string }).name).toHaveLength(DISCORD_THREAD_NAME_MAX);
  });

  it.each([
    ['channel', 'abc', MESSAGE_ID],
    ['message', CHANNEL, 'abc'],
  ])('rejects a bad %s id without a request', async (_what, channel, message) => {
    const { sender, calls } = senderWith(() => jsonResponse({}));
    expect(await sender.openThreadOnMessage(channel, message, 'name')).toEqual({ ok: false, retryable: false, status: 0 });
    expect(calls).toHaveLength(0);
  });

  it('flags a deleted message as gone', async () => {
    const { sender } = senderWith(() => new Response('', { status: 404 }));
    expect(await sender.openThreadOnMessage(CHANNEL, MESSAGE_ID, 'name')).toMatchObject({ ok: false, retryable: false, gone: true });
  });

  it('flags error code 160004 (a thread already exists for the message) as threadExists, not gone', async () => {
    const { sender } = senderWith(() => jsonResponse({ code: 160004, message: 'A thread has already been created for this message' }, 400));
    expect(await sender.openThreadOnMessage(CHANNEL, MESSAGE_ID, 'name')).toEqual({ ok: false, retryable: false, status: 400, threadExists: true });
  });

  it('maps a 5xx to a retryable result', async () => {
    const { sender } = senderWith(() => new Response('', { status: 500 }));
    expect(await sender.openThreadOnMessage(CHANNEL, MESSAGE_ID, 'name')).toMatchObject({ retryable: true, status: 500 });
  });
});

describe('BotSender subrequest accounting', () => {
  it('counts one subrequest per call: forum post creation is one, opening a thread plus posting into it is two', async () => {
    const budget = new SubrequestBudget(10);
    const fake = fakeFetch(() => jsonResponse({ id: THREAD, message: { id: MESSAGE_ID } }, 201));
    const sender = new BotSender(TOKEN, budget.wrapFetch(fake.fetch));

    await sender.createForumPost(CHANNEL, 'name', MESSAGE);
    expect(budget.used).toBe(1);

    await sender.openThreadOnMessage(CHANNEL, MESSAGE_ID, 'name');
    await sender.send({ kind: 'bot', channelId: CHANNEL, threadId: THREAD }, MESSAGE);
    expect(budget.used).toBe(3);
    expect(fake.calls).toHaveLength(3);
  });

  it('makes no request and reports a retryable failure once the budget is spent', async () => {
    const budget = new SubrequestBudget(0);
    const fake = fakeFetch(() => jsonResponse({ id: MESSAGE_ID }));
    const sender = new BotSender(TOKEN, budget.wrapFetch(fake.fetch));
    expect(await sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toEqual({ ok: false, retryable: true, retryAfterSeconds: null, status: 0 });
    expect(fake.calls).toHaveLength(0);
  });
});
