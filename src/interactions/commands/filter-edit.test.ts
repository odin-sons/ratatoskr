// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ALSO_MATCH_MAX_RULES, EXCLUDE_LIST_MAX } from '../../core/constants.ts';
import { compileFilter } from '../../core/filter.ts';
import type { Store } from '../../core/ports.ts';
import type { ModEvent, SubscriptionFilter } from '../../core/types.ts';
import { en } from '../../i18n/en.ts';
import { ru } from '../../i18n/ru.ts';
import { makeEvent } from '../../testing/fakes.ts';
import { autocompleteOf, command, harness, type Harness, inThread, PARENT_ID, subscription, USER_ID } from './harness.ts';

const denied = { member: { permissions: '0', user: { id: USER_ID } } };
const filterOf = (h: Harness, id = 'kg'): SubscriptionFilter => h.store.subscriptions.get(id)!.filter;

function seed(h: Harness, filter: SubscriptionFilter = { packages: ['KG'] }): void {
  h.store.addSubscription(subscription({ id: 'kg', label: 'KG', filter }));
  h.store.addSubscription(subscription({ id: 'elsewhere', label: 'Elsewhere', channelId: PARENT_ID, filter: { packages: ['KG'] } }));
  h.store.addSubscription(subscription({ id: 'foreign', label: 'Foreign', guildId: '999999999999999999', filter: { packages: ['KG'] } }));
}

async function seedMod(store: Store, owner: string, name: string): Promise<ModEvent> {
  const event = makeEvent({ pkg: { owner, name, packageId: `${owner}-${name}` } });
  await store.commit({
    source: event.pkg.source,
    packages: [event.pkg],
    events: [event],
    outbox: [],
    state: { id: event.pkg.source, cursor: null, etag: null, bootstrapped: true, lastOkAt: null },
  });
  return event;
}

describe('/include', () => {
  it('adds an author as an extra rule and says so', async () => {
    const h = harness();
    seed(h);
    expect(await h.run(command('include', { subscription: 'kg', owner: 'Someone' }))).toEqual({ type: 5, data: { flags: 64 } });
    expect(filterOf(h)).toEqual({ packages: ['KG'], alsoMatch: [{ packages: ['Someone'] }] });
    expect(h.followUp()).toBe(en.included('KG', en.filterPackages('Someone')));
  });

  it('adds a category, a store and an existing mod', async () => {
    const h = harness();
    seed(h);
    await seedMod(h.store, 'Third', 'Gamma');
    await h.run(command('include', { subscription: 'kg', category: 'Tools' }));
    await h.run(command('include', { subscription: 'kg', source: 'hexium' }));
    await h.run(command('include', { subscription: 'kg', mod: 'Third-Gamma' }));
    expect(filterOf(h).alsoMatch).toEqual([{ includeCategories: ['Tools'] }, { sources: ['hexium:valheim'] }, { packages: ['Third-Gamma'] }]);
  });

  it('combines the options of one command into one rule, joined by AND', async () => {
    const h = harness();
    seed(h);
    await h.run(command('include', { subscription: 'kg', owner: 'Someone', category: 'Tools' }));
    expect(filterOf(h).alsoMatch).toEqual([{ packages: ['Someone'], includeCategories: ['Tools'] }]);
  });

  it('makes the widened subscription accept what only the rule allows', async () => {
    const h = harness();
    seed(h);
    const event = await seedMod(h.store, 'Someone', 'Beta');
    expect(compileFilter(filterOf(h)).matches(event)).toBe(false);
    await h.run(command('include', { subscription: 'kg', owner: 'Someone' }));
    expect(compileFilter(filterOf(h)).matches(event)).toBe(true);
  });

  it('refuses a subscription that already matches everything', async () => {
    const h = harness();
    seed(h, { kinds: ['new'] });
    await h.run(command('include', { subscription: 'kg', owner: 'Someone' }));
    expect(h.followUp()).toBe(en.includeNothingToWiden);
    expect(filterOf(h)).toEqual({ kinds: ['new'] });
  });

  it('answers a duplicate without adding it twice', async () => {
    const h = harness();
    seed(h);
    await h.run(command('include', { subscription: 'kg', owner: 'Someone' }));
    await h.run(command('include', { subscription: 'kg', owner: 'someone' }));
    expect(h.followUp()).toBe(en.includeDuplicate('KG'));
    expect(filterOf(h).alsoMatch).toHaveLength(1);
  });

  it('stops at the cap of extra rules', async () => {
    const h = harness();
    seed(h, { packages: ['KG'], alsoMatch: Array.from({ length: ALSO_MATCH_MAX_RULES }, (_, i) => ({ packages: [`A${i}`] })) });
    await h.run(command('include', { subscription: 'kg', owner: 'OneTooMany' }));
    expect(h.followUp()).toBe(en.includeLimit(ALSO_MATCH_MAX_RULES));
    expect(filterOf(h).alsoMatch).toHaveLength(ALSO_MATCH_MAX_RULES);
  });

  it('needs an option, refuses owner with mod, and finds the mod before adding it', async () => {
    const h = harness();
    seed(h);
    expect(await h.run(command('include', { subscription: 'kg' }))).toMatchObject({ data: { content: en.includeNeedsOption } });
    expect(await h.run(command('include', { subscription: 'kg', owner: 'A', mod: 'A-B' }))).toMatchObject({ data: { content: en.subscribeOwnerAndMod } });
    await h.run(command('include', { subscription: 'kg', mod: 'Nobody-Nothing' }));
    expect(h.followUp()).toBe(en.modNotFound('Nobody-Nothing'));
    expect(filterOf(h)).toEqual({ packages: ['KG'] });
  });

  it('reports a store that is not configured', async () => {
    const h = harness({ sources: [{ id: 'thunderstore:valheim', store: 'thunderstore', community: 'valheim', enabled: true }] });
    seed(h);
    expect(await h.run(command('include', { subscription: 'kg', source: 'nexus' }))).toMatchObject({ data: { content: en.sourceNotConfigured('nexus') } });
  });
});

describe('/exclude', () => {
  it('adds an author, a mod and a category to the exclusions', async () => {
    const h = harness();
    seed(h);
    await seedMod(h.store, 'Third', 'Gamma');
    await h.run(command('exclude', { subscription: 'kg', owner: 'Spammer' }));
    await h.run(command('exclude', { subscription: 'kg', mod: 'Third-Gamma', category: 'Cheats' }));
    expect(filterOf(h)).toEqual({ packages: ['KG'], excludePackages: ['Spammer', 'Third-Gamma'], excludeCategories: ['Cheats'] });
  });

  it('makes the subscription drop what it excluded, even if a rule allows it', async () => {
    const h = harness();
    seed(h, { packages: ['KG'], alsoMatch: [{ packages: ['Someone'] }] });
    const event = await seedMod(h.store, 'Someone', 'Beta');
    expect(compileFilter(filterOf(h)).matches(event)).toBe(true);
    await h.run(command('exclude', { subscription: 'kg', mod: 'Someone-Beta' }));
    expect(compileFilter(filterOf(h)).matches(event)).toBe(false);
  });

  it('does not repeat an entry and says it is already excluded', async () => {
    const h = harness();
    seed(h);
    await h.run(command('exclude', { subscription: 'kg', owner: 'Spammer' }));
    await h.run(command('exclude', { subscription: 'kg', owner: 'spammer' }));
    expect(h.followUp()).toBe(en.excludeAlready('KG'));
    expect(filterOf(h).excludePackages).toEqual(['Spammer']);
  });

  it('stops at the cap of entries per list', async () => {
    const h = harness();
    seed(h, { packages: ['KG'], excludePackages: Array.from({ length: EXCLUDE_LIST_MAX }, (_, i) => `Owner${i}`) });
    await h.run(command('exclude', { subscription: 'kg', owner: 'OneTooMany' }));
    expect(h.followUp()).toBe(en.excludeLimit(EXCLUDE_LIST_MAX));
    expect(filterOf(h).excludePackages).toHaveLength(EXCLUDE_LIST_MAX);
  });

  it('needs an option and a mod that exists', async () => {
    const h = harness();
    seed(h);
    expect(await h.run(command('exclude', { subscription: 'kg' }))).toMatchObject({ data: { content: en.excludeNeedsOption } });
    await h.run(command('exclude', { subscription: 'kg', mod: 'Nobody-Nothing' }));
    expect(h.followUp()).toBe(en.modNotFound('Nobody-Nothing'));
  });
});

describe('/filter', () => {
  it('shows the filter when no change is asked for', async () => {
    const h = harness();
    seed(h, { packages: ['KG'], alsoMatch: [{ packages: ['Someone'] }, { includeCategories: ['Tools'] }], excludePackages: ['Spammer'], allowNsfw: true });
    await h.run(command('filter', { subscription: 'kg' }));
    const text = h.followUp();
    expect(text).toContain(en.filterShowTitle('KG'));
    expect(text).toContain(en.filterShowMatches(en.filterPackages('KG')));
    expect(text).toContain(`1. ${en.filterPackages('Someone')}`);
    expect(text).toContain(`2. ${en.filterCategories('Tools')}`);
    expect(text).toContain(en.filterShowExcluded('Spammer'));
    expect(text).toContain(en.filterShowFlags(en.yes, en.yes));
    expect(filterOf(h)).toEqual({ packages: ['KG'], alsoMatch: [{ packages: ['Someone'] }, { includeCategories: ['Tools'] }], excludePackages: ['Spammer'], allowNsfw: true });
  });

  it('narrows by kind and by store, and widens again with both and all', async () => {
    const h = harness();
    seed(h);
    await h.run(command('filter', { subscription: 'kg', kind: 'update', source: 'hexium' }));
    expect(filterOf(h)).toEqual({ packages: ['KG'], kinds: ['update'], sources: ['hexium:valheim'] });
    expect(h.followUp()).toContain(en.filterChanged('KG'));
    await h.run(command('filter', { subscription: 'kg', kind: 'both', source: 'all' }));
    expect(filterOf(h)).toEqual({ packages: ['KG'] });
  });

  it('switches adult content and the changelog', async () => {
    const h = harness();
    seed(h);
    await h.run(command('filter', { subscription: 'kg', nsfw: true, changelog: false }));
    expect(filterOf(h)).toEqual({ packages: ['KG'], allowNsfw: true, includeChangelog: false });
    await h.run(command('filter', { subscription: 'kg', nsfw: false, changelog: true }));
    expect(filterOf(h)).toEqual({ packages: ['KG'] });
  });

  it('removes an extra rule by its number', async () => {
    const h = harness();
    seed(h, { packages: ['KG'], alsoMatch: [{ packages: ['A'] }, { packages: ['B'] }] });
    await h.run(command('filter', { subscription: 'kg', remove_rule: 1 }));
    expect(filterOf(h).alsoMatch).toEqual([{ packages: ['B'] }]);
    await h.run(command('filter', { subscription: 'kg', remove_rule: 2 }));
    expect(h.followUp()).toBe(en.filterRuleNotFound(2));
    await h.run(command('filter', { subscription: 'kg', remove_rule: 1 }));
    expect(filterOf(h)).toEqual({ packages: ['KG'] });
  });

  it('removes an entry from any list, ignoring case', async () => {
    const h = harness();
    seed(h, { packages: ['KG', 'Other'], excludePackages: ['Spammer'], excludeCategories: ['Cheats'], includeCategories: ['Tools'] });
    await h.run(command('filter', { subscription: 'kg', remove: 'spammer' }));
    await h.run(command('filter', { subscription: 'kg', remove: 'CHEATS' }));
    await h.run(command('filter', { subscription: 'kg', remove: 'other' }));
    expect(filterOf(h)).toEqual({ packages: ['KG'], includeCategories: ['Tools'] });
    await h.run(command('filter', { subscription: 'kg', remove: 'nothing' }));
    expect(h.followUp()).toBe(en.filterEntryNotFound('nothing'));
  });

  it('reports a store that is not configured', async () => {
    const h = harness({ sources: [{ id: 'thunderstore:valheim', store: 'thunderstore', community: 'valheim', enabled: true }] });
    seed(h);
    expect(await h.run(command('filter', { subscription: 'kg', source: 'nexus' }))).toMatchObject({ data: { content: en.sourceNotConfigured('nexus') } });
  });
});

describe('who may edit what', () => {
  it.each(['filter', 'include', 'exclude'])('/%s needs Manage Channel and a subscription of this place', async (name) => {
    const h = harness();
    seed(h);
    const options = { subscription: 'kg', owner: 'X', category: 'C' };
    expect(await h.run(command(name, options, denied))).toMatchObject({ data: { flags: 64 } });
    expect(filterOf(h)).toEqual({ packages: ['KG'] });
    for (const id of ['elsewhere', 'foreign']) {
      await h.run(command(name, { ...options, subscription: id }));
      expect(h.followUp()).toBe(en.subscriptionNotFound);
      expect(filterOf(h, id)).toEqual({ packages: ['KG'] });
    }
  });

  it('finds the subscription by its label and, in a thread, among the thread and its parent', async () => {
    const h = harness();
    seed(h);
    await h.run(inThread({ data: { name: 'include', options: [{ name: 'subscription', type: 3, value: 'kg' }, { name: 'owner', type: 3, value: 'Someone' }] } }));
    expect(filterOf(h).alsoMatch).toEqual([{ packages: ['Someone'] }]);
  });

  it('answers in Russian when the deployment speaks Russian', async () => {
    const h = harness({ messages: ru });
    seed(h);
    await h.run(command('include', { subscription: 'kg', owner: 'Someone' }));
    expect(h.followUp()).toBe(ru.included('KG', ru.filterPackages('Someone')));
  });
});

describe('autocomplete of /filter, /include and /exclude', () => {
  it('suggests the subscriptions here for the subscription option, and owners and mods for the others', async () => {
    const h = harness();
    seed(h);
    await seedMod(h.store, 'Someone', 'Beta');
    expect(await h.run(autocompleteOf('include', 'subscription', ''))).toMatchObject({ data: { choices: [{ name: 'KG', value: 'kg' }] } });
    expect(await h.run(autocompleteOf('include', 'owner', 'So'))).toMatchObject({ data: { choices: [{ name: 'Someone', value: 'Someone' }] } });
    expect(await h.run(autocompleteOf('exclude', 'mod', 'Be'))).toMatchObject({ data: { choices: [{ value: 'Someone-Beta' }] } });
    expect(await h.run(autocompleteOf('filter', 'remove', 'x'))).toMatchObject({ data: { choices: [] } });
  });

  it('returns nothing to a member without Manage Channel', async () => {
    const h = harness();
    seed(h);
    expect(await h.run(autocompleteOf('include', 'subscription', '', denied))).toMatchObject({ data: { choices: [] } });
  });
});
