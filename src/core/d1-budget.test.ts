// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { HEXIUM_INDEX_MAX_LINES } from '../sources/budget.ts';
import {
  AUTOCOMPLETE_MAX_RESULTS,
  AUTOCOMPLETE_MIN_PREFIX,
  AUTOCOMPLETE_OWNER_SCAN_LIMIT,
  CADENCE,
  D1_FREE,
  MAX_SUBSCRIPTIONS_PER_GUILD,
  MS_PER_DAY,
  TICK_BUDGET,
} from './constants.ts';

const TICKS_PER_DAY = MS_PER_DAY / (CADENCE.tickMinutes * 60_000);

const schema = new DatabaseSync(':memory:');
schema.exec(readFileSync(join(import.meta.dirname, '../../schema.sql'), 'utf8'));

/** Rows D1 counts as written for one insert or delete: the table row plus one entry per index, primary key autoindex included. */
function writesPerRow(table: string): number {
  return 1 + (schema.prepare(`SELECT COUNT(*) AS n FROM pragma_index_list('${table}')`).get() as { n: number }).n;
}

describe('worst-case D1 usage per day, from the cadence constants', () => {
  it('reading every known Hexium package per index scan and reconcile stays within a tenth of the daily row-read limit', () => {
    const readsPerDay = TICKS_PER_DAY / CADENCE.hexiumIndexEveryNthTick + CADENCE.reconcileRunsPerDay;
    expect(readsPerDay * HEXIUM_INDEX_MAX_LINES).toBeLessThanOrEqual(D1_FREE.rowsReadPerDay / 10);
  });
});

describe('worst-case D1 reads of autocomplete', () => {
  const KEYSTROKES_PER_DAY = 1_000;
  const NAME_SEARCH_READS = AUTOCOMPLETE_MAX_RESULTS * 2;
  const OWNER_SEARCH_READS = AUTOCOMPLETE_OWNER_SCAN_LIMIT;
  const worstRequestReads = Math.max(NAME_SEARCH_READS, OWNER_SEARCH_READS);

  it('is bounded per request by the result cap and the owner scan limit, whatever the prefix matches', () => {
    expect(AUTOCOMPLETE_MIN_PREFIX).toBeGreaterThanOrEqual(2);
    expect(worstRequestReads).toBe(300);
  });

  it('keeps a thousand keystrokes a day within a tenth of the daily row-read limit', () => {
    expect(worstRequestReads * KEYSTROKES_PER_DAY).toBeLessThanOrEqual(D1_FREE.rowsReadPerDay / 10);
  });
});

describe('worst-case D1 writes of the bot tables', () => {
  const SENDS_PER_DAY = TICKS_PER_DAY * TICK_BUDGET.maxDiscordSends;
  // Measured 2026-10-02, docs/spec.md "Volume".
  const MEASURED_WRITES_PER_DAY = 9_000;
  // Assumption: one upsert per event of the 800 events a day in docs/spec.md "Volume".
  const PACKAGE_UPSERTS_PER_DAY = 800;
  // Assumption: no measurement exists yet.
  const SUBSCRIPTION_EDITS_PER_DAY = 500;

  const messageWrites = SENDS_PER_DAY * writesPerRow('messages') * 2;
  const NEW_MODS_PER_DAY = 50;
  const GUILDS_IN_SPEC_VOLUME = 2;
  const THREAD_CHANNELS = GUILDS_IN_SPEC_VOLUME * MAX_SUBSCRIPTIONS_PER_GUILD;
  const threadsPerDay = Math.min(SENDS_PER_DAY, NEW_MODS_PER_DAY * THREAD_CHANNELS);
  const threadWrites = threadsPerDay * writesPerRow('mod_threads');
  const packageIndexWrites = PACKAGE_UPSERTS_PER_DAY * (writesPerRow('packages') - 2);
  const subscriptionWrites = SUBSCRIPTION_EDITS_PER_DAY * writesPerRow('subscriptions');

  it('counts the indexes the schema really has', () => {
    expect(writesPerRow('messages')).toBe(3);
    expect(writesPerRow('mod_threads')).toBe(3);
    expect(writesPerRow('packages')).toBe(4);
  });

  it('each send writes one message record and the purge deletes it again', () => {
    expect(messageWrites).toBe(SENDS_PER_DAY * 6);
    expect(messageWrites).toBeLessThanOrEqual(D1_FREE.rowsWrittenPerDay / 2);
  });

  it('a thread per new mod and thread channel stays within a sixth of the daily row-write limit', () => {
    expect(threadsPerDay).toBe(5_000);
    expect(threadWrites).toBeLessThanOrEqual(D1_FREE.rowsWrittenPerDay / 6);
  });

  it('the two package indexes, the messages, the threads and the subscription edits on top of the measured writes stay within the limit', () => {
    const total = MEASURED_WRITES_PER_DAY + packageIndexWrites + messageWrites + threadWrites + subscriptionWrites;
    expect(total).toBeLessThanOrEqual(D1_FREE.rowsWrittenPerDay);
  });
});
