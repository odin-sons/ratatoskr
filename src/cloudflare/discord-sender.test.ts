// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordMessage } from '../core/types.ts';
import { makeEvent, NOW } from '../render/__fixtures__/events.ts';
import { renderImmediate } from '../render/index.ts';
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

  describe('link buttons', () => {
    const WITH_BUTTONS: DiscordMessage = {
      content: 'hi',
      components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Mod page', url: 'https://thunderstore.io/c/valheim/p/A/B/' }] }],
      allowed_mentions: { parse: [] },
    };

    it('adds with_components=true only when the payload carries components', async () => {
      const { sender, calls } = senderWith(() => new Response(null, { status: 204 }));
      await sender.send(HOOK, WITH_BUTTONS);
      expect(String(calls[0]![0])).toBe(`${HOOK}?wait=false&with_components=true`);
      expect(JSON.parse(calls[0]![1]?.body as string)).toEqual(WITH_BUTTONS);
      await sender.send(HOOK, MESSAGE);
      expect(String(calls[1]![0])).toBe(`${HOOK}?wait=false`);
      await sender.send(HOOK, { ...MESSAGE, components: [] });
      expect(String(calls[2]![0])).toBe(`${HOOK}?wait=false`);
    });

    it('keeps an existing query string and never adds the flag twice', async () => {
      const { sender, calls } = senderWith(() => new Response(null, { status: 204 }));
      await sender.send(`${HOOK}?thread_id=42&with_components=false`, WITH_BUTTONS);
      expect(String(calls[0]![0])).toBe(`${HOOK}?thread_id=42&with_components=true&wait=false`);
    });

    it('still rejects a non-webhook url before any request and leaks nothing', async () => {
      const { sender, calls } = senderWith(() => new Response(null, { status: 204 }));
      expect(await sender.send('https://evil.example/api/webhooks/123456789012345678/x', WITH_BUTTONS)).toEqual({ ok: false, retryable: false, status: 0 });
      expect(calls).toHaveLength(0);
      expectNoSecretLeak();
    });

    it('classifies 429, 5xx and 4xx exactly as without components', async () => {
      const limited = senderWith(() => Response.json({ retry_after: 1.5 }, { status: 429 }));
      expect(await limited.sender.send(HOOK, WITH_BUTTONS)).toEqual({ ok: false, retryable: true, retryAfterSeconds: 2, status: 429 });
      const broken = senderWith(() => new Response('', { status: 503 }));
      expect(await broken.sender.send(HOOK, WITH_BUTTONS)).toEqual({ ok: false, retryable: true, retryAfterSeconds: null, status: 503 });
      const rejected = senderWith(() => new Response('', { status: 400 }));
      expect(await rejected.sender.send(HOOK, WITH_BUTTONS)).toEqual({ ok: false, retryable: false, status: 400 });
      expectNoSecretLeak();
    });
  });

  describe('Components V2 messages', () => {
    const V2 = renderImmediate(makeEvent({ kind: 'new', description: 'd', changelog: '- x', categories: ['Tools'], downloadUrl: 'https://x.io/d' }), { now: NOW });

    it('sends the flag and the container as they are, with with_components=true and no content or embeds', async () => {
      const { sender, calls } = senderWith(() => new Response(null, { status: 204 }));
      expect(await sender.send(HOOK, V2)).toEqual({ ok: true });
      expect(String(calls[0]![0])).toBe(`${HOOK}?wait=false&with_components=true`);
      const body = JSON.parse(calls[0]![1]?.body as string) as Record<string, unknown>;
      expect(body).toEqual(JSON.parse(JSON.stringify(V2)));
      expect(body.flags).toBe(32768);
      expect('content' in body).toBe(false);
      expect('embeds' in body).toBe(false);
      expect(body.allowed_mentions).toEqual({ parse: [] });
    });

    it('classifies failures like any other message and never logs the url', async () => {
      const limited = senderWith(() => Response.json({ retry_after: 1.5 }, { status: 429 }));
      expect(await limited.sender.send(HOOK, V2)).toEqual({ ok: false, retryable: true, retryAfterSeconds: 2, status: 429 });
      const rejected = senderWith(() => new Response('', { status: 400 }));
      expect(await rejected.sender.send(HOOK, V2)).toEqual({ ok: false, retryable: false, status: 400 });
      const network = senderWith(() => {
        throw new TypeError(`fetch failed ${HOOK}`);
      });
      expect(await network.sender.send(HOOK, V2)).toEqual({ ok: false, retryable: true, retryAfterSeconds: null, status: 0 });
      expectNoSecretLeak();
    });
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
