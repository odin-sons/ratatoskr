// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_UNCONFIGURED_RETRY_SECONDS } from '../core/constants.ts';
import { drainOutbox } from '../core/drain.ts';
import { outboxId } from '../core/ids.ts';
import type { DiscordMessage } from '../core/types.ts';
import { FIXED_NOW_ISO, makeBotSubscription, makeEvent, makeSubscription } from '../testing/fakes.ts';
import { makeHarness } from '../testing/harness.ts';
import { BotSender } from './bot-sender.ts';
import { RoutingSender } from './routing-sender.ts';

const TOKEN = 'BotTokenSecret_abc-123.xyz';
const CHANNEL = '123456789012345678';
const MESSAGE: DiscordMessage = { content: 'hi', allowed_mentions: { parse: [] } };
const now = new Date(FIXED_NOW_ISO);

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void logs.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

describe('RoutingSender', () => {
  it('sends a webhook target through the webhook sender and a bot target through the bot', async () => {
    const h = makeHarness();
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ id: '323456789012345678' }), { status: 200 });
    }) as typeof fetch;
    const sender = new RoutingSender(h.sender, new BotSender(TOKEN, fetchImpl));
    await sender.send({ kind: 'webhook', url: 'https://discord.invalid/api/webhooks/1/t' }, MESSAGE);
    expect(await sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toEqual({ ok: true, messageId: '323456789012345678', channelId: CHANNEL });
    expect(h.sender.calls).toHaveLength(1);
    expect(requests).toEqual([`https://discord.com/api/v10/channels/${CHANNEL}/messages`]);
  });

  describe('without a bot token', () => {
    it('still sends webhook targets', async () => {
      const h = makeHarness();
      const sender = new RoutingSender(h.sender, null);
      expect(await sender.send({ kind: 'webhook', url: 'https://discord.invalid/api/webhooks/1/t' }, MESSAGE)).toEqual({ ok: true });
    });

    it('answers every bot request with a delayed retry and logs one generic line, never a secret', async () => {
      const sender = new RoutingSender(makeHarness().sender, null);
      const wait = { ok: false, retryable: true, retryAfterSeconds: BOT_UNCONFIGURED_RETRY_SECONDS, status: 429 };
      expect(await sender.send({ kind: 'bot', channelId: CHANNEL }, MESSAGE)).toEqual(wait);
      expect(await sender.createForumPost(CHANNEL, 'Alpha', MESSAGE)).toEqual(wait);
      expect(await sender.openThreadOnMessage(CHANNEL, '323456789012345678', 'Alpha')).toEqual(wait);
      expect(logs).toEqual(['bot subscriptions are waiting: DISCORD_BOT_TOKEN is not set']);
    });

    it('a tick delivers the webhook rows, leaves the bot rows queued without spending attempts, and does not crash', async () => {
      const h = makeHarness();
      const [forBot, forHook] = [makeEvent({ pkg: { packageId: 'A-Bot', owner: 'A', name: 'Bot' } }), makeEvent({ pkg: { packageId: 'B-Hook', owner: 'B', name: 'Hook' } })];
      h.store.addSubscription(makeBotSubscription());
      h.store.addSubscription(makeSubscription({ id: 'hook' }));
      await h.store.commit({
        source: forBot.pkg.source,
        packages: [forBot.pkg, forHook.pkg],
        events: [forBot, forHook],
        outbox: [
          { id: outboxId('bot-1', forBot.id), subscriptionId: 'bot-1', eventId: forBot.id, attempts: 0, nextAttemptAt: FIXED_NOW_ISO },
          { id: outboxId('hook', forHook.id), subscriptionId: 'hook', eventId: forHook.id, attempts: 0, nextAttemptAt: FIXED_NOW_ISO },
        ],
        state: { id: forBot.pkg.source, cursor: null, etag: null, bootstrapped: true, lastOkAt: null },
      });
      const report = await drainOutbox({ store: h.store, sender: new RoutingSender(h.sender, null), renderer: h.renderer, now });
      expect(h.sender.calls).toHaveLength(1);
      expect(report).toMatchObject({ parked: 0 });
      expect(report.error).toBeUndefined();
      expect(h.store.pendingRows()).toEqual([
        expect.objectContaining({ subscriptionId: 'bot-1', attempts: 0, nextAttemptAt: new Date(now.getTime() + BOT_UNCONFIGURED_RETRY_SECONDS * 1000).toISOString() }),
      ]);
      expect(logs.filter((line) => line.includes('waiting'))).toHaveLength(1);
    });
  });
});
