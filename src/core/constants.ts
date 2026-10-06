// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every number in this module mirrors an external limit or a budget derived
 * from one. Sources are named next to each group. Do not inline these elsewhere.
 */

/** Discord webhook/embed limits. Source: docs/spec.md "Discord limits" (Discord API docs). */
export const DISCORD = {
  contentMax: 2000,
  embedsPerMessage: 10,
  embedTitleMax: 256,
  embedDescriptionMax: 4096,
  embedFieldsMax: 25,
  embedFieldNameMax: 256,
  embedFieldValueMax: 1024,
  embedFooterTextMax: 2048,
  embedAuthorNameMax: 256,
  /** Sum of all text across all embeds in one message. Binding limit. */
  embedTotalTextMax: 6000,
  /** Link buttons (component type 2, style 5) in one action row. Source: Discord developer docs, message components. */
  actionRowsPerMessage: 5,
  buttonsPerRow: 5,
  buttonLabelMax: 80,
  buttonUrlMax: 512,
  /** Components V2 messages (message flag 1 << 15): no `content` or `embeds`, everything is components. Source: Discord developer docs, components reference. */
  componentsV2Flag: 32768,
  /** Components in one V2 message, counting nested ones. */
  componentsV2ComponentsMax: 40,
  /** Text across all text displays of one V2 message (each display is also capped by it). */
  componentsV2TextMax: 4000,
  /** Relative viewer-local timestamp, `<t:UNIX:R>`. Source: Discord developer docs, message formatting. */
  timestampStyleRelative: 'R',
  /** Observed, not documented. Always prefer `retry_after` from a 429. */
  webhookRequestsPer2s: 5,
  messagesPerChannelPerMinute: 30,
} as const;

/** Custom emoji markup, `<:name:id>` or `<a:name:id>`. Source: Discord developer docs, message formatting. */
export const DISCORD_CUSTOM_EMOJI = /^<a?:[A-Za-z0-9_]{2,32}:\d{17,20}>$/;

/** Cloudflare Workers free plan. Source: CLAUDE.md "Hard constraints". */
export const CLOUDFLARE = {
  cpuMsPerInvocation: 10,
  subrequestsPerInvocation: 50,
  simultaneousConnections: 6,
  /** D1 limits bound parameters per statement. */
  d1MaxBoundParams: 100,
} as const;

/**
 * D1 on the Workers Free plan. Source: developers.cloudflare.com/d1/platform/limits and
 * developers.cloudflare.com/workers/platform/pricing (D1). The size limit is per database (500 MB), not per account.
 */
export const D1_FREE = {
  rowsReadPerDay: 5_000_000,
  rowsWrittenPerDay: 100_000,
  maxDatabaseBytes: 500_000_000,
} as const;

/** D1 usage alerts: a level at 50, 70, 85 and 95 percent of a daily or size limit. */
export const USAGE_ALERT_THRESHOLDS = [0.5, 0.7, 0.85, 0.95] as const;

/** Alert level of a projection: one, when the day's usage extrapolated to 00:00 UTC passes the limit. */
export const PROJECTION_ALERT_THRESHOLDS = [1] as const;

/** Elapsed time of the UTC day before which usage is not extrapolated. */
export const PROJECTION_MIN_ELAPSED_MS = 3 * 3_600_000;

/** The usage monitor reads the analytics API when `tickIndex % N === 1`: every 15 minutes, off the Hexium scan ticks. */
export const USAGE_CHECK_EVERY_NTH_TICK = 3;

/** Shares of a D1 daily limit (the larger of rows read and rows written) at which degradation steps 1, 2 and 3 apply. */
export const DEGRADATION_THRESHOLDS = [0.7, 0.85, 0.95] as const;

/** What each degradation step switches off. Polling and delivery are never switched off. */
export const DEGRADATION = {
  /** Step 1: reconcile runs, the purge and changelog/website fetches pause. */
  pauseExtrasFrom: 1,
  /** Step 2: the Hexium index scan runs `rarerScanFactor` times less often. */
  rarerScanFrom: 2,
  rarerScanFactor: 2,
  /** Step 3: the Hexium index scan pauses. */
  pauseScanFrom: 3,
} as const;

/** The weekly usage report goes out on the first tick from this UTC weekday and hour: Friday 20:00 UTC+3. */
export const WEEKLY_REPORT = { weekdayUtc: 5, fromHourUtc: 17 } as const;

/** A weekly usage report is sent at most this often. */
export const WEEKLY_REPORT_MIN_GAP_MS = 6 * 24 * 3_600_000;

/** Timeout of one Cloudflare GraphQL analytics request, and the most groups one answer may carry. */
export const USAGE_API = { timeoutMs: 8_000, groupLimit: 1000 } as const;

/**
 * Per-tick caps per category. Their sum can exceed `CLOUDFLARE.subrequestsPerInvocation`;
 * the shared `SubrequestBudget` (core/budget.ts) enforces the real limit and
 * whatever exceeds a cap or the budget is deferred to the next tick.
 */
export const TICK_BUDGET = {
  maxListingFetches: 6,
  maxChangelogFetches: 12,
  maxDiscordSends: 24,
  /** Outbox rows taken per drain. */
  maxOutboxRows: 400,
} as const;

/** A source's state row is rewritten at most this often when only its validator or `last_ok_at` would change. */
export const SOURCE_STATE_REFRESH_MS = 3_600_000;

/** Subrequests kept unspent as headroom below the platform limit. */
export const SUBREQUEST_SAFETY_MARGIN = 2;

/** Subrequests one invocation may spend across polls, sends and changelog fetches. */
export const SUBREQUEST_LIMIT = CLOUDFLARE.subrequestsPerInvocation - SUBREQUEST_SAFETY_MARGIN;

/** Changelog fetches leave this many subrequests unspent so Discord sends are never starved by them. */
export const SUBREQUEST_SEND_RESERVE = TICK_BUDGET.maxDiscordSends;

/**
 * Most subrequests the details phase spends for one event: the changelog plus the package website (Thunderstore's
 * listing carries no website). `maxChangelogFetches` events at this cost fill exactly `SUBREQUEST_LIMIT - SUBREQUEST_SEND_RESERVE`.
 */
export const MAX_DETAIL_REQUESTS_PER_EVENT = 2;

/** Timeout for one Discord webhook request. */
export const DISCORD_SEND_TIMEOUT_MS = 10_000;

/** Source: Discord developer docs, "Reference" (API base URL and version). */
export const DISCORD_API_BASE = 'https://discord.com/api/v10';

/** Source: Discord developer docs, "Start Thread in Forum or Media Channel" (`name`: 1-100 characters). */
export const DISCORD_THREAD_NAME_MAX = 100;

/** Source: Discord developer docs, "Response Codes" (JSON error codes). */
export const DISCORD_ERROR_CODE = {
  unknownChannel: 10003,
  threadArchived: 50083,
} as const;

export const MS_PER_DAY = 86_400_000;

/** Delivered outbox rows are kept this long as the idempotency guard, then purged by reconciliation. */
export const DELIVERED_RETENTION_DAYS = 7;

/** Most delivered outbox rows deleted per reconcile run. */
export const OUTBOX_PURGE_BATCH = 1000;

/** Bot message records are kept this long for the message command, then purged by reconciliation. Source: docs/spec.md "Bot data". */
export const MESSAGE_RETENTION_DAYS = 7;

/** Most message records deleted per reconcile run. */
export const MESSAGE_PURGE_BATCH = 1000;

/** Shortest prefix an autocomplete search runs for; a shorter one returns nothing. Source: docs/spec.md "Bot data". */
export const AUTOCOMPLETE_MIN_PREFIX = 2;

/** Choices per autocomplete response. Source: Discord developer docs, application command option choices (25). */
export const AUTOCOMPLETE_MAX_RESULTS = 25;

/** Index entries one owner search reads at most, so its D1 rows read stay bounded whatever the prefix matches. */
export const AUTOCOMPLETE_OWNER_SCAN_LIMIT = 300;

/** Proportional re-renders tried when a digest exceeds its message allowance, before the prefix is halved. */
export const DIGEST_FIT_ATTEMPTS = 3;

/** Events rendered (summed over probes) while isolating unrenderable events of one digest; bounds CPU on the failure path. */
export const POISON_ISOLATION_MAX_ITEMS = TICK_BUDGET.maxOutboxRows;

/**
 * Most watchlist-hit or immediate-mode updates rendered in full detail (with a changelog excerpt) in one digest;
 * a backlog beyond this many falls back to the compact list instead, never dropped. A new package is never
 * capped here: it never carries a changelog (see "Detailed events and changelogs" in docs/spec.md), so it is cheap
 * regardless of count.
 *
 * Measured (Node, `buildDetailed`, worst-case input: every field at its cap): about 0.038 ms per detailed event,
 * so 50 of them costs about 1.9 ms — a small, fixed slice of the 10 ms Cloudflare Workers CPU budget for the whole
 * invocation (polling, diffing and D1 writes still need most of it). Without this cap, the cost of one digest render
 * scaled with the backlog, up to `maxOutboxRows`.
 */
export const MAX_DETAILED_PER_DIGEST = 50;

/** Outbox rows whose attempts reach this are parked, not retried. */
export const OUTBOX_MAX_ATTEMPTS = 8;

/** Backoff for a failed send: `min(base * 2^attempts, max)` seconds, unless Discord gave `retry_after`. */
export const OUTBOX_BACKOFF = { baseSeconds: 30, maxSeconds: 3600 } as const;

/** Shares of a limit at which an alert is sent (70, 85 and 95 percent), then one more level when it is exceeded. */
export const CAP_ALERT_THRESHOLDS = [0.7, 0.85, 0.95] as const;

/** An exceeded limit is reported again after this long, until it is fixed. */
export const CAP_ALERT_REPEAT_MS = MS_PER_DAY;

/** Tick cadence. Source: docs/spec.md "Sources" — Hexium index scan every 3rd tick. */
export const CADENCE = {
  tickMinutes: 5,
  hexiumIndexEveryNthTick: 3,
  /** Number of reconcile cron triggers per day; `RECONCILE_HOURS_UTC` in `src/cloudflare/crons.ts` must list this many. */
  reconcileRunsPerDay: 3,
} as const;

/** Cross-store dedup window. Source: docs/spec.md "What counts as an update". */
export const DEDUP_WINDOW_HOURS = 24;

export const DEFAULT_DIGEST_INTERVAL_MIN = 30;

/** Changelog excerpt cap in characters. Source: docs/spec.md "Changelog extraction". */
export const CHANGELOG_EXCERPT_MAX = 1000;

/** Changelog excerpt cap in characters as shown in a message, trailing full-changelog link included. Source: docs/spec.md "Message layout". */
export const CHANGELOG_DISPLAY_MAX = 500;

/** Nexus: 2000 req/hour, 20000/day per personal key. Source: docs/api-notes.md. */
export const NEXUS_RATE_LIMIT = { perHour: 2000, perDay: 20000 } as const;

/** Hard ceiling on listing/index response size we are willing to scan (bytes). */
export const MAX_SCAN_BYTES = 6 * 1024 * 1024;

export const PROJECT = {
  name: 'ratatoskr',
  version: '1.3.1',
  repoUrl: 'https://github.com/odin-sons/ratatoskr',
  license: 'AGPL-3.0-or-later',
} as const;
