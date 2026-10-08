// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOCOMPLETE_MAX_RESULTS } from '../core/constants.ts';
import { en } from '../i18n/en.ts';
import { ru } from '../i18n/ru.ts';
import { createFakeFetch, json } from '../sources/__fixtures__/fake-fetch.ts';
import { APP_ID, INTERACTION_ID, TOKEN_SENTINEL } from '../testing/signing.ts';
import { INTERACTION_TYPE } from './constants.ts';
import { autocomplete, defer, finishDeferred, reply } from './responses.ts';
import { createRegistry, routeInteraction, type HandlerContext } from './router.ts';
import { parseInteraction, type Interaction } from './types.ts';

const make = (over: Record<string, unknown>): Interaction => {
  const parsed = parseInteraction({ id: INTERACTION_ID, application_id: APP_ID, type: 2, token: TOKEN_SENTINEL, ...over });
  if (parsed === null) throw new Error('bad test interaction');
  return parsed;
};

function setup(messages = en) {
  const fake = createFakeFetch([['discord.com', () => json({})]]);
  const pending: Promise<unknown>[] = [];
  const ctx: HandlerContext = { messages, fetch: fake.fetch, waitUntil: (p) => void pending.push(p) };
  return { fake, pending, ctx };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('routeInteraction', () => {
  it('answers PING with PONG', async () => {
    expect(await routeInteraction(createRegistry(), make({ type: INTERACTION_TYPE.ping }), setup().ctx)).toEqual({ type: 1 });
  });

  it('dispatches a command by name, a component by the custom_id prefix and autocomplete by command name', async () => {
    const registry = createRegistry();
    registry.commands.set('ping', () => reply({ content: 'command' }));
    registry.autocompletes.set('ping', () => autocomplete([{ name: 'a', value: 'a' }]));
    registry.components.set('page', (i) => reply({ content: i.data?.custom_id ?? '' }));
    const { ctx } = setup();
    expect((await routeInteraction(registry, make({ type: 2, data: { name: 'ping' } }), ctx)).data?.content).toBe('command');
    expect((await routeInteraction(registry, make({ type: 4, data: { name: 'ping' } }), ctx)).data?.choices).toEqual([{ name: 'a', value: 'a' }]);
    expect((await routeInteraction(registry, make({ type: 3, data: { custom_id: 'page:next:3' } }), ctx)).data?.content).toBe('page:next:3');
    expect((await routeInteraction(registry, make({ type: 3, data: { custom_id: 'page' } }), ctx)).data?.content).toBe('page');
  });

  it.each([
    ['command', { type: 2, data: { name: 'nope' } }],
    ['command without a name', { type: 2 }],
    ['component', { type: 3, data: { custom_id: 'nope:1' } }],
    ['interaction type', { type: 5 }],
  ])('answers an unknown %s with an ephemeral localized message', async (_name, over) => {
    const en_ = await routeInteraction(createRegistry(), make(over), setup(en).ctx);
    expect(en_).toEqual({ type: 4, data: { content: en.unknownCommand, flags: 64, allowed_mentions: { parse: [] } } });
    const ru_ = await routeInteraction(createRegistry(), make(over), setup(ru).ctx);
    expect(ru_.data?.content).toBe(ru.unknownCommand);
  });

  it('answers unknown autocomplete with no choices', async () => {
    expect(await routeInteraction(createRegistry(), make({ type: 4, data: { name: 'nope' } }), setup().ctx)).toEqual({ type: 8, data: { choices: [] } });
  });

  it('answers a failing handler with a generic ephemeral message that carries no error text', async () => {
    const registry = createRegistry();
    registry.commands.set('boom', () => {
      throw new Error(`secret ${TOKEN_SENTINEL}`);
    });
    registry.autocompletes.set('boom', () => Promise.reject(new Error('x')));
    const { ctx } = setup();
    const res = await routeInteraction(registry, make({ type: 2, data: { name: 'boom' } }), ctx);
    expect(res.data?.content).toBe(en.somethingWrong);
    expect(res.data?.flags).toBe(64);
    expect(await routeInteraction(registry, make({ type: 4, data: { name: 'boom' } }), ctx)).toEqual({ type: 8, data: { choices: [] } });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('SENTINEL');
  });
});

describe('response helpers', () => {
  it('reply sets the ephemeral flag only on request and always blocks mentions', () => {
    expect(reply({ content: 'x' })).toEqual({ type: 4, data: { content: 'x', allowed_mentions: { parse: [] } } });
    expect(reply({ content: 'x' }, { ephemeral: true }).data?.flags).toBe(64);
    expect(reply({ content: 'x', flags: 32768 }, { ephemeral: true }).data?.flags).toBe(32768 | 64);
  });

  it('defer carries the ephemeral flag in the deferred response itself', () => {
    expect(defer()).toEqual({ type: 5 });
    expect(defer({ ephemeral: true })).toEqual({ type: 5, data: { flags: 64 } });
  });

  it('autocomplete returns at most 25 choices and trims names and values to Discord limits', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `n${i}`, value: `v${i}` }));
    const res = autocomplete(many);
    expect(res.type).toBe(8);
    expect((res.data?.choices as unknown[]).length).toBe(AUTOCOMPLETE_MAX_RESULTS);
    const long = autocomplete([{ name: 'n'.repeat(500), value: 'v'.repeat(500) }]).data?.choices as { name: string; value: string }[];
    expect(long[0]!.name).toHaveLength(100);
    expect(long[0]!.value).toHaveLength(100);
  });
});

describe('finishDeferred', () => {
  it('patches the original response through the interaction webhook inside waitUntil, without a bot token', async () => {
    const { fake, pending, ctx } = setup();
    const interaction = make({});
    expect(finishDeferred(ctx, interaction, { content: 'done @everyone' })).toBe(true);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.method).toBe('PATCH');
    expect(call.url).toBe(`https://discord.com/api/v10/webhooks/${APP_ID}/${TOKEN_SENTINEL}/messages/@original`);
    expect(call.headers.authorization).toBeUndefined();
  });

  it('sends the finished message with mentions blocked and no flags', async () => {
    const bodies: string[] = [];
    const ctx: HandlerContext = {
      messages: en,
      waitUntil: (p) => void pending.push(p),
      fetch: ((_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return Promise.resolve(new Response('{}'));
      }) as unknown as typeof fetch,
    };
    const pending: Promise<unknown>[] = [];
    finishDeferred(ctx, make({}), Promise.resolve({ content: 'done' }));
    await Promise.all(pending);
    expect(JSON.parse(bodies[0]!)).toEqual({ content: 'done', allowed_mentions: { parse: [] } });
  });

  it('finishes with the generic error text when the work rejects', async () => {
    const bodies: string[] = [];
    const pending: Promise<unknown>[] = [];
    const ctx: HandlerContext = {
      messages: ru,
      waitUntil: (p) => void pending.push(p),
      fetch: ((_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return Promise.resolve(new Response('{}'));
      }) as unknown as typeof fetch,
    };
    finishDeferred(ctx, make({}), Promise.reject(new Error('db down')));
    await Promise.all(pending);
    expect(JSON.parse(bodies[0]!).content).toBe(ru.somethingWrong);
  });

  it('refuses malformed application ids and tokens without sending anything', () => {
    const { fake, pending, ctx } = setup();
    expect(finishDeferred(ctx, { application_id: 'abc', token: 'tok' }, { content: 'x' })).toBe(false);
    expect(finishDeferred(ctx, { application_id: APP_ID, token: '../evil?x=1' }, { content: 'x' })).toBe(false);
    expect(pending).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('survives a failing Discord call and never logs the token or the URL', async () => {
    const pending: Promise<unknown>[] = [];
    const ctx: HandlerContext = {
      messages: en,
      waitUntil: (p) => void pending.push(p),
      delay: () => Promise.resolve(),
      fetch: (() => Promise.reject(new TypeError(`fetch failed`))) as unknown as typeof fetch,
    };
    finishDeferred(ctx, make({}), { content: 'x' });
    await expect(Promise.all(pending)).resolves.toBeDefined();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain('SENTINEL');
    expect(logged).not.toContain('/webhooks/');
    expect(logged).toContain('TypeError');

    const failing = createFakeFetch([['discord.com', () => json({ message: TOKEN_SENTINEL }, { status: 500 })]]);
    const p2: Promise<unknown>[] = [];
    finishDeferred({ messages: en, fetch: failing.fetch, waitUntil: (p) => void p2.push(p) }, make({}), { content: 'x' });
    await Promise.all(p2);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('SENTINEL');
  });

  describe('retrying the follow-up', () => {
    const run = async (statuses: (number | 'network')[]) => {
      const delays: number[] = [];
      const attempts: string[] = [];
      const pending: Promise<unknown>[] = [];
      let n = 0;
      const ctx: HandlerContext = {
        messages: en,
        waitUntil: (p) => void pending.push(p),
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        fetch: ((_url: string, init?: RequestInit) => {
          attempts.push(String(init?.body));
          const status = statuses[n++] ?? 200;
          return status === 'network' ? Promise.reject(new TypeError('fetch failed')) : Promise.resolve(new Response('{}', { status }));
        }) as unknown as typeof fetch,
      };
      let works = 0;
      finishDeferred(ctx, make({}), Promise.resolve().then(() => ({ content: `done ${(works += 1)}` })));
      await Promise.all(pending);
      return { delays, attempts, works };
    };

    it('lands the follow-up after one 404, sending the same body and running the work once', async () => {
      const { delays, attempts, works } = await run([404]);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toBe(attempts[0]);
      expect(JSON.parse(attempts[1]!).content).toBe('done 1');
      expect(works).toBe(1);
      expect(delays).toEqual([300]);
      expect(console.error).not.toHaveBeenCalled();
    });

    it('retries a network error too, backing off 300 then 600 ms, and gives up after two retries', async () => {
      const { delays, attempts } = await run(['network', 'network', 'network', 'network']);
      expect(attempts).toHaveLength(3);
      expect(delays).toEqual([300, 600]);
      expect(vi.mocked(console.error).mock.calls).toEqual([['finishing a deferred interaction failed: TypeError']]);
    });

    it('logs only the status after still failing with 404, never the URL or the token', async () => {
      const { attempts } = await run([404, 404, 404]);
      expect(attempts).toHaveLength(3);
      const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
      expect(logged).toBe('[["finishing a deferred interaction failed: HTTP 404"]]');
      expect(logged).not.toContain('SENTINEL');
      expect(logged).not.toContain('/webhooks/');
    });

    it.each([400, 401, 403, 500])('does not retry HTTP %d', async (status) => {
      const { attempts, delays } = await run([status]);
      expect(attempts).toHaveLength(1);
      expect(delays).toEqual([]);
    });
  });
});

describe('message command payload', () => {
  it('keeps the command type and drops one that is not a number', () => {
    expect(make({ data: { name: 'x', type: 3 } }).data).toEqual({ name: 'x', type: 3 });
    expect(make({ data: { name: 'x', type: 'three' } }).data).toEqual({ name: 'x' });
  });

});
