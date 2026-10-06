// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { en } from '../../i18n/en.ts';
import { eventId, outboxId } from '../../core/ids.ts';
import type { CommitBatch } from '../../core/ports.ts';
import type { ModEvent, PackageSnapshot } from '../../core/types.ts';
import { autocompleteOf, CHANNEL_ID, command, GUILD_ID, harness, type Harness, inThread, PARENT_ID, subscription, THREAD_ID, USER_ID } from './harness.ts';

const ids = (h: Harness): string[] => [...h.store.subscriptions.keys()].sort();

const choices = async (h: Harness, interaction = autocompleteOf('unsubscribe', 'subscription', '')) =>
  ((await h.run(interaction)).data?.choices ?? []) as { name: string; value: string }[];

function seed(h: Harness): void {
  h.store.addSubscription(subscription({ id: 'here', label: 'Epic loot' }));
  h.store.addSubscription(subscription({ id: 'in-thread', label: 'Thread only', threadId: THREAD_ID }));
  h.store.addSubscription(subscription({ id: 'other-thread', label: 'Other thread', threadId: PARENT_ID }));
  h.store.addSubscription(subscription({ id: 'elsewhere', label: 'Elsewhere', channelId: PARENT_ID }));
  h.store.addSubscription(subscription({ id: 'other-guild', label: 'Foreign', guildId: '999999999999999999' }));
  h.store.addSubscription({ ...subscription({ id: 'hook', label: 'Webhook' }), transport: 'webhook', channelId: null, webhookUrl: 'https://discord.com/api/webhooks/1/x' });
}

describe('/unsubscribe autocomplete', () => {
  it('lists the subscriptions of the channel by label with the id as value, threads under it included', async () => {
    const h = harness();
    seed(h);
    expect(await choices(h)).toEqual(
      expect.arrayContaining([
        { name: 'Epic loot', value: 'here' },
        { name: 'Thread only', value: 'in-thread' },
        { name: 'Other thread', value: 'other-thread' },
      ]),
    );
    expect((await choices(h)).map((c) => c.value).sort()).toEqual(['here', 'in-thread', 'other-thread']);
  });

  it('in a thread lists its own subscriptions and its parent channel ones, not those of other threads', async () => {
    const h = harness();
    seed(h);
    expect((await choices(h, autocompleteOf('unsubscribe', 'subscription', '', { channel: inThread().channel }))).map((c) => c.value).sort()).toEqual(['here', 'in-thread']);
  });

  it('filters by what the user typed, case-insensitively, and falls back to the id for an unlabelled one', async () => {
    const h = harness();
    seed(h);
    h.store.addSubscription(subscription({ id: 'nolabel', label: null }));
    expect((await choices(h, autocompleteOf('unsubscribe', 'subscription', 'EPIC'))).map((c) => c.value)).toEqual(['here']);
    expect(await choices(h, autocompleteOf('unsubscribe', 'subscription', 'nolab'))).toEqual([{ name: 'nolabel', value: 'nolabel' }]);
  });

  it('shows at most 25 choices', async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) h.store.addSubscription(subscription({ id: `s${i}`, label: `Sub ${i}` }));
    expect(await choices(h)).toHaveLength(25);
  });

  it('lists nothing to someone without Manage Channel', async () => {
    const h = harness();
    seed(h);
    expect(await choices(h, autocompleteOf('unsubscribe', 'subscription', '', { member: { permissions: '0', user: { id: USER_ID } } }))).toEqual([]);
  });

  it('lists nothing in a direct message', async () => {
    const h = harness();
    seed(h);
    expect(await choices(h, autocompleteOf('unsubscribe', 'subscription', '', { guild_id: undefined }))).toEqual([]);
  });
});

describe('/unsubscribe', () => {
  it('removes the chosen subscription and confirms with its label', async () => {
    const h = harness();
    seed(h);
    expect(await h.run(command('unsubscribe', { subscription: 'here' }))).toEqual({ type: 5, data: { flags: 64 } });
    expect(h.followUp()).toBe(en.unsubscribed('Epic loot'));
    expect(ids(h)).not.toContain('here');
    expect(ids(h)).toHaveLength(5);
  });

  it('accepts a typed label that names exactly one subscription of the place', async () => {
    const h = harness();
    seed(h);
    await h.run(command('unsubscribe', { subscription: 'EPIC LOOT' }));
    expect(ids(h)).not.toContain('here');
    h.store.addSubscription(subscription({ id: 'twin-1', label: 'Twin' }));
    h.store.addSubscription(subscription({ id: 'twin-2', label: 'Twin' }));
    await h.run(command('unsubscribe', { subscription: 'twin' }));
    expect(h.followUp()).toBe(en.subscriptionNotFound);
    expect(ids(h)).toEqual(expect.arrayContaining(['twin-1', 'twin-2']));
  });

  it('never removes a subscription of another channel, another thread, another server or a webhook, whatever the id', async () => {
    const h = harness();
    seed(h);
    for (const id of ['elsewhere', 'other-guild', 'hook', 'missing']) {
      await h.run(command('unsubscribe', { subscription: id }));
      expect(h.followUp()).toBe(en.subscriptionNotFound);
    }
    await h.run(command('unsubscribe', { subscription: 'in-thread' }, { channel: { id: '777777777777777777', type: 11, parent_id: CHANNEL_ID } }));
    expect(h.followUp()).toBe(en.subscriptionNotFound);
    expect(ids(h)).toHaveLength(6);
  });

  it('refuses a subscription whose guild differs from the payload guild even in the same channel', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'forged', guildId: '999999999999999999' }));
    await h.run(command('unsubscribe', { subscription: 'forged' }));
    expect(ids(h)).toEqual(['forged']);
    expect(GUILD_ID).not.toBe('999999999999999999');
  });

  it('in a thread removes the thread own and the parent channel ones but not a sibling thread', async () => {
    const h = harness();
    seed(h);
    const inside = { channel: inThread().channel };
    await h.run(command('unsubscribe', { subscription: 'in-thread' }, inside));
    await h.run(command('unsubscribe', { subscription: 'here' }, inside));
    await h.run(command('unsubscribe', { subscription: 'other-thread' }, inside));
    expect(h.followUp()).toBe(en.subscriptionNotFound);
    expect(ids(h)).not.toContain('in-thread');
    expect(ids(h)).toContain('other-thread');
  });

  it('needs Manage Channel', async () => {
    const h = harness();
    seed(h);
    const response = await h.run(command('unsubscribe', { subscription: 'here' }, { member: { permissions: '0', user: { id: USER_ID } } }));
    expect(response.data?.content).toBe(en.missingManageChannel);
    expect(ids(h)).toContain('here');
  });

  it('answers a missing option politely', async () => {
    const h = harness();
    expect((await h.run(command('unsubscribe'))).data?.content).toBe(en.subscriptionNotFound);
  });

  it('deletes the undelivered outbox rows with the subscription and leaves the other subscriptions rows', async () => {
    const h = harness();
    h.store.addSubscription(subscription({ id: 'here' }));
    h.store.addSubscription(subscription({ id: 'keep' }));
    h.store.seedPackages('thunderstore:valheim', { 'Owner-Mod': '1.0.0' });
    const pkg: PackageSnapshot = [...h.store.packages.values()][0]!;
    const event: ModEvent = {
      id: eventId(pkg.source, pkg.packageId, '1.0.0'),
      kind: 'new',
      versionFrom: null,
      versionTo: '1.0.0',
      changelog: null,
      changelogUrl: null,
      createdAt: '2026-09-19T00:00:00.000Z',
      pkg,
      alsoOn: [],
    };
    const row = (subscriptionId: string) => ({ id: outboxId(subscriptionId, event.id), subscriptionId, eventId: event.id, attempts: 0, nextAttemptAt: '2026-09-19T00:00:00.000Z' });
    const batch: CommitBatch = {
      source: pkg.source,
      packages: [pkg],
      events: [event],
      outbox: [row('here'), row('keep')],
      state: { id: pkg.source, cursor: null, etag: null, bootstrapped: true, lastOkAt: null },
    };
    await h.store.commit(batch);
    await h.run(command('unsubscribe', { subscription: 'here' }));
    expect(h.store.pendingRows().map((r) => r.subscriptionId)).toEqual(['keep']);
  });
});
