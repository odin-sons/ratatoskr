// SPDX-License-Identifier: AGPL-3.0-or-later

/** Must match `triggers.crons` in wrangler.jsonc. */
export const TICK_CRON = '*/5 * * * *';

/** Fires once per entry of `RECONCILE_HOURS_UTC`. The minute stays off the tick grid. Must match `triggers.crons` in wrangler.jsonc. */
export const RECONCILE_CRON = '1 3,4,5 * * *';

/** UTC hours at which `RECONCILE_CRON` fires. The position of an hour in this list is the `reconcileIndex` passed to `runReconcile`. */
export const RECONCILE_HOURS_UTC = [3, 4, 5] as const;

/** The `reconcileIndex` of the reconcile run scheduled at `scheduledTimeMs`, or -1 when no reconcile run is due at that hour. */
export function reconcileIndexAt(scheduledTimeMs: number): number {
  return (RECONCILE_HOURS_UTC as readonly number[]).indexOf(new Date(scheduledTimeMs).getUTCHours());
}
