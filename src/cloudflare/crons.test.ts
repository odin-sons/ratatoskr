// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECONCILE_CRONS, TICK_CRON } from './crons.ts';

const ROOT = join(import.meta.dirname, '../..');
const CONFIG = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');

/** Extracts `triggers.crons` from wrangler.jsonc without a full JSONC parser: no other array in the file is shaped like this one. */
function configuredCrons(text: string): string[] {
  const match = /"crons":\s*\[([^\]]*)\]/.exec(text);
  if (match === null) throw new Error('wrangler.jsonc: triggers.crons not found');
  return match[1]!
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter((s) => s !== '');
}

describe('cron schedule', () => {
  it('src/cloudflare/crons.ts matches the deployed schedule in wrangler.jsonc', () => {
    expect(configuredCrons(CONFIG)).toEqual([TICK_CRON, ...RECONCILE_CRONS]);
  });
});
