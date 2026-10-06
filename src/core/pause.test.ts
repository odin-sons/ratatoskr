// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { PAUSE_MAX_SECONDS, PAUSE_MIN_SECONDS, parsePauseDuration } from './pause.ts';

describe('parsePauseDuration', () => {
  it.each([
    ['30m', 1_800],
    ['2h', 7_200],
    ['3d', 259_200],
    [' 2H ', 7_200],
    ['1m', PAUSE_MIN_SECONDS],
    ['90d', PAUSE_MAX_SECONDS],
    ['2160h', PAUSE_MAX_SECONDS],
    ['007m', 420],
  ])('accepts %s', (text, seconds) => {
    expect(parsePauseDuration(text)).toBe(seconds);
  });

  it.each(['', '0m', '91d', '2161h', '129601m', '1.5h', '-2h', '2', 'h', '2 h', '2w', '2hh', '2h30m', '1e3m', '+2h', '9999999d'])('rejects %j', (text) => {
    expect(parsePauseDuration(text)).toBeNull();
  });

  it('never throws on arbitrary text', () => {
    for (const text of ['\u0000', 'NaN', 'Infinity', `${'9'.repeat(5_000)}d`, '__proto__']) expect(parsePauseDuration(text)).toBeNull();
  });
});
