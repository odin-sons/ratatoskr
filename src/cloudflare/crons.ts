// SPDX-License-Identifier: AGPL-3.0-or-later

/** Must match `triggers.crons` in wrangler.jsonc. */
export const TICK_CRON = '*/5 * * * *';

/** Index in this list is the `reconcileIndex` passed to `runReconcile`. Minutes stay off the tick grid. */
export const RECONCILE_CRONS = ['1 3 * * *', '1 4 * * *', '1 5 * * *'] as const;
