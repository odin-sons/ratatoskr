// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateConfig, validateSubscription } from './validate-config.ts';

const UA = 'ratatoskr/0.1.0 (+https://github.com/odin-sons/ratatoskr; unofficial mod notifier)';

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
    if (r.ok) expect(r.warnings).toEqual([]);
  });

  it('rejects non-objects', () => {
    expect(errorsOf(null)).toHaveLength(1);
    expect(errorsOf([])).toHaveLength(1);
  });

  it('rejects an empty or repo-less user agent', () => {
    expect(errorsOf(config({ userAgent: '  ' }))[0]).toMatch(/userAgent/);
    expect(errorsOf(config({ userAgent: 'ratatoskr/0.1.0' }))[0]).toMatch(/repository URL/);
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
          includeCategories: ['Tools'],
          excludeCategories: ['Cosmetics'],
          dedupAcrossStores: false,
        },
      }),
    );
    expect(r.ok).toBe(true);
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
  ])('rejects webhook %s', (url) => {
    expect(subErrors(subscription({ webhookUrl: url })).join('\n')).toMatch(/webhookUrl/);
  });

  it('rejects non-numeric guild ids', () => {
    expect(subErrors(subscription({ guildId: 'guild' })).join('\n')).toMatch(/guildId/);
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
          bogus: true,
        },
      }),
    ).join('\n');
    expect(errors).toMatch(/filter\.kinds\[0\]/);
    expect(errors).toMatch(/filter\.allowNsfw/);
    expect(errors).toMatch(/filter\.watchlist\[0\]/);
    expect(errors).toMatch(/filter\.sources\[0\]/);
    expect(errors).toMatch(/unknown key "bogus"/);
  });

  it('rejects a non-object filter', () => {
    expect(subErrors(subscription({ filter: [] })).join('\n')).toMatch(/filter/);
  });
});
