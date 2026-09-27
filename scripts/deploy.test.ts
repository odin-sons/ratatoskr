// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '../src/i18n/index.ts';
import { buildDeployArgs, collectLanguage, collectRatatoskrEmoji, collectStoreEmojis, isDryRun, requiresConfirmation } from './deploy.ts';

const THUNDERSTORE = '<:thunderstore:123456789012345678>';
const HEXIUM = '<:hexium:223456789012345678>';

describe('collectStoreEmojis', () => {
  it('returns nothing when no emoji variable is set', () => {
    expect(collectStoreEmojis({})).toEqual({ ok: true, emojis: {} });
  });

  it('maps the per-store variables to store keys', () => {
    const result = collectStoreEmojis({ STORE_EMOJI_THUNDERSTORE: THUNDERSTORE, STORE_EMOJI_HEXIUM: HEXIUM });
    expect(result).toEqual({ ok: true, emojis: { thunderstore: THUNDERSTORE, hexium: HEXIUM } });
  });

  it('ignores empty values and trims whitespace', () => {
    const result = collectStoreEmojis({ STORE_EMOJI_THUNDERSTORE: `  ${THUNDERSTORE}  `, STORE_EMOJI_HEXIUM: '', STORE_EMOJI_NEXUS: '   ' });
    expect(result).toEqual({ ok: true, emojis: { thunderstore: THUNDERSTORE } });
  });

  it('accepts animated emoji markup', () => {
    const animated = '<a:party:123456789012345678>';
    expect(collectStoreEmojis({ STORE_EMOJI_NEXUS: animated })).toEqual({ ok: true, emojis: { nexus: animated } });
  });

  it('rejects a value that is not full emoji markup, naming the variable but not the value', () => {
    for (const bad of [':thunderstore:', '<:thunderstore:12>', 'thunderstore', '<:x:123456789012345678>', '<:name:123456789012345678> extra', '<:na me:123456789012345678>']) {
      const result = collectStoreEmojis({ STORE_EMOJI_THUNDERSTORE: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(' ')).toContain('STORE_EMOJI_THUNDERSTORE');
        expect(result.errors.join(' ')).not.toContain(bad);
      }
    }
  });
});

describe('buildDeployArgs', () => {
  it('passes no variable without emoji', () => {
    expect(buildDeployArgs({ env: {} })).toEqual({ ok: true, args: ['deploy'] });
  });

  it('passes the emoji as one STORE_EMOJIS variable holding JSON', () => {
    const result = buildDeployArgs({ env: { STORE_EMOJI_THUNDERSTORE: THUNDERSTORE, STORE_EMOJI_HEXIUM: HEXIUM } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const at = result.args.indexOf('--var');
      expect(at).toBeGreaterThan(-1);
      const value = result.args[at + 1]!;
      expect(value.startsWith('STORE_EMOJIS:')).toBe(true);
      expect(JSON.parse(value.slice('STORE_EMOJIS:'.length))).toEqual({ thunderstore: THUNDERSTORE, hexium: HEXIUM });
    }
  });

  it('refuses to deploy with an invalid emoji value', () => {
    const result = buildDeployArgs({ env: { STORE_EMOJI_HEXIUM: 'nope' } });
    expect(result.ok).toBe(false);
  });
});

describe('isDryRun', () => {
  it('is true only when --dry-run is among the extra args', () => {
    expect(isDryRun(['--dry-run'])).toBe(true);
    expect(isDryRun(['d1', 'execute', '--dry-run'])).toBe(true);
    expect(isDryRun([])).toBe(false);
    expect(isDryRun(['--dry-run-ish'])).toBe(false);
  });
});

describe('requiresConfirmation', () => {
  it('is false in CI (the production environment reviewer already gates it)', () => {
    expect(requiresConfirmation({ CI: 'true' })).toBe(false);
    expect(requiresConfirmation({ GITHUB_ACTIONS: 'true' })).toBe(false);
  });

  it('is true for a plain local invocation', () => {
    expect(requiresConfirmation({})).toBe(true);
    expect(requiresConfirmation({ CI: 'false' })).toBe(true);
  });
});

describe('collectLanguage', () => {
  it('returns nothing when RATATOSKR_LANGUAGE is unset or blank', () => {
    expect(collectLanguage({})).toEqual({ ok: true });
    expect(collectLanguage({ RATATOSKR_LANGUAGE: '' })).toEqual({ ok: true });
    expect(collectLanguage({ RATATOSKR_LANGUAGE: '   ' })).toEqual({ ok: true });
  });

  it('ignores the POSIX locale variable LANGUAGE', () => {
    expect(collectLanguage({ LANGUAGE: 'en_US:en' })).toEqual({ ok: true });
    expect(buildDeployArgs({ env: { LANGUAGE: 'en_US:en' } })).toEqual({ ok: true, args: ['deploy'] });
  });

  it('accepts every catalog language, trimmed and lower-cased', () => {
    for (const language of LANGUAGES) {
      expect(collectLanguage({ RATATOSKR_LANGUAGE: language })).toEqual({ ok: true, language });
    }
    expect(collectLanguage({ RATATOSKR_LANGUAGE: '  RU ' })).toEqual({ ok: true, language: 'ru' });
  });

  it('refuses an unknown language, naming the variable and the choices but not the value', () => {
    for (const bad of ['klingon', 'ru-RU', 'https://evil.example/token', '__proto__']) {
      const result = collectLanguage({ RATATOSKR_LANGUAGE: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const text = result.errors.join(' ');
        expect(text).toContain('RATATOSKR_LANGUAGE');
        expect(text).toContain('en');
        expect(text).toContain('ru');
        expect(text).not.toContain(bad);
      }
    }
  });
});

describe('collectRatatoskrEmoji', () => {
  const RT = '<:ratatoskr:123456789012345681>';

  it('returns nothing when unset or blank', () => {
    expect(collectRatatoskrEmoji({})).toEqual({ ok: true });
    expect(collectRatatoskrEmoji({ RATATOSKR_EMOJI: '  ' })).toEqual({ ok: true });
  });

  it('accepts valid markup, trimmed', () => {
    expect(collectRatatoskrEmoji({ RATATOSKR_EMOJI: ` ${RT} ` })).toEqual({ ok: true, emoji: RT });
    expect(collectRatatoskrEmoji({ RATATOSKR_EMOJI: '<a:squirrel:123456789012345682>' })).toEqual({ ok: true, emoji: '<a:squirrel:123456789012345682>' });
  });

  it('refuses invalid markup, naming the variable but not the value', () => {
    for (const bad of [':ratatoskr:', '🐿️', '<:x:1>', `${RT} extra`]) {
      const result = collectRatatoskrEmoji({ RATATOSKR_EMOJI: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(' ')).toContain('RATATOSKR_EMOJI');
        expect(result.errors.join(' ')).not.toContain(bad);
      }
    }
  });
});

describe('buildDeployArgs with language and source emoji', () => {
  const RT = '<:ratatoskr:123456789012345681>';
  const varsOf = (args: string[]): string[] => args.flatMap((arg, i) => (args[i - 1] === '--var' ? [arg] : []));

  it('passes the language as LANGUAGE and RATATOSKR_EMOJI as separate --var arguments', () => {
    const result = buildDeployArgs({ env: { RATATOSKR_LANGUAGE: 'ru', RATATOSKR_EMOJI: RT } });
    expect(result).toEqual({ ok: true, args: ['deploy', '--var', 'LANGUAGE:ru', '--var', `RATATOSKR_EMOJI:${RT}`] });
  });

  it('passes nothing extra when neither is set', () => {
    expect(buildDeployArgs({ env: {} })).toEqual({ ok: true, args: ['deploy'] });
  });

  it('keeps the store emoji variable next to them', () => {
    const result = buildDeployArgs({ env: { RATATOSKR_LANGUAGE: 'en', STORE_EMOJI_HEXIUM: '<:hexium:223456789012345678>' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(varsOf(result.args).map((v) => v.split(':')[0])).toEqual(['STORE_EMOJIS', 'LANGUAGE']);
  });

  it('refuses to deploy with a bad language or emoji and reports every problem without echoing values', () => {
    const result = buildDeployArgs({ env: { RATATOSKR_LANGUAGE: 'secret-lang', RATATOSKR_EMOJI: 'secret-emoji', STORE_EMOJI_NEXUS: 'secret-store' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = result.errors.join('\n');
      for (const name of ['RATATOSKR_LANGUAGE', 'RATATOSKR_EMOJI', 'STORE_EMOJI_NEXUS']) expect(text).toContain(name);
      expect(text).not.toContain('secret');
    }
  });
});
