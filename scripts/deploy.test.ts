// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { buildDeployArgs, collectStoreEmojis } from './deploy.ts';

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
  it('uses the local config when present and passes no variable without emoji', () => {
    expect(buildDeployArgs({ env: {}, hasLocalConfig: true })).toEqual({ ok: true, args: ['deploy', '-c', 'wrangler.local.jsonc'] });
  });

  it('falls back to the default config when there is no local one', () => {
    expect(buildDeployArgs({ env: {}, hasLocalConfig: false })).toEqual({ ok: true, args: ['deploy'] });
  });

  it('passes the emoji as one STORE_EMOJIS variable holding JSON', () => {
    const result = buildDeployArgs({ env: { STORE_EMOJI_THUNDERSTORE: THUNDERSTORE, STORE_EMOJI_HEXIUM: HEXIUM }, hasLocalConfig: true });
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
    const result = buildDeployArgs({ env: { STORE_EMOJI_HEXIUM: 'nope' }, hasLocalConfig: true });
    expect(result.ok).toBe(false);
  });
});
