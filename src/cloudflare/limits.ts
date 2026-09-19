// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Conservative ceiling on statements per `D1Database.batch()` call. D1 documents no
 * fixed cap (only 100 bound parameters per statement and 100 KB per statement, see
 * https://developers.cloudflare.com/d1/platform/limits/); this keeps batches small.
 */
export const D1_MAX_BATCH_STATEMENTS = 100;
