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

export const MS_PER_DAY = 86_400_000;

/** Delivered outbox rows are kept this long as the idempotency guard, then purged by reconciliation. */
export const DELIVERED_RETENTION_DAYS = 7;

/** Most delivered outbox rows deleted per reconcile run. */
export const OUTBOX_PURGE_BATCH = 1000;

/** Proportional re-renders tried when a digest exceeds its message allowance, before the prefix is halved. */
export const DIGEST_FIT_ATTEMPTS = 3;

/** Events rendered (summed over probes) while isolating unrenderable events of one digest; bounds CPU on the failure path. */
export const POISON_ISOLATION_MAX_ITEMS = TICK_BUDGET.maxOutboxRows;

/** Outbox rows whose attempts reach this are parked, not retried. */
export const OUTBOX_MAX_ATTEMPTS = 8;

/** Backoff for a failed send: `min(base * 2^attempts, max)` seconds, unless Discord gave `retry_after`. */
export const OUTBOX_BACKOFF = { baseSeconds: 30, maxSeconds: 3600 } as const;

/** Tick cadence. Source: docs/spec.md "Sources" — Hexium index scan every 3rd tick. */
export const CADENCE = {
  tickMinutes: 5,
  hexiumIndexEveryNthTick: 3,
  /** Number of reconcile cron triggers per day; `src/cloudflare/crons.ts` must list this many. */
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
  version: '1.0.1',
  repoUrl: 'https://github.com/odin-sons/ratatoskr',
  license: 'AGPL-3.0-or-later',
} as const;
