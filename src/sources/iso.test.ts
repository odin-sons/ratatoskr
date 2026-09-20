// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { clampToNow, epochSecondsToIso, maxIso, normalizeIso } from './iso.ts';

describe('normalizeIso', () => {
  it('pads and truncates the fraction to six digits in UTC', () => {
    expect(normalizeIso('2026-09-18T23:58:52.6512Z')).toBe('2026-09-18T23:58:52.651200Z');
    expect(normalizeIso('2026-09-18T23:58:52Z')).toBe('2026-09-18T23:58:52.000000Z');
    expect(normalizeIso('2026-09-18T23:58:52.1234567Z')).toBe('2026-09-18T23:58:52.123456Z');
  });

  it('accepts +00:00, +0000 and a missing zone as UTC', () => {
    expect(normalizeIso('2021-02-14T18:07:34.498403+00:00')).toBe('2021-02-14T18:07:34.498403Z');
    expect(normalizeIso('2021-02-14T18:07:34+0000')).toBe('2021-02-14T18:07:34.000000Z');
    expect(normalizeIso('2021-02-14 18:07:34')).toBe('2021-02-14T18:07:34.000000Z');
  });

  it('converts other offsets to UTC', () => {
    expect(normalizeIso('2026-09-18T12:00:00+02:00')).toBe('2026-09-18T10:00:00.000000Z');
    expect(normalizeIso('2026-09-18T12:00:00-0130')).toBe('2026-09-18T13:30:00.000000Z');
  });

  it('rejects garbage', () => {
    expect(normalizeIso('yesterday')).toBeNull();
    expect(normalizeIso('2026-13-45T99:00:00Z')).toBeNull();
    expect(normalizeIso('')).toBeNull();
  });
});

describe('epochSecondsToIso / maxIso', () => {
  it('formats epoch seconds canonically', () => {
    expect(epochSecondsToIso(1_789_776_053)).toBe('2026-09-19T00:00:53.000000Z');
  });

  it('rejects epoch seconds outside the representable canonical range', () => {
    for (const bad of [1e20, -1, Number.NaN, Number.POSITIVE_INFINITY, 253_402_300_800, Number.MAX_SAFE_INTEGER]) {
      expect(epochSecondsToIso(bad), String(bad)).toBeNull();
    }
    expect(epochSecondsToIso(0)).toBe('1970-01-01T00:00:00.000000Z');
    expect(epochSecondsToIso(253_402_300_799)).toBe('9999-12-31T23:59:59.000000Z');
  });

  it('cuts a cursor beyond now plus one hour back to now and leaves the rest alone', () => {
    const now = new Date('2026-09-19T12:00:00Z');
    expect(clampToNow('2099-01-01T00:00:00.000000Z', now)).toBe('2026-09-19T12:00:00.000000Z');
    expect(clampToNow('2026-09-19T13:00:00.000001Z', now)).toBe('2026-09-19T12:00:00.000000Z');
    expect(clampToNow('2026-09-19T13:00:00.000000Z', now)).toBe('2026-09-19T13:00:00.000000Z');
    expect(clampToNow('2020-01-01T00:00:00.000000Z', now)).toBe('2020-01-01T00:00:00.000000Z');
  });

  it('picks the later value and tolerates nulls', () => {
    expect(maxIso(null, null)).toBeNull();
    expect(maxIso('2026-01-01T00:00:00.000000Z', null)).toBe('2026-01-01T00:00:00.000000Z');
    expect(maxIso('2026-01-01T00:00:00.000000Z', '2026-02-01T00:00:00.000000Z')).toBe('2026-02-01T00:00:00.000000Z');
  });
});
