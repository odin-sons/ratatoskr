// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECONCILE_CRON, RECONCILE_HOURS_UTC, TICK_CRON, reconcileIndexAt } from './crons.ts';

const ROOT = join(import.meta.dirname, '../..');
const CONFIG = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');

/** Extracts `triggers.crons` from wrangler.jsonc without a full JSONC parser: no other array in the file is shaped like this one. */
function configuredCrons(text: string): string[] {
  const match = /"crons":\s*\[([^\]]*)\]/.exec(text);
  if (match === null) throw new Error('wrangler.jsonc: triggers.crons not found');
  return [...match[1]!.matchAll(/"([^"]*)"/g)].map((quoted) => quoted[1]!);
}

describe('cron schedule', () => {
  it('src/cloudflare/crons.ts matches the deployed schedule in wrangler.jsonc', () => {
    expect(configuredCrons(CONFIG)).toEqual([TICK_CRON, RECONCILE_CRON]);
  });

  it('lists the reconcile hours the cron expression fires at', () => {
    const hours = RECONCILE_CRON.split(' ')[1]!.split(',').map(Number);
    expect(hours).toEqual([...RECONCILE_HOURS_UTC]);
  });

  it('maps each reconcile hour to its index and anything else to -1', () => {
    const at = (hour: number, minute = 1) => Date.UTC(2026, 9, 4, hour, minute);
    expect(RECONCILE_HOURS_UTC.map((hour) => reconcileIndexAt(at(hour)))).toEqual([0, 1, 2]);
    expect([0, 2, 6, 12, 23].map((hour) => reconcileIndexAt(at(hour)))).toEqual([-1, -1, -1, -1, -1]);
    expect(reconcileIndexAt(at(4, 59))).toBe(1);
  });
});
