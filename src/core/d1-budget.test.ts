// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { HEXIUM_INDEX_MAX_LINES } from '../sources/budget.ts';
import { CADENCE, D1_FREE, MS_PER_DAY } from './constants.ts';

const TICKS_PER_DAY = MS_PER_DAY / (CADENCE.tickMinutes * 60_000);

describe('worst-case D1 usage per day, from the cadence constants', () => {
  it('reading every known Hexium package per index scan and reconcile stays within a tenth of the daily row-read limit', () => {
    const readsPerDay = TICKS_PER_DAY / CADENCE.hexiumIndexEveryNthTick + CADENCE.reconcileRunsPerDay;
    expect(readsPerDay * HEXIUM_INDEX_MAX_LINES).toBeLessThanOrEqual(D1_FREE.rowsReadPerDay / 10);
  });
});
