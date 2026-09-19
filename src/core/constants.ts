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
  /** Observed, not documented. Always prefer `retry_after` from a 429. */
  webhookRequestsPer2s: 5,
  messagesPerChannelPerMinute: 30,
} as const;

/** Cloudflare Workers free plan. Source: CLAUDE.md "Hard constraints". */
export const CLOUDFLARE = {
  cpuMsPerInvocation: 10,
  subrequestsPerInvocation: 50,
  simultaneousConnections: 6,
  /** D1 limits bound parameters per statement. */
  d1MaxBoundParams: 100,
} as const;

/**
 * Per-tick budget. Caps sum to well under `CLOUDFLARE.subrequestsPerInvocation`;
 * whatever exceeds a cap is deferred to the next tick.
 */
export const TICK_BUDGET = {
  maxListingFetches: 6,
  maxChangelogFetches: 12,
  maxDiscordSends: 24,
  /** Outbox rows taken per drain. */
  maxOutboxRows: 400,
} as const;

/** Outbox rows whose attempts reach this are parked, not retried. */
export const OUTBOX_MAX_ATTEMPTS = 8;

/** Backoff for a failed send: `min(base * 2^attempts, max)` seconds, unless Discord gave `retry_after`. */
export const OUTBOX_BACKOFF = { baseSeconds: 30, maxSeconds: 3600 } as const;

/** Tick cadence. Source: docs/spec.md "Sources" — Hexium index scan every 3rd tick. */
export const CADENCE = {
  tickMinutes: 5,
  hexiumIndexEveryNthTick: 3,
} as const;

/** Cross-store dedup window. Source: docs/spec.md "What counts as an update". */
export const DEDUP_WINDOW_HOURS = 24;

export const DEFAULT_DIGEST_INTERVAL_MIN = 30;

/** Changelog excerpt cap in characters. Source: docs/spec.md "Changelog extraction". */
export const CHANGELOG_EXCERPT_MAX = 1000;

/** Nexus: 2000 req/hour, 20000/day per personal key. Source: docs/api-notes.md. */
export const NEXUS_RATE_LIMIT = { perHour: 2000, perDay: 20000 } as const;

/** Hard ceiling on listing/index response size we are willing to scan (bytes). */
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;

export const PROJECT = {
  name: 'ratatoskr',
  version: '0.1.0',
  repoUrl: 'https://github.com/odin-sons/ratatoskr',
  license: 'AGPL-3.0-or-later',
} as const;
