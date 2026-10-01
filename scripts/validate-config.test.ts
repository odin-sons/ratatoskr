// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateConfig, validateSubscription, validateSubscriptionFilter } from './validate-config.ts';

const UA = 'ratatoskr/1.0.2 (+https://github.com/odin-sons/ratatoskr; unofficial mod notifier)';

function config(overrides: Record<string, unknown> = {}) {
  return {
    userAgent: UA,
    sources: [
      { id: 'thunderstore:valheim', store: 'thunderstore', community: 'valheim', enabled: true },
      { id: 'nexus:valheim', store: 'nexus', community: 'valheim', enabled: false },
    ],
    ...overrides,
  };
}

function errorsOf(raw: unknown): string[] {
  const r = validateConfig(raw);
  if (r.ok) throw new Error('expected validation failure');
  return r.errors;
}

describe('validateConfig', () => {
  it('accepts the shipped config file', () => {
    const raw = JSON.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ratatoskr.config.json'), 'utf8'),
    ) as unknown;
    const r = validateConfig(raw);
    expect(r.ok).toBe(true);
    // This operator's instance enables Nexus with a personal key; that is the only warning validateConfig ever raises.
    if (r.ok) for (const w of r.warnings) expect(w).toMatch(/nexus.*personal API key/i);
  });

  it('rejects non-objects', () => {
    expect(errorsOf(null)).toHaveLength(1);
    expect(errorsOf([])).toHaveLength(1);
  });

  it('rejects an empty or repo-less user agent', () => {
    expect(errorsOf(config({ userAgent: '  ' }))[0]).toMatch(/userAgent/);
    expect(errorsOf(config({ userAgent: 'ratatoskr/1.0.2' }))[0]).toMatch(/repository URL/);
  });

  it('rejects duplicate source ids', () => {
    const dup = { id: 'hexium:valheim', store: 'hexium', community: 'valheim', enabled: true };
    expect(errorsOf(config({ sources: [dup, dup] })).join('\n')).toMatch(/duplicate/);
  });

  it('rejects an id that disagrees with store and community', () => {
    const bad = { id: 'hexium:other', store: 'hexium', community: 'valheim', enabled: true };
    expect(errorsOf(config({ sources: [bad] })).join('\n')).toMatch(/must be "hexium:valheim"/);
  });

  it('rejects unknown stores, bad communities and non-boolean enabled', () => {
    const errors = errorsOf(
      config({
        sources: [{ id: 'x:y', store: 'steam', community: 'Valheim!', enabled: 'yes' }],
      }),
    ).join('\n');
    expect(errors).toMatch(/store: must be one of/);
    expect(errors).toMatch(/community/);
    expect(errors).toMatch(/enabled: must be a boolean/);
  });

  it('rejects unknown keys', () => {
    expect(errorsOf(config({ extra: 1 })).join('\n')).toMatch(/unknown key "extra"/);
  });

  it('warns loudly, without failing, when Nexus is enabled', () => {
    const r = validateConfig(
      config({
        sources: [{ id: 'nexus:valheim', store: 'nexus', community: 'valheim', enabled: true }],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join('\n')).toMatch(/docs\/legal\.md/);
  });
});

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abc_DEF-123';

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    guildId: '123456789012345678',
    webhookUrl: WEBHOOK,
    filter: {},
    mode: 'digest',
    digestIntervalMin: 30,
    ...overrides,
  };
}

function subErrors(raw: unknown): string[] {
  const r = validateSubscription(raw);
  if (r.ok) throw new Error('expected validation failure');
  return r.errors;
}

describe('validateSubscription', () => {
  it('accepts a valid subscription and defaults enabled to true', () => {
    const r = validateSubscription(subscription());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.subscription.enabled).toBe(true);
  });

  it('accepts a full filter', () => {
    const r = validateSubscription(
      subscription({
        filter: {
          sources: ['thunderstore:valheim'],
          kinds: ['new'],
          allowNsfw: true,
          watchlist: ['Owner-Name', 'SomeAuthor'],
          packages: ['Owner-Name', 'SomeAuthor'],
          excludePackages: ['Noisy-Mod'],
          includeCategories: ['Tools'],
          excludeCategories: ['Cosmetics'],
          dedupAcrossStores: false,
          includeChangelog: false,
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('rejects includeChangelog of the wrong type', () => {
    const r = validateSubscription(subscription({ filter: { includeChangelog: 'no' } }));
    expect(r.ok).toBe(false);
  });

  it('keeps the package allowlist and exclusion in the validated subscription', () => {
    const r = validateSubscription(subscription({ filter: { packages: ['A-B'], excludePackages: ['C'] } }));
    expect(r.ok && r.subscription.filter).toEqual({ packages: ['A-B'], excludePackages: ['C'] });
  });

  it.each(['sub-1', 'a', 'Channel_2', 'x'.repeat(64), '3f2b8c1e-9d4a-4e7b-8a55-0c1d2e3f4a5b'])('accepts subscription id %s', (id) => {
    expect(validateSubscription(subscription({ id })).ok).toBe(true);
  });

  it.each(['', ' ', 'a b', "a'b", 'a;b', 'a"b', 'x'.repeat(65), 'a\nb', 'ä', 5, undefined])('rejects subscription id %j', (id) => {
    expect(subErrors(subscription({ id })).join('\n')).toMatch(/^id:/m);
  });

  it('accepts discordapp.com webhooks', () => {
    const url = 'https://discordapp.com/api/webhooks/1/x';
    expect(validateSubscription(subscription({ webhookUrl: url })).ok).toBe(true);
  });

  it.each([
    'http://discord.com/api/webhooks/1/x',
    'https://discord.com/api/webhooks/abc/x',
    'https://discord.com/api/webhooks/1/',
    'https://evil.example/api/webhooks/1/x',
    'https://discord.com.evil.example/api/webhooks/1/x',
    'https://discord.com/api/webhooks/1/x?wait=true',
    'https://discord.com/api/webhooks/1/x y',
    'https://discord.com/api/webhooks/1/x?thread_id=123',
    'https://discord.com/api/webhooks/1/x?thread_id=abc',
    'https://discord.com/api/webhooks/1/x?thread_id=222233334444555566&extra=1',
    'https://discord.com/api/webhooks/1/x?thread_id=',
  ])('rejects webhook %s', (url) => {
    expect(subErrors(subscription({ webhookUrl: url })).join('\n')).toMatch(/webhookUrl/);
  });

  it('defaults threadId to null, delivering to the webhook\'s own channel', () => {
    const r = validateSubscription(subscription());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.subscription.threadId).toBeNull();
  });

  it('accepts a thread id and keeps the webhook URL untouched', () => {
    const r = validateSubscription(subscription({ threadId: '222233334444555566' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.subscription.threadId).toBe('222233334444555566');
      expect(r.subscription.webhookUrl).toBe(WEBHOOK);
    }
  });

  it.each(['', '123', 'abc', '1'.repeat(21), 5, true])('rejects thread id %j', (threadId) => {
    expect(subErrors(subscription({ threadId })).join('\n')).toMatch(/threadId/);
  });

  it('rejects non-numeric guild ids', () => {
    expect(subErrors(subscription({ guildId: 'guild' })).join('\n')).toMatch(/guildId/);
    // eslint-disable-next-line no-loss-of-precision -- type check only, exact digits don't matter
    expect(subErrors(subscription({ guildId: 123456789012345678 })).join('\n')).toMatch(/guildId/);
  });

  it('rejects unknown modes', () => {
    expect(subErrors(subscription({ mode: 'hourly' })).join('\n')).toMatch(/mode/);
  });

  it.each([4, 1441, 30.5, '30', NaN, undefined])('rejects digestIntervalMin %s', (v) => {
    expect(subErrors(subscription({ digestIntervalMin: v })).join('\n')).toMatch(/digestIntervalMin/);
  });

  it.each([5, 1440])('accepts digestIntervalMin %s', (v) => {
    expect(validateSubscription(subscription({ digestIntervalMin: v })).ok).toBe(true);
  });

  it('rejects malformed filters', () => {
    const errors = subErrors(
      subscription({
        filter: {
          kinds: ['delete'],
          allowNsfw: 'true',
          watchlist: [1],
          sources: ['nope'],
          packages: 'Owner-Name',
          excludePackages: [1, ''],
          bogus: true,
        },
      }),
    ).join('\n');
    expect(errors).toMatch(/filter\.kinds\[0\]/);
    expect(errors).toMatch(/filter\.allowNsfw/);
    expect(errors).toMatch(/filter\.watchlist\[0\]/);
    expect(errors).toMatch(/filter\.sources\[0\]/);
    expect(errors).toMatch(/filter\.packages/);
    expect(errors).toMatch(/filter\.excludePackages\[0\]/);
    expect(errors).toMatch(/filter\.excludePackages\[1\]/);
    expect(errors).toMatch(/unknown key "bogus"/);
  });

  it.each(['a\nb', 'x'.repeat(129), ' lead'])('rejects a package entry %j', (entry) => {
    expect(subErrors(subscription({ filter: { packages: [entry] } })).join('\n')).toMatch(/filter\.packages\[0\]/);
    expect(subErrors(subscription({ filter: { excludePackages: [entry] } })).join('\n')).toMatch(/filter\.excludePackages\[0\]/);
  });

  it('rejects a non-object filter', () => {
    expect(subErrors(subscription({ filter: [] })).join('\n')).toMatch(/filter/);
  });
});

describe('validateSubscriptionFilter', () => {
  it('returns the narrowed filter', () => {
    const r = validateSubscriptionFilter({ packages: ['A-B'], kinds: ['update'] });
    expect(r).toEqual({ ok: true, filter: { kinds: ['update'], packages: ['A-B'] } });
  });

  it('reports every problem and never a filter', () => {
    const r = validateSubscriptionFilter({ packages: [1], bogus: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join('\n')).toMatch(/filter\.packages\[0\]/);
      expect(r.errors.join('\n')).toMatch(/unknown key "bogus"/);
    }
  });

  it.each([null, [], 'x', 5])('rejects the non-object %j', (raw) => {
    expect(validateSubscriptionFilter(raw).ok).toBe(false);
  });
});
