// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { D1Store } from '../../cloudflare/d1-store.ts';
import { D1Shim } from '../../cloudflare/testing/d1-shim.ts';
import { fanOut } from '../../core/fanout.ts';
import { compileFilter } from '../../core/filter.ts';
import { outboxId } from '../../core/ids.ts';
import type { CommitBatch, Store } from '../../core/ports.ts';
import { PAUSE_OPEN_ENDED } from '../../core/pause.ts';
import type { ModEvent } from '../../core/types.ts';
import { en } from '../../i18n/en.ts';
import { ru } from '../../i18n/ru.ts';
import { makeEvent } from '../../testing/fakes.ts';
import { autocompleteOf, CHANNEL_ID, command, harness, type Harness, inThread, NOW, PARENT_ID, subscription, THREAD_ID, USER_ID } from './harness.ts';

const nowSeconds = NOW.getTime() / 1000;
const stamp = (epoch: number): string => `<t:${epoch}:R>`;
const denied = { member: { permissions: '0', user: { id: USER_ID } } };

const pausedUntil = async (store: Store, id: string): Promise<number | undefined> => {
  const all = [...(await store.listSubscriptionsByChannel(CHANNEL_ID)), ...(await store.listSubscriptionsByChannel(PARENT_ID))];
  return all.find((sub) => sub.id === id)?.pausedUntil;
};

function seed(h: Harness): void {
  h.store.addSubscription(subscription({ id: 'a', label: 'Alpha' }));
  h.store.addSubscription(subscription({ id: 'b', label: 'Beta' }));
  h.store.addSubscription(subscription({ id: 'elsewhere', label: 'Elsewhere', channelId: PARENT_ID }));
  h.store.addSubscription(subscription({ id: 'foreign', label: 'Foreign', guildId: '999999999999999999' }));
  h.store.addSubscription({ ...subscription({ id: 'hook', label: 'Hook' }), transport: 'webhook', channelId: null, webhookUrl: 'https://discord.com/api/webhooks/1/x' });
}

async function queue(store: Store, event: ModEvent, subscriptionIds: string[]): Promise<void> {
  const batch: CommitBatch = {
    source: event.pkg.source,
    packages: [event.pkg],
    events: [event],
    outbox: subscriptionIds.map((id) => ({ id: outboxId(id, event.id), subscriptionId: id, eventId: event.id, attempts: 0, nextAttemptAt: '2026-09-19T00:00:00.000Z' })),
    state: { id: event.pkg.source, cursor: null, etag: null, bootstrapped: true, lastOkAt: null },
  };
  await store.commit(batch);
}

describe('/pause', () => {
  it('pauses every subscription of the place without options, open-ended, and says so', async () => {
    const h = harness();
    seed(h);
    expect(await h.run(command('pause'))).toEqual({ type: 5, data: { flags: 64 } });
    expect(h.followUp()).toBe(en.pausedOpen('Alpha, Beta'));
    expect(await pausedUntil(h.store, 'a')).toBe(PAUSE_OPEN_ENDED);
    expect(await pausedUntil(h.store, 'b')).toBe(PAUSE_OPEN_ENDED);
  });

  it('never touches other channels, other servers or webhooks', async () => {
    const h = harness();
    seed(h);
    await h.run(command('pause'));
    expect(h.store.subscriptions.get('elsewhere')!.pausedUntil ?? 0).toBe(0);
    expect(h.store.subscriptions.get('foreign')!.pausedUntil ?? 0).toBe(0);
    expect(h.store.subscriptions.get('hook')!.pausedUntil ?? 0).toBe(0);
  });

  it.each([
    ['30m', 1_800],
    ['2h', 7_200],
    ['3d', 259_200],
  ])('pauses for %s from the clock of the command and shows when it ends', async (text, seconds) => {
    const h = harness();
    seed(h);
    await h.run(command('pause', { subscription: 'a', for: text }));
    expect(h.followUp()).toBe(en.pausedFor('Alpha', stamp(nowSeconds + seconds)));
    expect(await pausedUntil(h.store, 'a')).toBe(nowSeconds + seconds);
    expect(await pausedUntil(h.store, 'b')).toBe(0);
  });

  it('accepts a typed label of the place and refuses an id of another place', async () => {
    const h = harness();
    seed(h);
    await h.run(command('pause', { subscription: 'ALPHA' }));
    expect(await pausedUntil(h.store, 'a')).toBe(PAUSE_OPEN_ENDED);
    for (const id of ['elsewhere', 'foreign', 'hook', 'missing']) {
      await h.run(command('pause', { subscription: id }));
      expect(h.followUp()).toBe(en.subscriptionNotFound);
    }
    expect(h.store.subscriptions.get('elsewhere')!.pausedUntil ?? 0).toBe(0);
    expect(h.store.subscriptions.get('foreign')!.pausedUntil ?? 0).toBe(0);
  });

  it.each(['0m', '59m0', '91d', '2161h', '1.5h', '2w', '2', 'abc', '-1h'])('rejects the duration %j with a clear message and changes nothing', async (text) => {
    const h = harness();
    seed(h);
    const response = await h.run(command('pause', { for: text }));
    expect(response.data?.content).toBe(en.pauseInvalidDuration);
    expect(response.data?.flags).toBe(64);
    expect(await pausedUntil(h.store, 'a')).toBe(0);
    expect(h.finished).toEqual([]);
  });

  it('answers in the language of the deployment', async () => {
    const h = harness({ messages: ru });
    seed(h);
    expect((await h.run(command('pause', { subscription: 'a', for: 'zz' }))).data?.content).toBe(ru.pauseInvalidDuration);
    await h.run(command('pause', { subscription: 'a', for: '1h' }));
    expect(h.followUp()).toBe(ru.pausedFor('Alpha', stamp(nowSeconds + 3_600)));
  });

  it('reports a subscription that is already paused and leaves its pause alone', async () => {
    const h = harness();
    seed(h);
    await h.run(command('pause', { subscription: 'a', for: '2h' }));
    await h.run(command('pause', { for: '1d' }));
    expect(h.followUp()).toBe(`${en.pausedFor('Beta', stamp(nowSeconds + 86_400))}\n${en.alreadyPaused('Alpha')}`);
    expect(await pausedUntil(h.store, 'a')).toBe(nowSeconds + 7_200);
    await h.run(command('pause', { subscription: 'a' }));
    expect(h.followUp()).toBe(en.alreadyPaused('Alpha'));
  });

  it('pauses again once an earlier timed pause has run out', async () => {
    const h = harness({ now: () => new Date(NOW.getTime() + 3 * 3_600_000) });
    h.store.addSubscription(subscription({ id: 'a', label: 'Alpha', pausedUntil: nowSeconds + 3_600 }));
    await h.run(command('pause', { subscription: 'a' }));
    expect(h.followUp()).toBe(en.pausedOpen('Alpha'));
  });

  it('says there is nothing to pause where there are no subscriptions', async () => {
    const h = harness();
    await h.run(command('pause'));
    expect(h.followUp()).toBe(en.listEmpty);
  });

  it('removes the undelivered rows of the paused subscriptions only', async () => {
    const h = harness();
    seed(h);
    h.store.addSubscription(subscription({ id: 'keep', label: 'Keep', channelId: PARENT_ID }));
    await queue(h.store, makeEvent(), ['a', 'b', 'keep']);
    await h.run(command('pause', { subscription: 'a' }));
    expect(h.store.pendingRows().map((r) => r.subscriptionId).sort()).toEqual(['b', 'keep']);
    await h.run(command('pause'));
    expect(h.store.pendingRows().map((r) => r.subscriptionId)).toEqual(['keep']);
  });

  it('keeps the queued rows of a subscription that was already paused', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'a', label: 'Alpha', pausedUntil: PAUSE_OPEN_ENDED }));
    await queue(h.store, makeEvent(), ['a']);
    await h.run(command('pause', { subscription: 'a' }));
    expect(h.store.pendingRows()).toHaveLength(1);
  });

  it('in a thread pauses the thread own and the parent channel subscriptions but not a sibling thread', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'parent', label: 'Parent' }));
    h.store.addSubscription(subscription({ id: 'mine', label: 'Mine', threadId: THREAD_ID }));
    h.store.addSubscription(subscription({ id: 'sibling', label: 'Sibling', threadId: PARENT_ID }));
    await h.run(command('pause', {}, { channel: inThread().channel }));
    expect(await pausedUntil(h.store, 'parent')).toBe(PAUSE_OPEN_ENDED);
    expect(await pausedUntil(h.store, 'mine')).toBe(PAUSE_OPEN_ENDED);
    expect(await pausedUntil(h.store, 'sibling')).toBe(0);
  });

  it('needs Manage Channel and a guild channel', async () => {
    const h = harness();
    seed(h);
    expect((await h.run(command('pause', {}, denied))).data?.content).toBe(en.missingManageChannel);
    expect((await h.run(command('pause', {}, { guild_id: undefined }))).data?.content).toBe(en.guildOnly);
    expect(await pausedUntil(h.store, 'a')).toBe(0);
  });

  it('escapes markdown and mentions in a label', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'a', label: '@everyone **x**' }));
    await h.run(command('pause'));
    expect(h.followUp()).not.toContain('@everyone');
    expect(h.followUp()).not.toContain('**x**');
  });

  it('autocompletes the subscriptions of the place', async () => {
    const h = harness();
    seed(h);
    for (const name of ['pause', 'continue']) {
      const choices = ((await h.run(autocompleteOf(name, 'subscription', 'alp'))).data?.choices ?? []) as { name: string; value: string }[];
      expect(choices).toEqual([{ name: 'Alpha', value: 'a' }]);
    }
  });
});

describe('D1 call count', () => {
  it('pausing and resuming 50 subscriptions takes one batch each', async () => {
    const shim = new D1Shim();
    shim.db.exec(readFileSync(join(import.meta.dirname, '../../../schema.sql'), 'utf8'));
    const h = harness({ store: new D1Store(shim as unknown as D1Database) });
    for (let i = 0; i < 50; i++) await h.store.createSubscription(subscription({ id: `s${i}`, label: `Sub ${i}` }));
    shim.batchSizes.length = 0;
    shim.preparedSql.length = 0;
    await h.run(command('pause'));
    expect(shim.batchSizes).toEqual([50, 50]);
    await h.run(command('continue'));
    expect(shim.batchSizes).toEqual([50, 50, 50]);
    expect(shim.preparedSql.filter((sql) => sql.startsWith('UPDATE'))).toHaveLength(100);
  });
});

describe('/continue', () => {
  it('resumes every paused subscription of the place and reports the ones that were not paused', async () => {
    const h = harness();
    seed(h);
    await h.run(command('pause', { subscription: 'a' }));
    await h.run(command('continue'));
    expect(h.followUp()).toBe(`${en.resumed('Alpha')}\n${en.notPaused('Beta')}`);
    expect(await pausedUntil(h.store, 'a')).toBe(0);
  });

  it('resumes the chosen subscription only', async () => {
    const h = harness();
    seed(h);
    await h.run(command('pause'));
    await h.run(command('continue', { subscription: 'b' }));
    expect(h.followUp()).toBe(en.resumed('Beta'));
    expect(await pausedUntil(h.store, 'a')).toBe(PAUSE_OPEN_ENDED);
    expect(await pausedUntil(h.store, 'b')).toBe(0);
  });

  it('reports a subscription that is not paused, and one whose timed pause already ran out', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'a', label: 'Alpha' }));
    h.store.addSubscription(subscription({ id: 'b', label: 'Beta', pausedUntil: nowSeconds - 5 }));
    await h.run(command('continue'));
    expect(h.followUp()).toBe(en.notPaused('Alpha, Beta'));
  });

  it('never resumes a subscription of another place', async () => {
    const h = harness();
    seed(h);
    h.store.addSubscription(subscription({ id: 'p', label: 'P', channelId: PARENT_ID, pausedUntil: PAUSE_OPEN_ENDED }));
    for (const id of ['p', 'foreign', 'hook', 'missing']) {
      await h.run(command('continue', { subscription: id }));
      expect(h.followUp()).toBe(en.subscriptionNotFound);
    }
    expect(h.store.subscriptions.get('p')!.pausedUntil).toBe(PAUSE_OPEN_ENDED);
  });

  it('needs Manage Channel', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'a', pausedUntil: PAUSE_OPEN_ENDED }));
    expect((await h.run(command('continue', {}, denied))).data?.content).toBe(en.missingManageChannel);
    expect(await pausedUntil(h.store, 'a')).toBe(PAUSE_OPEN_ENDED);
  });

  it('says there is nothing to resume where there are no subscriptions', async () => {
    const h = harness();
    await h.run(command('continue'));
    expect(h.followUp()).toBe(en.listEmpty);
  });
});

describe('pause and fan-out', () => {
  const eventOf = (name: string) => makeEvent({ pkg: { owner: 'Au', name } });
  const rowsAt = async (h: Harness, at: Date, name: string): Promise<string[]> => {
    const subs = (await h.store.listSubscriptions()).map((sub) => ({ sub, filter: compileFilter(sub.filter) }));
    const { rows } = await fanOut([eventOf(name)], subs, h.store, at);
    return rows.map((row) => row.subscriptionId);
  };

  it('a timed pause queues nothing until it ends by itself, without any command in between', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'a', label: 'Alpha', mode: 'immediate' }));
    await h.run(command('pause', { for: '2h' }));
    expect(await rowsAt(h, NOW, 'During')).toEqual([]);
    expect(await rowsAt(h, new Date(NOW.getTime() + 2 * 3_600_000 - 1_000), 'Late')).toEqual([]);
    expect(await rowsAt(h, new Date(NOW.getTime() + 2 * 3_600_000), 'After')).toEqual(['a']);
  });

  it('an open-ended pause queues nothing until /continue', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'a', label: 'Alpha', mode: 'immediate' }));
    await h.run(command('pause'));
    expect(await rowsAt(h, new Date(NOW.getTime() + 400 * 86_400_000), 'Far')).toEqual([]);
    await h.run(command('continue'));
    expect(await rowsAt(h, NOW, 'Back')).toEqual(['a']);
  });

  it('events of the pause are not delivered afterwards', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'a', label: 'Alpha', mode: 'immediate' }));
    await h.run(command('pause', { for: '1h' }));
    expect(await rowsAt(h, NOW, 'During')).toEqual([]);
    await h.run(command('continue'));
    expect(h.store.pendingRows()).toEqual([]);
  });
});

describe('/list with a pause', () => {
  const listed = async (h: Harness): Promise<string> => String((await h.run(command('list'))).data?.content);

  it('shows when a timed pause ends and that an open-ended one is a pause', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'a', label: 'Alpha' }));
    h.store.addSubscription(subscription({ id: 'b', label: 'Beta' }));
    await h.run(command('pause', { subscription: 'a', for: '3d' }));
    await h.run(command('pause', { subscription: 'b' }));
    const text = await listed(h);
    expect(text).toContain(`everything · ${en.listPausedUntil(stamp(nowSeconds + 259_200))}`);
    expect(text).toMatch(/\*\*Beta\*\* `b` .* · everything · paused$/);
  });

  it('shows nothing once the pause has ended or after /continue', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'a', label: 'Alpha', pausedUntil: nowSeconds - 1 }));
    expect(await listed(h)).not.toMatch(/paused/);
    h.store.addSubscription(subscription({ id: 'b', label: 'Beta', pausedUntil: PAUSE_OPEN_ENDED }));
    await h.run(command('continue'));
    expect(await listed(h)).not.toMatch(/paused/);
  });

  it('is shown in Russian too', async () => {
    const h = harness({ messages: ru });
    h.store.addSubscription(subscription({ id: 'a', label: 'Alpha', pausedUntil: PAUSE_OPEN_ENDED }));
    expect(await listed(h)).toContain(ru.listPausedOpen);
  });
});

describe('/pause and /continue over the D1 store', () => {
  const SCHEMA = readFileSync(join(import.meta.dirname, '../../../schema.sql'), 'utf8');

  it('pauses with queued rows, lists the pause and resumes', async () => {
    const shim = new D1Shim();
    shim.db.exec(SCHEMA);
    const h = harness({ store: new D1Store(shim as unknown as D1Database) });
    await h.store.createSubscription(subscription({ id: 'a', label: 'Alpha', mode: 'immediate' }));
    await h.store.createSubscription(subscription({ id: 'b', label: 'Beta', channelId: PARENT_ID }));
    const event = makeEvent();
    await queue(h.store, event, ['a']);
    const rows = (): number => (shim.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL').get() as { n: number }).n;
    expect(rows()).toBe(1);

    await h.run(command('pause', { for: '2h' }));
    expect(h.followUp()).toBe(en.pausedFor('Alpha', stamp(nowSeconds + 7_200)));
    expect(rows()).toBe(0);
    expect((await h.store.listSubscriptionsByChannel(CHANNEL_ID))[0]!.pausedUntil).toBe(nowSeconds + 7_200);
    expect((await h.store.listSubscriptionsByChannel(PARENT_ID))[0]!.pausedUntil).toBe(0);
    expect(String((await h.run(command('list'))).data?.content)).toContain(en.listPausedUntil(stamp(nowSeconds + 7_200)));

    await h.run(command('continue'));
    expect(h.followUp()).toBe(en.resumed('Alpha'));
    expect((await h.store.listSubscriptionsByChannel(CHANNEL_ID))[0]!.pausedUntil).toBe(0);
  });
});
