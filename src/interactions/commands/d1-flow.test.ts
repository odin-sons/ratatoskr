// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { D1Store } from '../../cloudflare/d1-store.ts';
import { D1Shim } from '../../cloudflare/testing/d1-shim.ts';
import { autocompleteOf, command, GUILD_ID, harness, CHANNEL_ID } from './harness.ts';

const SCHEMA = readFileSync(join(import.meta.dirname, '../../../schema.sql'), 'utf8');

function d1Harness() {
  const shim = new D1Shim();
  shim.db.exec(SCHEMA);
  return harness({ store: new D1Store(shim as unknown as D1Database), ids: ['first', 'second'] });
}

describe('subscribe, list and unsubscribe over the D1 store', () => {
  it('creates, lists and removes bot subscriptions end to end', async () => {
    const h = d1Harness();
    await h.run(command('subscribe', { owner: 'RandyKnapp', label: 'Randy' }));
    await h.run(command('subscribe', { category: 'Tools', mode: 'immediate', thread_per_mod: true, kind: 'update' }));
    expect(await h.store.countSubscriptions()).toBe(2);
    expect(await h.store.listSubscriptionsByChannel(CHANNEL_ID)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'first', guildId: GUILD_ID, transport: 'bot', label: 'Randy', threadId: null, threadPerMod: false, filter: { packages: ['RandyKnapp'] } }),
        expect.objectContaining({ id: 'second', mode: 'immediate', threadPerMod: true, filter: { includeCategories: ['Tools'], kinds: ['update'] } }),
      ]),
    );

    const listed = String((await h.run(command('list'))).data?.content);
    expect(listed).toContain('**Randy** `first`');
    expect(listed).toContain('immediate · thread per mod');

    const choices = (await h.run(autocompleteOf('unsubscribe', 'subscription', 'ran'))).data?.choices;
    expect(choices).toEqual([{ name: 'Randy', value: 'first' }]);

    await h.run(command('unsubscribe', { subscription: 'first' }));
    expect(await h.store.countSubscriptions()).toBe(1);
    expect(h.followUp()).toBe('Removed the subscription Randy.');
  });

  it('refuses the same subscription twice', async () => {
    const h = d1Harness();
    await h.run(command('subscribe', { owner: 'a' }));
    await h.run(command('subscribe', { owner: 'a' }));
    expect(await h.store.countSubscriptions()).toBe(1);
    expect(h.followUp()).toBe('An identical subscription already exists here.');
  });
});
