// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DISCORD } from './constants.ts';
import { infoButtonId, parseInfoButtonId } from './info-button.ts';

const SOURCES = ['thunderstore:valheim', 'hexium:valheim'];

describe('infoButtonId', () => {
  it('joins the source and the package id behind the info prefix', () => {
    expect(infoButtonId('thunderstore:valheim', 'Owner-Name')).toBe('info:thunderstore:valheim:Owner-Name');
  });

  it('fits exactly 100 characters and gives nothing for 101', () => {
    const head = 'info:thunderstore:valheim:';
    expect(infoButtonId('thunderstore:valheim', 'x'.repeat(DISCORD.customIdMax - head.length))).toHaveLength(DISCORD.customIdMax);
    expect(infoButtonId('thunderstore:valheim', 'x'.repeat(DISCORD.customIdMax - head.length + 1))).toBeNull();
  });
});

describe('parseInfoButtonId', () => {
  it('reads back what infoButtonId wrote, for a source that holds a colon', () => {
    const id = infoButtonId('thunderstore:valheim', 'Owner-Name')!;
    expect(parseInfoButtonId(id, SOURCES)).toEqual({ source: 'thunderstore:valheim', packageId: 'Owner-Name' });
  });

  it('keeps a package id that holds colons', () => {
    expect(parseInfoButtonId('info:hexium:valheim:a:b:c', SOURCES)).toEqual({ source: 'hexium:valheim', packageId: 'a:b:c' });
  });

  it.each(['', 'info', 'info:', 'info:thunderstore:valheim', 'info:thunderstore:valheim:', 'info:nexus:valheim:1', 'list:0:1', 'xinfo:hexium:valheim:a'])('rejects %j', (id) => {
    expect(parseInfoButtonId(id, SOURCES)).toBeNull();
  });
});
