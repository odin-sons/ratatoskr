// SPDX-License-Identifier: AGPL-3.0-or-later

/** Must match `triggers.crons` in wrangler.jsonc. */
export const TICK_CRON = '*/5 * * * *';

/** Index in this list is the `reconcileIndex` passed to `runReconcile`. */
export const RECONCILE_CRONS = ['0 3 * * *', '0 4 * * *', '0 5 * * *'] as const;
