// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordMessage } from '../core/types.ts';
import { DiscordSender } from './discord-sender.ts';
import { isDiscordWebhookUrl, isSnowflake } from './guards.ts';

const TOKEN = 'SuperSecretToken_abc-123';
const HOOK = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;
const MESSAGE: DiscordMessage = { content: 'hi', allowed_mentions: { parse: [] } };

type FetchArgs = Parameters<typeof fetch>;

function senderWith(respond: () => Response | Promise<Response>): { sender: DiscordSender; calls: FetchArgs[] } {
  const calls: FetchArgs[] = [];
  const fake = (async (...args: FetchArgs) => {
    calls.push(args);
    return respond();
  }) as typeof fetch;
  return { sender: new DiscordSender(fake), calls };
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

function expectNoSecretLeak(): void {
  const all = logs.join('\n');
  expect(all).not.toContain(TOKEN);
  expect(all).not.toContain('discord.com/api/webhooks');
}

function hangingFetch(): { fetch: typeof fetch; signals: (AbortSignal | null | undefined)[] } {
  const signals: (AbortSignal | null | undefined)[] = [];
  const fake = ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      signals.push(init?.signal);
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
  return { fetch: fake, signals };
}

describe('DiscordSender timeout', () => {
  it('passes an abort signal to every request', async () => {
    const { sender, calls } = senderWith(() => new Response(null, { status: 204 }));
    await sender.send(HOOK, MESSAGE);
    expect(calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('gives up on a request that never resolves and reports a retryable failure', async () => {
    const { fetch: hanging, signals } = hangingFetch();
    const sender = new DiscordSender(hanging, 20);
    expect(await sender.send(HOOK, MESSAGE)).toEqual({ ok: false, retryable: true, retryAfterSeconds: null, status: 0 });
    expect(signals[0]?.aborted).toBe(true);
    expectNoSecretLeak();
  });
});

describe('DiscordSender', () => {
  it('posts JSON with wait=false and reports ok on 204', async () => {
    const { sender, calls } = senderWith(() => new Response(null, { status: 204 }));
    expect(await sender.send(HOOK, MESSAGE)).toEqual({ ok: true });
    const [url, init] = calls[0]!;
    expect(String(url)).toBe(`${HOOK}?wait=false`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(MESSAGE);
  });

  it('preserves an existing query string', async () => {
    const { sender, calls } = senderWith(() => new Response(null, { status: 204 }));
    await sender.send(`${HOOK}?thread_id=42`, MESSAGE);
    expect(String(calls[0]![0])).toBe(`${HOOK}?thread_id=42&wait=false`);
  });

  it('treats 200 as ok', async () => {
    const { sender } = senderWith(() => new Response('{}', { status: 200 }));
    expect(await sender.send(HOOK, MESSAGE)).toEqual({ ok: true });
  });

  it('429 with body retry_after 1.5 rounds up to 2', async () => {
    const { sender } = senderWith(() => Response.json({ message: 'rate limited', retry_after: 1.5, global: false }, { status: 429 }));
    expect(await sender.send(HOOK, MESSAGE)).toEqual({ ok: false, retryable: true, retryAfterSeconds: 2, status: 429 });
    expectNoSecretLeak();
  });

  it('429 falls back to the Retry-After header', async () => {
    const { sender } = senderWith(() => new Response('nope', { status: 429, headers: { 'retry-after': '3' } }));
    expect(await sender.send(HOOK, MESSAGE)).toEqual({ ok: false, retryable: true, retryAfterSeconds: 3, status: 429 });
  });

  it('429 prefers the body over the header', async () => {
    const { sender } = senderWith(() => Response.json({ retry_after: 0.2 }, { status: 429, headers: { 'retry-after': '9' } }));
    expect(await sender.send(HOOK, MESSAGE)).toMatchObject({ retryAfterSeconds: 1 });
  });

  it('429 with no usable hint yields null', async () => {
    const { sender } = senderWith(() => new Response('', { status: 429 }));
    expect(await sender.send(HOOK, MESSAGE)).toEqual({ ok: false, retryable: true, retryAfterSeconds: null, status: 429 });
  });

  it('500 is retryable', async () => {
    const { sender } = senderWith(() => new Response('oops', { status: 500 }));
    expect(await sender.send(HOOK, MESSAGE)).toEqual({ ok: false, retryable: true, retryAfterSeconds: null, status: 500 });
  });

  it('404 is not retryable', async () => {
    const { sender } = senderWith(() => Response.json({ message: 'Unknown Webhook', code: 10015 }, { status: 404 }));
    expect(await sender.send(HOOK, MESSAGE)).toEqual({ ok: false, retryable: false, status: 404 });
    expectNoSecretLeak();
  });

  it('400 is not retryable', async () => {
    const { sender } = senderWith(() => new Response('bad', { status: 400 }));
    expect(await sender.send(HOOK, MESSAGE)).toEqual({ ok: false, retryable: false, status: 400 });
  });

  it('a network error is retryable and never leaks the URL', async () => {
    const { sender } = senderWith(() => {
      throw new TypeError(`fetch failed for ${HOOK}`);
    });
    const result = await sender.send(HOOK, MESSAGE);
    expect(result).toEqual({ ok: false, retryable: true, retryAfterSeconds: null, status: 0 });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expectNoSecretLeak();
    expect(logs.join('\n')).toContain('123456789012345678');
  });

  it('rejects non-webhook URLs without calling fetch and without echoing them', async () => {
    const { sender, calls } = senderWith(() => new Response(null, { status: 204 }));
    const evil = 'https://evil.example/api/webhooks/123456789012345678/secretvalue';
    expect(await sender.send(evil, MESSAGE)).toEqual({ ok: false, retryable: false, status: 0 });
    expect(calls).toEqual([]);
    expect(logs.join('\n')).not.toContain('secretvalue');
  });
});

describe('guards', () => {
  it.each([
    'https://discord.com/api/webhooks/123456789012345678/abc_DEF-123',
    'https://discordapp.com/api/webhooks/123456789012345678/abc',
    'https://canary.discord.com/api/webhooks/123456789012345678/abc',
    'https://discord.com/api/v10/webhooks/123456789012345678/abc',
  ])('accepts %s', (url) => {
    expect(isDiscordWebhookUrl(url)).toBe(true);
  });

  it.each([
    'http://discord.com/api/webhooks/123456789012345678/abc',
    'https://discord.com.evil.example/api/webhooks/123456789012345678/abc',
    'https://user:pw@discord.com/api/webhooks/123456789012345678/abc',
    'https://discord.com/api/webhooks/notanumber/abc',
    'https://discord.com/api/webhooks/123456789012345678',
    'https://discord.com/api/webhooks/123456789012345678/abc/extra',
    'https://discord.com:8443/api/webhooks/123456789012345678/abc',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(isDiscordWebhookUrl(url)).toBe(false);
  });

  it('isSnowflake accepts 17-20 digit ids only', () => {
    expect(isSnowflake('123456789012345678')).toBe(true);
    expect(isSnowflake('1234')).toBe(false);
    expect(isSnowflake('12345678901234567a')).toBe(false);
    expect(isSnowflake('')).toBe(false);
  });
});
