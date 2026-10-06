// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_NOW_ISO, makeBotSubscription, makeEvent, makeSubscription } from '../testing/fakes.ts';
import { makeHarness, type Harness } from '../testing/harness.ts';
import { SubrequestBudget } from './budget.ts';
import { BOT_UNCONFIGURED_RETRY_SECONDS, DISCORD, DISCORD_EPOCH_MS, DISCORD_THREAD_NAME_MAX, OUTBOX_BACKOFF, THREAD_FRESH_MS, TICK_BUDGET } from './constants.ts';
import { drainOutbox } from './drain.ts';
import { fanOut } from './fanout.ts';
import { compileFilter } from './filter.ts';
import { outboxId } from './ids.ts';
import type { ModEvent, Subscription } from './types.ts';

const now = new Date(FIXED_NOW_ISO);
const SOURCE = 'thunderstore:valheim';
const CHANNEL = '123456789012345678';
const OLD_THREAD = '423456789012345678';
const ANCHOR = '523456789012345678';
const GONE = { ok: false, retryable: false, status: 404, gone: true } as const;

const forum = (over: Partial<Subscription> = {}): Subscription => makeBotSubscription({ id: 'forum', threadPerMod: true, channelKind: 'forum', ...over });
const textPerMod = (over: Partial<Subscription> = {}): Subscription => makeBotSubscription({ id: 'text', threadPerMod: true, channelKind: 'text', ...over });

const mod = (name: string, kind: 'new' | 'update' = 'new', version = kind === 'new' ? '1.0.0' : '2.0.0'): ModEvent =>
  makeEvent({ kind, versionTo: version, versionFrom: kind === 'update' ? '1.0.0' : null, pkg: { owner: 'Owner', name, packageId: `Owner-${name}` } });

async function queue(h: Harness, sub: Subscription, events: ModEvent[], nextAttemptAt = FIXED_NOW_ISO): Promise<void> {
  h.store.addSubscription(sub);
  await h.store.commit({
    source: SOURCE,
    packages: events.map((e) => e.pkg),
    events,
    outbox: events.map((e) => ({ id: outboxId(sub.id, e.id), subscriptionId: sub.id, eventId: e.id, attempts: 0, nextAttemptAt })),
    state: { id: SOURCE, cursor: null, etag: null, bootstrapped: true, lastOkAt: null },
  });
}

const drain = (h: Harness, budget?: SubrequestBudget, at = now) =>
  drainOutbox({ store: h.store, sender: h.sender, renderer: h.renderer, now: at, ...(budget ? { budget } : {}) });

const snowflakeAt = (ms: number): string => String(BigInt(ms - DISCORD_EPOCH_MS) << 22n);
const thread = (packageId: string, over: Partial<{ threadId: string; anchorMessageId: string | null; createdAt: string }> = {}) => ({
  channelId: CHANNEL,
  source: SOURCE,
  packageId,
  threadId: OLD_THREAD,
  anchorMessageId: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

let warnings: string[];
beforeEach(() => {
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void warnings.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

describe('drainOutbox: bot targets', () => {
  it('delivers a webhook and a bot subscription in the same tick', async () => {
    const h = makeHarness();
    const [a, b] = [mod('Alpha'), mod('Beta')];
    await queue(h, makeSubscription({ id: 'hook' }), [a]);
    await queue(h, makeBotSubscription(), [b]);
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 2, failed: 0, deferred: 0 });
    expect(h.sender.calls.map((c) => c.target.kind).sort()).toEqual(['bot', 'webhook']);
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('sends an immediate message to the channel and records it, without a mod thread', async () => {
    const h = makeHarness();
    const e = mod('Alpha');
    await queue(h, makeBotSubscription(), [e]);
    await drain(h);
    expect(h.sender.calls[0]!.target).toEqual({ kind: 'bot', channelId: CHANNEL, threadId: null });
    const messageId = (h.sender.results[0] as { messageId: string }).messageId;
    expect(await h.store.getMessage(messageId)).toEqual({ messageId, channelId: CHANNEL, source: SOURCE, packageId: 'Owner-Alpha', eventId: e.id, createdAt: FIXED_NOW_ISO });
    expect(h.store.modThreads.size).toBe(0);
  });

  it.each(['immediate', 'digest'] as const)('a subscription bound to a thread sends everything there in %s mode and maps no mod thread', async (mode) => {
    const h = makeHarness();
    await queue(h, makeBotSubscription({ mode, threadId: OLD_THREAD }), [mod('Alpha'), mod('Beta')], FIXED_NOW_ISO);
    await drain(h);
    expect(h.sender.calls.map((c) => c.target)).toEqual(mode === 'immediate' ? [expect.objectContaining({ kind: 'bot', channelId: CHANNEL, threadId: OLD_THREAD }), expect.objectContaining({ threadId: OLD_THREAD })] : [expect.objectContaining({ kind: 'bot', channelId: CHANNEL, threadId: OLD_THREAD })]);
    expect(h.store.modThreads.size).toBe(0);
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('writes message rows only for immediate messages, never for a digest', async () => {
    const h = makeHarness();
    await queue(h, makeBotSubscription({ mode: 'digest' }), [mod('Alpha'), mod('Beta')]);
    await drain(h);
    expect(h.store.messages.size).toBe(0);
  });

  it('a thread_per_mod subscription in digest mode sends a plain digest and writes no mod thread', async () => {
    const h = makeHarness();
    await queue(h, forum({ mode: 'digest' }), [mod('Alpha')]);
    await drain(h);
    expect(h.sender.forumPosts).toEqual([]);
    expect(h.sender.calls).toHaveLength(1);
    expect(h.store.modThreads.size).toBe(0);
    expect(h.store.messages.size).toBe(0);
  });

  it('leaves a bot subscription without a channel queued', async () => {
    const h = makeHarness();
    await queue(h, makeBotSubscription({ channelId: null }), [mod('Alpha')]);
    await drain(h);
    expect(h.sender.calls).toEqual([]);
    expect(h.store.pendingRows()).toHaveLength(1);
  });

  it('caps sends per channel, keyed by the channel and not by the thread', async () => {
    const h = makeHarness();
    const events = Array.from({ length: DISCORD.webhookRequestsPer2s + 3 }, (_, i) => mod(`M${i}`));
    await queue(h, makeBotSubscription({ id: 'one', threadId: OLD_THREAD }), events.slice(0, 4));
    await queue(h, makeBotSubscription({ id: 'two', threadId: ANCHOR }), events.slice(4));
    const report = await drain(h);
    expect(h.sender.calls).toHaveLength(DISCORD.webhookRequestsPer2s);
    expect(report.deferred).toBe(3);
  });

  it('keeps the rows of a failing channel apart from another channel', async () => {
    const h = makeHarness();
    await queue(h, makeBotSubscription({ id: 'down' }), [mod('Alpha')]);
    await queue(h, makeBotSubscription({ id: 'up', channelId: '223456789012345678' }), [mod('Beta')]);
    h.sender.fallback = (call) => (call.target.kind === 'bot' && call.target.channelId === CHANNEL ? { ok: false, retryable: true, retryAfterSeconds: null, status: 500 } : { ok: true, messageId: h.sender.freshId() });
    await drain(h);
    expect(h.store.pendingRows().map((r) => r.subscriptionId)).toEqual(['down']);
  });

  it('skips a paused bot subscription at fan-out', async () => {
    const paused = makeBotSubscription({ pausedUntil: Number.MAX_SAFE_INTEGER });
    const { rows } = await fanOut([mod('Alpha')], [{ sub: paused, filter: compileFilter(paused.filter) }], makeHarness().store, now);
    expect(rows).toEqual([]);
  });
});

describe('drainOutbox: forum with thread_per_mod', () => {
  it('a new event creates a post named after the mod with the message as its starter, and maps it', async () => {
    const h = makeHarness();
    const e = mod('Alpha');
    await queue(h, forum(), [e]);
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(h.sender.forumPosts).toEqual([{ channelId: CHANNEL, name: 'Alpha', payload: { content: `immediate:${e.id}`, allowed_mentions: { parse: [] } } }]);
    expect(h.sender.calls).toEqual([]);
    const saved = await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha');
    expect(saved).toMatchObject({ anchorMessageId: null, createdAt: FIXED_NOW_ISO });
    expect([...h.store.messages.values()]).toEqual([expect.objectContaining({ channelId: saved!.threadId, packageId: 'Owner-Alpha', eventId: e.id })]);
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('cuts the post title to the Discord limit', async () => {
    const h = makeHarness();
    await queue(h, forum(), [mod('N'.repeat(DISCORD_THREAD_NAME_MAX + 40))]);
    await drain(h);
    expect(h.sender.forumPosts[0]!.name).toBe('N'.repeat(DISCORD_THREAD_NAME_MAX));
  });

  it('an update goes into the mod post, without creating another', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Alpha'));
    const e = mod('Alpha', 'update');
    await queue(h, forum(), [e]);
    await drain(h);
    expect(h.sender.forumPosts).toEqual([]);
    expect(h.sender.calls.map((c) => c.target)).toEqual([{ kind: 'bot', channelId: CHANNEL, threadId: OLD_THREAD }]);
    const messageId = (h.sender.results[0] as { messageId: string }).messageId;
    expect(await h.store.getMessage(messageId)).toMatchObject({ channelId: OLD_THREAD, eventId: e.id });
    expect((await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!.createdAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('an update without a post creates it', async () => {
    const h = makeHarness();
    await queue(h, forum(), [mod('Alpha', 'update')]);
    await drain(h);
    expect(h.sender.forumPosts).toHaveLength(1);
    expect(await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha')).not.toBeNull();
  });

  it('a new and an update of one mod in the same tick share the post', async () => {
    const h = makeHarness();
    await queue(h, forum(), [mod('Alpha'), mod('Alpha', 'update')]);
    await drain(h);
    expect(h.sender.ops).toEqual(['post', 'send']);
  });

  it('a mod thread is shared by two subscriptions of the channel', async () => {
    const h = makeHarness();
    await queue(h, forum({ id: 'a' }), [mod('Alpha')]);
    await queue(h, forum({ id: 'b' }), [mod('Alpha', 'update')]);
    await drain(h);
    expect(h.sender.ops).toEqual(['post', 'send']);
  });
});

describe('drainOutbox: text channel with thread_per_mod', () => {
  it('a new event is a plain message with a thread opened on it at once', async () => {
    const h = makeHarness();
    await queue(h, textPerMod(), [mod('Alpha')]);
    const report = await drain(h);
    expect(h.sender.ops).toEqual(['send', 'open']);
    const messageId = (h.sender.results[0] as { messageId: string }).messageId;
    expect(h.sender.threadOpens).toEqual([{ channelId: CHANNEL, messageId, name: 'Alpha' }]);
    const mapped = (await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!;
    expect(mapped).toMatchObject({ anchorMessageId: messageId, createdAt: FIXED_NOW_ISO });
    expect(mapped.threadId).not.toBe('');
    expect(await h.store.getMessage(messageId)).toMatchObject({ channelId: CHANNEL });
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('the next update of that mod goes into the thread without opening another', async () => {
    const h = makeHarness();
    await queue(h, textPerMod(), [mod('Alpha')]);
    await drain(h);
    const { threadId } = (await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!;
    h.sender.ops.length = 0;
    await queue(h, textPerMod(), [mod('Alpha', 'update')]);
    await drain(h);
    expect(h.sender.ops).toEqual(['send']);
    expect(h.sender.calls.at(-1)!.target).toEqual({ kind: 'bot', channelId: CHANNEL, threadId });
  });

  it('the first update opens a thread on the anchor, posts there and keeps the anchor', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Alpha', { threadId: '', anchorMessageId: ANCHOR }));
    await queue(h, textPerMod(), [mod('Alpha', 'update')]);
    const report = await drain(h);
    expect(h.sender.ops).toEqual(['open', 'send']);
    expect(h.sender.threadOpens).toEqual([{ channelId: CHANNEL, messageId: ANCHOR, name: 'Alpha' }]);
    const opened = (await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!;
    expect(opened).toMatchObject({ anchorMessageId: ANCHOR, createdAt: FIXED_NOW_ISO });
    expect(opened.threadId).not.toBe('');
    expect(h.sender.calls[0]!.target).toEqual({ kind: 'bot', channelId: CHANNEL, threadId: opened.threadId });
    expect(report).toMatchObject({ sent: 1, failed: 0 });
  });

  it('the next update goes straight into the thread', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Alpha', { anchorMessageId: ANCHOR }));
    await queue(h, textPerMod(), [mod('Alpha', 'update')]);
    await drain(h);
    expect(h.sender.ops).toEqual(['send']);
    expect(h.sender.calls[0]!.target).toEqual({ kind: 'bot', channelId: CHANNEL, threadId: OLD_THREAD });
  });

  it('an update without a mapping is a plain message with a thread opened on it', async () => {
    const h = makeHarness();
    await queue(h, textPerMod(), [mod('Alpha', 'update')]);
    await drain(h);
    expect(h.sender.ops).toEqual(['send', 'open']);
    expect((await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!.threadId).not.toBe('');
  });

  it('keeps only the anchor and still delivers when there is no room to open the thread', async () => {
    const h = makeHarness();
    await queue(h, textPerMod(), [mod('Alpha')]);
    const report = await drain(h, new SubrequestBudget(1));
    expect(h.sender.ops).toEqual(['send']);
    const mapped = (await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!;
    expect(mapped.threadId).toBe('');
    expect(mapped.anchorMessageId).not.toBeNull();
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('keeps only the anchor and delivers when opening the thread fails, and opens it with the next update', async () => {
    const h = makeHarness();
    await queue(h, textPerMod(), [mod('Alpha')]);
    h.sender.enqueueOpen({ ok: false, retryable: true, retryAfterSeconds: null, status: 500 });
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 1, failed: 0, parked: 0 });
    expect(h.store.pendingRows()).toEqual([]);
    const mapped = (await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!;
    expect(mapped.threadId).toBe('');
    h.sender.ops.length = 0;
    await queue(h, textPerMod(), [mod('Alpha', 'update')]);
    await drain(h);
    expect(h.sender.ops).toEqual(['open', 'send']);
  });

  it('adopts the message id as the thread id when Discord says the thread already exists', async () => {
    const h = makeHarness();
    await queue(h, textPerMod(), [mod('Alpha')]);
    h.sender.enqueueOpen({ ok: false, retryable: false, status: 400, threadExists: true });
    await drain(h);
    const messageId = (h.sender.results[0] as { messageId: string }).messageId;
    expect(await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha')).toMatchObject({ threadId: messageId, anchorMessageId: messageId });
  });

  it('a thread opened but not posted into is remembered, so the retry spends one request', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Alpha', { threadId: '', anchorMessageId: ANCHOR }));
    await queue(h, textPerMod(), [mod('Alpha', 'update')]);
    h.sender.enqueue({ ok: false, retryable: true, retryAfterSeconds: null, status: 500 });
    await drain(h);
    const opened = (await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!;
    expect(opened.threadId).not.toBe('');
    h.sender.ops.length = 0;
    await drain(h, undefined, new Date(now.getTime() + OUTBOX_BACKOFF.baseSeconds * 1000 + 1));
    expect(h.sender.ops).toEqual(['send']);
    expect(h.store.pendingRows()).toEqual([]);
  });
});

describe('drainOutbox: a thread that is gone', () => {
  it('a forum post that is gone resets the mapping and the row becomes a new post in the same tick', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Alpha'));
    await queue(h, forum(), [mod('Alpha', 'update')]);
    h.sender.enqueue(GONE);
    const report = await drain(h);
    expect(h.sender.ops).toEqual(['send', 'post']);
    const replaced = (await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!;
    expect(replaced.threadId).not.toBe(OLD_THREAD);
    expect(replaced.createdAt).toBe(FIXED_NOW_ISO);
    expect(h.store.pendingRows()).toEqual([]);
    expect(report).toMatchObject({ sent: 1, failed: 0, parked: 0 });
  });

  it('a text thread that is gone resets the mapping and the row becomes a new message and anchor', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Alpha', { anchorMessageId: ANCHOR }));
    await queue(h, textPerMod(), [mod('Alpha', 'update')]);
    h.sender.enqueue(GONE);
    await drain(h);
    expect(h.sender.ops).toEqual(['send', 'send', 'open']);
    const replaced = (await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!;
    expect(replaced.threadId).not.toBe('');
    expect(replaced.threadId).not.toBe(OLD_THREAD);
    expect(replaced.anchorMessageId).not.toBe(ANCHOR);
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('an anchor that is gone when the thread is opened resets the mapping and sends a new message', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Alpha', { threadId: '', anchorMessageId: ANCHOR }));
    await queue(h, textPerMod(), [mod('Alpha', 'update')]);
    h.sender.enqueueOpen(GONE);
    await drain(h);
    expect(h.sender.ops).toEqual(['open', 'send', 'open']);
    const replaced = (await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!;
    expect(replaced.anchorMessageId).not.toBe(ANCHOR);
    expect(replaced.threadId).not.toBe('');
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('without room for a second request the mapping is reset and the row is due again at once, keeping its attempts', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Alpha'));
    await queue(h, forum(), [mod('Alpha', 'update')]);
    h.sender.enqueue(GONE);
    const report = await drain(h, new SubrequestBudget(1));
    expect(h.sender.ops).toEqual(['send']);
    expect(await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha')).toBeNull();
    expect(h.store.pendingRows()).toEqual([expect.objectContaining({ attempts: 0, nextAttemptAt: FIXED_NOW_ISO })]);
    expect(report).toMatchObject({ parked: 0, deferred: 1 });

    await drain(h);
    expect(h.sender.ops).toEqual(['send', 'post']);
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('a gone channel parks the row after one retry and leaves nothing mapped', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Alpha'));
    await queue(h, forum(), [mod('Alpha', 'update')]);
    h.sender.enqueue(GONE);
    h.sender.enqueuePost(GONE);
    const report = await drain(h);
    expect(report.parked).toBe(1);
    expect(await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha')).toBeNull();
  });

  describe('created within the last minute', () => {
    const fresh = new Date(now.getTime() - THREAD_FRESH_MS / 3).toISOString();

    it('keeps the mapping and retries the row with backoff instead of parking it', async () => {
      const h = makeHarness();
      await h.store.putModThread(thread('Owner-Alpha', { createdAt: fresh }));
      await queue(h, forum(), [mod('Alpha', 'update')]);
      h.sender.enqueue(GONE);
      const report = await drain(h);
      expect(h.sender.ops).toEqual(['send']);
      expect((await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!.threadId).toBe(OLD_THREAD);
      const [row] = h.store.pendingRows();
      expect(row).toMatchObject({ attempts: 1, nextAttemptAt: new Date(now.getTime() + OUTBOX_BACKOFF.baseSeconds * 1000).toISOString() });
      expect(report).toMatchObject({ parked: 0, failed: 1 });

      await drain(h, undefined, new Date(now.getTime() + OUTBOX_BACKOFF.baseSeconds * 1000 + 1));
      expect(h.sender.ops).toEqual(['send', 'send']);
      expect(h.store.pendingRows()).toEqual([]);
    });

    it('applies to a thread opened in this very tick', async () => {
      const h = makeHarness();
      await h.store.putModThread(thread('Owner-Alpha', { threadId: '', anchorMessageId: ANCHOR }));
      await queue(h, textPerMod(), [mod('Alpha', 'update')]);
      h.sender.enqueue(GONE);
      await drain(h);
      expect(h.sender.ops).toEqual(['open', 'send']);
      expect((await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!.threadId).not.toBe('');
      expect(h.store.pendingRows()).toEqual([expect.objectContaining({ attempts: 1 })]);
    });

    it('applies to a subscription bound to a post, judged by the age in its id', async () => {
      const h = makeHarness();
      const young = snowflakeAt(now.getTime() - THREAD_FRESH_MS / 3);
      await queue(h, makeBotSubscription({ threadId: young }), [mod('Alpha')]);
      h.sender.enqueue(GONE);
      const report = await drain(h);
      expect(report.parked).toBe(0);
      expect(h.store.pendingRows()).toEqual([expect.objectContaining({ attempts: 1 })]);
    });
  });

  it('parks a subscription bound to an old post that is gone, like any bad destination', async () => {
    const h = makeHarness();
    await queue(h, makeBotSubscription({ threadId: OLD_THREAD }), [mod('Alpha')]);
    h.sender.enqueue(GONE);
    const report = await drain(h);
    expect(report.parked).toBe(1);
    expect(h.store.pendingRows()).toEqual([]);
  });
});

describe('drainOutbox: a thread that already exists for the anchor', () => {
  const EXISTS = { ok: false, retryable: false, status: 400, threadExists: true } as const;

  it('uses the anchor id as the thread id, maps it and posts there', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Alpha', { threadId: '', anchorMessageId: ANCHOR }));
    await queue(h, textPerMod(), [mod('Alpha', 'update')]);
    h.sender.enqueueOpen(EXISTS);
    const report = await drain(h);
    expect(h.sender.ops).toEqual(['open', 'send']);
    expect(h.sender.calls[0]!.target).toEqual({ kind: 'bot', channelId: CHANNEL, threadId: ANCHOR });
    expect(await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha')).toMatchObject({ threadId: ANCHOR, anchorMessageId: ANCHOR });
    expect(report).toMatchObject({ sent: 1, failed: 0, parked: 0 });
    expect(h.store.pendingRows()).toEqual([]);
  });

  it('still posts when the thread was opened but its mapping could not be written', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Alpha', { threadId: '', anchorMessageId: ANCHOR }));
    await queue(h, textPerMod(), [mod('Alpha', 'update')]);
    h.store.putModThread = async () => {
      throw new Error('D1 is down');
    };
    await drain(h);
    expect(h.sender.ops).toEqual(['open', 'send']);
    expect(h.store.pendingRows()).toEqual([]);
    expect(warnings).toContain('outbox mapping write failed');
    expect((await h.store.getModThread(CHANNEL, SOURCE, 'Owner-Alpha'))!.threadId).toBe('');
  });
});

describe('drainOutbox: a target the sender cannot serve', () => {
  it('reschedules its rows without sending or spending, and leaves webhook groups their full allowance', async () => {
    const h = makeHarness();
    h.sender.unavailable.add('bot');
    await queue(h, makeBotSubscription({ id: 'b1' }), [mod('A1'), mod('A2')]);
    await queue(h, makeBotSubscription({ id: 'b2', channelId: '223456789012345678' }), [mod('B1')]);
    const hookEvents = Array.from({ length: DISCORD.webhookRequestsPer2s }, (_, i) => mod(`H${i}`));
    await queue(h, makeSubscription({ id: 'hook' }), hookEvents);
    const budget = new SubrequestBudget();
    const report = await drain(h, budget);
    expect(h.sender.calls.every((c) => c.target.kind === 'webhook')).toBe(true);
    expect(report.sent).toBe(DISCORD.webhookRequestsPer2s);
    expect(budget.used).toBe(DISCORD.webhookRequestsPer2s);
    const later = new Date(now.getTime() + BOT_UNCONFIGURED_RETRY_SECONDS * 1000).toISOString();
    expect(h.store.pendingRows().map((r) => [r.subscriptionId, r.attempts, r.nextAttemptAt])).toEqual([
      ['b1', 0, later],
      ['b1', 0, later],
      ['b2', 0, later],
    ]);
    expect(warnings.filter((line) => line.includes('waiting'))).toHaveLength(1);
  });
});

describe('drainOutbox: subrequest accounting', () => {
  it('spends one request on a forum post and two on a thread opened for an update', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Beta', { threadId: '', anchorMessageId: ANCHOR }));
    await queue(h, forum({ id: 'f' }), [mod('Alpha')]);
    await queue(h, textPerMod({ id: 't' }), [mod('Beta', 'update')]);
    const budget = new SubrequestBudget(10);
    await drain(h, budget);
    expect(budget.used).toBe(3);
    expect(h.sender.ops.length).toBe(3);
  });

  it('defers a row that needs two requests when one is left, without spending it', async () => {
    const h = makeHarness();
    await h.store.putModThread(thread('Owner-Alpha', { threadId: '', anchorMessageId: ANCHOR }));
    await queue(h, textPerMod(), [mod('Alpha', 'update')]);
    const budget = new SubrequestBudget(1);
    const report = await drain(h, budget);
    expect(h.sender.ops).toEqual([]);
    expect(budget.used).toBe(0);
    expect(report.deferred).toBe(1);
    expect(h.store.pendingRows()).toHaveLength(1);
  });

  it('counts a thread opening against the per-channel cap', async () => {
    const h = makeHarness();
    const mods = ['A', 'B', 'C'];
    for (const name of mods) await h.store.putModThread(thread(`Owner-${name}`, { threadId: '', anchorMessageId: ANCHOR }));
    await queue(h, textPerMod(), mods.map((name) => mod(name, 'update')));
    const report = await drain(h);
    expect(h.sender.ops).toEqual(['open', 'send', 'open', 'send']);
    expect(report.deferred).toBe(1);
  });

  it('never goes past the per-tick send cap or the shared budget, whatever mix of routes is queued', async () => {
    const h = makeHarness();
    const channels = Array.from({ length: 8 }, (_, i) => `${i + 1}23456789012345678`);
    for (const [i, channelId] of channels.entries()) {
      const mods = Array.from({ length: 4 }, (_, j) => `C${i}M${j}`);
      if (i % 2 === 0) {
        for (const name of mods) await h.store.putModThread({ ...thread(`Owner-${name}`), channelId, threadId: '', anchorMessageId: ANCHOR });
      }
      await queue(h, i % 2 === 0 ? textPerMod({ id: `c${i}`, channelId }) : forum({ id: `c${i}`, channelId }), mods.map((name) => mod(name, 'update')));
    }
    const budget = new SubrequestBudget();
    await drain(h, budget);
    expect(h.sender.ops.length).toBeLessThanOrEqual(TICK_BUDGET.maxDiscordSends);
    expect(budget.used).toBe(h.sender.ops.length);
    expect(budget.used).toBeLessThanOrEqual(budget.limit);
    expect(h.store.pendingRows().length).toBeGreaterThan(0);
  });
});

describe('drainOutbox: writes after a successful send', () => {
  it('delivers the row and logs one generic line when a map write fails', async () => {
    const h = makeHarness();
    await queue(h, forum(), [mod('Alpha')]);
    h.store.putModThread = async () => {
      throw new Error('D1 is down: secret-detail');
    };
    h.store.putMessage = async () => {
      throw new Error('D1 is down: secret-detail');
    };
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(h.store.pendingRows()).toEqual([]);
    expect(warnings).toEqual(['outbox mapping write failed', 'outbox mapping write failed']);
  });

  it('leaves the row queued when the thread lookup fails, so nothing is posted twice', async () => {
    const h = makeHarness();
    await queue(h, forum(), [mod('Alpha')]);
    h.store.getModThread = async () => {
      throw new Error('D1 is down');
    };
    const report = await drain(h);
    expect(report.error).toBe('D1 is down');
    expect(h.sender.ops).toEqual([]);
    expect(h.store.pendingRows()).toHaveLength(1);
  });
});
