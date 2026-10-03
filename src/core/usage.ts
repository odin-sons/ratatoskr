// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SourceCapUsage } from './alerts.ts';
import {
  D1_FREE,
  DEGRADATION_THRESHOLDS,
  MS_PER_DAY,
  PROJECTION_ALERT_THRESHOLDS,
  PROJECTION_MIN_ELAPSED_MS,
  USAGE_ALERT_THRESHOLDS,
} from './constants.ts';
import type { DailyUsage } from './ports.ts';
import type { CapUsage } from './types.ts';

/** The source id D1 usage alerts are filed under. */
export const USAGE_SOURCE = 'd1';

/** `alert_state` key holding the current degradation step. */
export const DEGRADATION_KEY = 'd1:degradation';

const [STEP_1, STEP_2, STEP_3] = DEGRADATION_THRESHOLDS.map((share) => `${Math.round(share * 100)} %`);
const LIMIT_CONSEQUENCE = `Past the limit D1 rejects queries until 00:00 UTC. From ${STEP_1} the bot pauses reconcile and changelog fetches, from ${STEP_2} it scans the Hexium index less often, from ${STEP_3} it stops that scan.`;
const SIZE_CONSEQUENCE = 'A full database rejects writes until rows are deleted.';
const PROJECTION_CONSEQUENCE = 'At this pace the daily limit is reached before 00:00 UTC.';

const startOfDay = (day: DailyUsage): number => Date.parse(`${day.date}T00:00:00.000Z`);

function cap(id: string, label: string, unit: string, limit: number, value: number, constant: string, consequence: string, thresholds: readonly number[], exceedable = false): CapUsage {
  return { id, label, unit, limit, value, exceeded: exceedable && value >= limit, consequence, constant, thresholds };
}

/** Every limit the usage monitor alerts on, for today's usage `day` read at `now`. */
export function usageCaps(day: DailyUsage, now: Date): SourceCapUsage[] {
  const caps: CapUsage[] = [
    cap('rows-read', 'D1 rows read today', 'rows', D1_FREE.rowsReadPerDay, day.rowsRead, 'D1_FREE.rowsReadPerDay', LIMIT_CONSEQUENCE, USAGE_ALERT_THRESHOLDS),
    cap('rows-written', 'D1 rows written today', 'rows', D1_FREE.rowsWrittenPerDay, day.rowsWritten, 'D1_FREE.rowsWrittenPerDay', LIMIT_CONSEQUENCE, USAGE_ALERT_THRESHOLDS),
  ];
  if (day.databaseBytes !== null) {
    caps.push(cap('database-size', 'largest D1 database in the account', 'bytes', D1_FREE.maxDatabaseBytes, day.databaseBytes, 'D1_FREE.maxDatabaseBytes', SIZE_CONSEQUENCE, USAGE_ALERT_THRESHOLDS, true));
  }
  const elapsed = now.getTime() - startOfDay(day);
  const projected = (value: number): number => (elapsed >= PROJECTION_MIN_ELAPSED_MS && elapsed < MS_PER_DAY ? Math.round((value * MS_PER_DAY) / elapsed) : 0);
  caps.push(
    cap('rows-read-projected', 'D1 rows read, projected to 00:00 UTC', 'rows', D1_FREE.rowsReadPerDay, projected(day.rowsRead), 'D1_FREE.rowsReadPerDay', PROJECTION_CONSEQUENCE, PROJECTION_ALERT_THRESHOLDS),
    cap('rows-written-projected', 'D1 rows written, projected to 00:00 UTC', 'rows', D1_FREE.rowsWrittenPerDay, projected(day.rowsWritten), 'D1_FREE.rowsWrittenPerDay', PROJECTION_CONSEQUENCE, PROJECTION_ALERT_THRESHOLDS),
  );
  return caps.map((usage) => ({ source: USAGE_SOURCE, usage }));
}

/** The degradation step for today's usage: 0 below 70 % of either daily limit, then 1, 2 and 3 at 70, 85 and 95 %. */
export function degradationLevel(day: DailyUsage): number {
  const share = Math.max(day.rowsRead / D1_FREE.rowsReadPerDay, day.rowsWritten / D1_FREE.rowsWrittenPerDay);
  return DEGRADATION_THRESHOLDS.filter((threshold) => share >= threshold).length;
}
