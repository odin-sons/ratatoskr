// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SourceCapUsage } from './alerts.ts';
import type { SubrequestBudget } from './budget.ts';
import { USAGE_CHECK_EVERY_NTH_TICK } from './constants.ts';
import type { DailyUsage, Store, UsageReader } from './ports.ts';
import { sanitizeLogText } from './report.ts';
import { DEGRADATION_KEY, degradationLevel, usageCaps } from './usage.ts';

const errorMessage = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

export interface MonitorInput {
  store: Pick<Store, 'getAlertStates' | 'setAlertState'>;
  /** Without a reader (no analytics token) the monitor is off: no degradation, no usage alerts. */
  reader: UsageReader | undefined;
  budget: SubrequestBudget;
  now: Date;
  tickIndex: number;
}

export interface MonitorOutcome {
  /** The degradation step to apply this run, 0 when none. */
  degradation: number;
  /** Limits to raise alerts for; empty on runs that did not read the analytics API. */
  usages: SourceCapUsage[];
}

interface StoredStep {
  /** The step to apply: the stored one when it was written today (UTC), else 0. */
  step: number;
  /** The stored level whatever its age, 0 when nothing is stored. */
  level: number;
  stale: boolean;
}

const utcDate = (iso: string): string => iso.slice(0, 10);

async function readStored(store: Pick<Store, 'getAlertStates'>, reader: UsageReader | undefined, now: Date): Promise<StoredStep> {
  const none: StoredStep = { step: 0, level: 0, stale: false };
  if (reader === undefined) return none;
  try {
    const row = (await store.getAlertStates([DEGRADATION_KEY])).get(DEGRADATION_KEY);
    if (row === undefined) return none;
    const stale = utcDate(row.notifiedAt) !== utcDate(now.toISOString());
    return { step: stale ? 0 : row.level, level: row.level, stale };
  } catch (err) {
    console.warn(`degradation level not read: ${sanitizeLogText(errorMessage(err))}`);
    return none;
  }
}

/** The degradation step to apply now: the one stored today, 0 when the monitor is off or the stored one is from an earlier UTC day. */
export async function readDegradation(store: Pick<Store, 'getAlertStates'>, reader: UsageReader | undefined, now: Date): Promise<number> {
  return (await readStored(store, reader, now)).step;
}

/** Applies the step stored today; every `USAGE_CHECK_EVERY_NTH_TICK`th tick also reads today's usage, stores the step and returns the limits to alert on. Never fails a run. */
export async function runUsageMonitor(input: MonitorInput): Promise<MonitorOutcome> {
  const { store, reader, budget, now, tickIndex } = input;
  const stored = await readStored(store, reader, now);
  if (reader === undefined || tickIndex % USAGE_CHECK_EVERY_NTH_TICK !== 1 || !budget.tryConsume()) return { degradation: stored.step, usages: [] };
  let today: DailyUsage | undefined;
  try {
    today = (await reader.daily(now, 1)).at(-1);
  } catch (err) {
    console.warn(`usage monitor failed: ${sanitizeLogText(errorMessage(err))}`);
  }
  if (today === undefined) return { degradation: stored.step, usages: [] };
  const level = degradationLevel(today);
  if (level !== stored.level || (level > 0 && stored.stale)) {
    try {
      await store.setAlertState(DEGRADATION_KEY, { level, notifiedAt: now.toISOString() });
    } catch (err) {
      console.warn(`degradation level not saved: ${sanitizeLogText(errorMessage(err))}`);
    }
  }
  return { degradation: level, usages: usageCaps(today, now) };
}
