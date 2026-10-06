// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { makeEvent } from '../testing/fakes.ts';
import { ALSO_MATCH_MAX_RULES } from './constants.ts';
import { addRule, compileFilter, describeBaseAcceptsEverything, parseFilter, removeRule } from './filter.ts';
import type { FilterRule, ModEvent, SubscriptionFilter } from './types.ts';

const mod = (owner: string, name: string, over: Partial<ModEvent['pkg']> = {}, kind: 'new' | 'update' = 'new'): ModEvent =>
  makeEvent({ kind, versionFrom: kind === 'update' ? '1.0.0' : null, versionTo: '2.0.0', pkg: { owner, name, packageId: `${owner}-${name}`, ...over } });

const accepts = (filter: SubscriptionFilter, event: ModEvent): boolean => compileFilter(filter).matches(event);

const kg = mod('KG', 'Alpha');
const other = mod('Someone', 'Beta');
const tools = mod('Third', 'Gamma', { categories: ['Tools'] });

describe('alsoMatch', () => {
  const base: SubscriptionFilter = { packages: ['KG'] };

  it('widens a base rule by a package, by an author and by a category', () => {
    expect(accepts(base, other)).toBe(false);
    expect(accepts({ ...base, alsoMatch: [{ packages: ['Someone-Beta'] }] }, other)).toBe(true);
    expect(accepts({ ...base, alsoMatch: [{ packages: ['Someone'] }] }, other)).toBe(true);
    expect(accepts({ ...base, alsoMatch: [{ includeCategories: ['tools'] }] }, tools)).toBe(true);
    expect(accepts({ ...base, alsoMatch: [{ includeCategories: ['Tools'] }] }, other)).toBe(false);
  });

  it('keeps accepting what the base rule accepts', () => {
    expect(accepts({ ...base, alsoMatch: [{ packages: ['Someone'] }] }, kg)).toBe(true);
  });

  it('ANDs the fields inside one rule', () => {
    const rule: FilterRule = { sources: ['hexium:valheim'], includeCategories: ['Tools'] };
    expect(accepts({ ...base, alsoMatch: [rule] }, tools)).toBe(false);
    const hexium = mod('Third', 'Gamma', { categories: ['Tools'], source: 'hexium:valheim' });
    expect(accepts({ ...base, alsoMatch: [rule] }, hexium)).toBe(true);
  });

  it('a category rule never matches a package that reports no category', () => {
    expect(accepts({ ...base, alsoMatch: [{ includeCategories: ['Tools'] }] }, mod('Third', 'Gamma', { categories: [] }))).toBe(false);
  });

  it('lets an exclusion win over every rule', () => {
    const filter: SubscriptionFilter = { ...base, excludePackages: ['Someone-Beta'], alsoMatch: [{ packages: ['Someone'] }] };
    expect(accepts(filter, other)).toBe(false);
    expect(accepts(filter, mod('Someone', 'Delta'))).toBe(true);
    expect(accepts({ ...base, excludeCategories: ['Tools'], alsoMatch: [{ packages: ['Third'] }] }, tools)).toBe(false);
  });

  it('applies the global keys to a rule match', () => {
    const nsfw = mod('Someone', 'Beta', { isNsfw: true });
    expect(accepts({ ...base, alsoMatch: [{ packages: ['Someone'] }] }, nsfw)).toBe(false);
    expect(accepts({ ...base, allowNsfw: true, alsoMatch: [{ packages: ['Someone'] }] }, nsfw)).toBe(true);
    expect(accepts({ ...base, kinds: ['update'], alsoMatch: [{ packages: ['Someone'] }] }, other)).toBe(false);
    expect(accepts({ ...base, kinds: ['update'], alsoMatch: [{ packages: ['Someone'] }] }, mod('Someone', 'Beta', {}, 'update'))).toBe(true);
    const deprecated = mod('Someone', 'Beta', { isDeprecated: true }, 'update');
    expect(accepts({ ...base, alsoMatch: [{ packages: ['Someone'] }] }, deprecated)).toBe(false);
  });

  it('behaves exactly as before for a filter without alsoMatch', () => {
    expect(accepts({}, other)).toBe(true);
    expect(accepts({ packages: ['KG'] }, other)).toBe(false);
    expect(accepts({ alsoMatch: [] , packages: ['KG'] }, other)).toBe(false);
  });
});

describe('parseFilter and alsoMatch', () => {
  it('keeps valid rules and drops unknown keys inside a rule', () => {
    const parsed = parseFilter({ alsoMatch: [{ packages: ['A'], bogus: 1 }, { includeCategories: ['Tools'] }] });
    expect(parsed).toEqual({ alsoMatch: [{ packages: ['A'] }, { includeCategories: ['Tools'] }] });
  });

  it.each([
    ['not an array', { alsoMatch: {} }],
    ['a rule that is not an object', { alsoMatch: ['A'] }],
    ['a rule with a wrong type', { alsoMatch: [{ packages: 'A' }] }],
    ['an empty rule', { alsoMatch: [{}] }],
    ['a rule of empty lists', { alsoMatch: [{ packages: [] }] }],
    ['too many rules', { alsoMatch: Array.from({ length: ALSO_MATCH_MAX_RULES + 1 }, (_, i) => ({ packages: [`A${i}`] })) }],
  ])('rejects %s', (_label, input) => {
    expect(parseFilter(input)).toBeNull();
  });

  it('accepts exactly the maximum number of rules', () => {
    const rules = Array.from({ length: ALSO_MATCH_MAX_RULES }, (_, i) => ({ packages: [`A${i}`] }));
    expect(parseFilter({ alsoMatch: rules })?.alsoMatch).toHaveLength(ALSO_MATCH_MAX_RULES);
  });
});

describe('rule helpers', () => {
  it('knows when the base rule already accepts everything', () => {
    expect(describeBaseAcceptsEverything({})).toBe(true);
    expect(describeBaseAcceptsEverything({ kinds: ['new'], excludePackages: ['A'], allowNsfw: true, watchlist: ['A'] })).toBe(true);
    expect(describeBaseAcceptsEverything({ packages: ['KG'] })).toBe(false);
    expect(describeBaseAcceptsEverything({ sources: ['thunderstore:valheim'] })).toBe(false);
    expect(describeBaseAcceptsEverything({ includeCategories: ['Tools'] })).toBe(false);
  });

  it('adds a rule without changing the input and enforces the cap', () => {
    const filter: SubscriptionFilter = { packages: ['KG'] };
    const added = addRule(filter, { packages: ['A'] });
    expect(added).toEqual({ packages: ['KG'], alsoMatch: [{ packages: ['A'] }] });
    expect(filter).toEqual({ packages: ['KG'] });
    let full: SubscriptionFilter = filter;
    for (let i = 0; i < ALSO_MATCH_MAX_RULES; i += 1) full = addRule(full, { packages: [`A${i}`] }) ?? full;
    expect(addRule(full, { packages: ['one-too-many'] })).toBeNull();
  });

  it('refuses to add an empty rule and ignores a duplicate', () => {
    expect(addRule({ packages: ['KG'] }, {})).toBeNull();
    const once = addRule({ packages: ['KG'] }, { packages: ['A'] })!;
    expect(addRule(once, { packages: ['a'] })).toEqual(once);
  });

  it('removes a rule by index and drops the key with the last one', () => {
    const filter: SubscriptionFilter = { packages: ['KG'], alsoMatch: [{ packages: ['A'] }, { packages: ['B'] }] };
    expect(removeRule(filter, 0)).toEqual({ packages: ['KG'], alsoMatch: [{ packages: ['B'] }] });
    expect(removeRule(removeRule(filter, 0)!, 0)).toEqual({ packages: ['KG'] });
    expect(removeRule(filter, 5)).toBeNull();
    expect(filter.alsoMatch).toHaveLength(2);
  });
});

describe('alsoMatch cost', () => {
  it('matches many events against the maximum number of rules well inside the CPU budget', () => {
    const rules = Array.from({ length: ALSO_MATCH_MAX_RULES }, (_, i) => ({ packages: [`Nobody${i}`], includeCategories: ['Tools'] }));
    const compiled = compileFilter({ packages: ['KG'], alsoMatch: rules });
    const events = Array.from({ length: 2_000 }, (_, i) => mod('Owner', `Mod${i}`, { categories: ['Tools', 'Misc'] }));
    const start = performance.now();
    let hits = 0;
    for (const event of events) if (compiled.matches(event)) hits += 1;
    expect(hits).toBe(0);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
