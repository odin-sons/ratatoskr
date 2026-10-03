// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SubrequestBudget } from './budget.ts';
import { WEEKLY_REPORT_MIN_GAP_MS } from './constants.ts';
import type { Sender, Store, UsageReader } from './ports.ts';
import { buildWeeklyReport } from './weekly-report.ts';

/** `alert_state` key of the last weekly report sent. */
export const WEEKLY_REPORT_KEY = 'd1:weekly-report';

/** Days of usage the weekly report shows. */
export const WEEKLY_REPORT_DAYS = 7;

const MONDAY = 1;

export interface WeeklyInput {
  store: Pick<Store, 'getAlertStates' | 'setAlertState'>;
  sender: Sender;
  reader: UsageReader | undefined;
  /** The alert channel's webhook; without it nothing is sent. */
  webhookUrl: string | undefined;
  budget: SubrequestBudget;
  now: Date;
  scheduledTimeMs: number;
  degradation: number;
}

/** Sends the weekly D1 usage report on a Monday (UTC), at most once per `WEEKLY_REPORT_MIN_GAP_MS`; a failed attempt stores nothing, so the next reconcile run that day tries again. */
export async function maybeSendWeeklyReport(input: WeeklyInput): Promise<boolean> {
  const { store, sender, reader, webhookUrl, budget, now, scheduledTimeMs, degradation } = input;
  if (reader === undefined || webhookUrl === undefined) return false;
  if (new Date(scheduledTimeMs).getUTCDay() !== MONDAY) return false;

  const last = (await store.getAlertStates([WEEKLY_REPORT_KEY])).get(WEEKLY_REPORT_KEY);
  if (last !== undefined && now.getTime() - Date.parse(last.notifiedAt) < WEEKLY_REPORT_MIN_GAP_MS) return false;
  if (!budget.tryConsume(2)) return false;

  const days = await reader.daily(now, WEEKLY_REPORT_DAYS);
  const sent = await sender.send(webhookUrl, buildWeeklyReport(days, degradation));
  if (!sent.ok) return false;
  await store.setAlertState(WEEKLY_REPORT_KEY, { level: 0, notifiedAt: now.toISOString() });
  return true;
}
