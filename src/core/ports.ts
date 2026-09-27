// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  DiscordMessage,
  DueDelivery,
  ModEvent,
  OutboxRow,
  PackageSnapshot,
  SourceConfig,
  SourceId,
  SourceState,
  Subscription,
} from './types.ts';

// ---------------------------------------------------------------------------
// Storage port. Cloudflare adapter = D1; a Node/SQLite adapter must need no core changes.
// ---------------------------------------------------------------------------

/** Everything that must be committed atomically for one source in one tick. */
export interface CommitBatch {
  source: SourceId;
  /** Upserted into `packages`. */
  packages: PackageSnapshot[];
  /** Inserted with INSERT OR IGNORE — event id is deterministic. */
  events: ModEvent[];
  /** Fan-out rows, one per (subscription, event). INSERT OR IGNORE on the UNIQUE pair. */
  outbox: OutboxRow[];
  /** New source state; `bootstrapped` flips to true on the first successful commit. */
  state: SourceState;
}

export interface Store {
  getSourceState(source: SourceId): Promise<SourceState | null>;

  /** Latest known version per package id, for the ids requested (implementation chunks under the bound-param limit). */
  getKnownVersions(source: SourceId, packageIds: string[]): Promise<Map<string, string>>;

  /** Every known package id → latest version for a source. Used by daily reconciliation. */
  getAllKnownVersions(source: SourceId): Promise<Map<string, string>>;

  /** Single transaction: packages, events, outbox, state. Cursor advances only here. */
  commit(batch: CommitBatch): Promise<void>;

  /** Persist a fetch that produced no events (304, or nothing new): update etag/last_ok_at only. */
  touchSource(state: SourceState): Promise<void>;

  listSubscriptions(): Promise<Subscription[]>;

  /**
   * Events whose `releaseKey` (see ids.ts) is in `releaseKeys`, created at or after `sinceIso`, joined with their
   * package, grouped by key (keys without events are absent). Chunked and index-backed.
   */
  recentEventsByReleaseKeys(releaseKeys: string[], sinceIso: string): Promise<Map<string, ModEvent[]>>;

  /**
   * Undelivered, unparked rows with `nextAttemptAt <= nowIso` and attempts below the ceiling whose subscription is
   * enabled and valid, oldest first, joined for rendering.
   */
  takeDue(nowIso: string, limit: number): Promise<DueDelivery[]>;

  /** Marks rows delivered. They stay as the UNIQUE (subscription, event) guard until `purgeDelivered` removes them. */
  markDelivered(outboxIds: string[], deliveredAtIso: string): Promise<void>;

  /** Deletes at most `limit` rows delivered before `olderThanIso`; returns how many were deleted. */
  purgeDelivered(olderThanIso: string, limit: number): Promise<number>;

  /** Reschedule (or park when `parked`) failed rows and bump their `attempts`; one round trip for any number of ids. */
  markFailedMany(outboxIds: string[], nextAttemptAtIso: string, parked: boolean): Promise<void>;

  /** Moves undelivered, unparked rows to `nextAttemptAtIso` without touching `attempts`; one round trip for any number of ids. */
  rescheduleRows(outboxIds: string[], nextAttemptAtIso: string): Promise<void>;

  /** The subset of `eventIds` present in `events`. Events are never deleted, so this outlives the outbox retention. */
  existingEventIds(eventIds: string[]): Promise<Set<string>>;

  /** Stores the extracted changelog (and its full-changelog URL) on an already-committed event. */
  setEventChangelog(eventId: string, changelog: string | null, changelogUrl: string | null): Promise<void>;
}

// ---------------------------------------------------------------------------
// Discord port.
// ---------------------------------------------------------------------------

export type SendResult =
  | { ok: true }
  | { ok: false; retryable: true; retryAfterSeconds: number | null; status: number }
  /** 4xx other than 429: bad webhook, deleted channel. Do not retry. */
  | { ok: false; retryable: false; status: number };

export interface Sender {
  send(webhookUrl: string, payload: DiscordMessage): Promise<SendResult>;
}

// ---------------------------------------------------------------------------
// Upstream source adapters. Pure over an injected `fetch`, no Cloudflare APIs.
// ---------------------------------------------------------------------------

export interface PollContext {
  fetch: typeof fetch;
  userAgent: string;
  /** Previous state; `null` on the very first run. */
  state: SourceState | null;
  /** `floor(scheduledTime / 5min)`, used for split cadence (Hexium index every Nth tick). */
  tickIndex: number;
  now: Date;
  /** Secrets, e.g. `NEXUS_API_KEY`. */
  secrets: Record<string, string | undefined>;
  /** Reconciliation only: increases by one per reconcile run, so an adapter can rotate through slices of its index. */
  sliceHint?: number;
}

export type PollResult =
  | { status: 'not-modified'; etag: string | null }
  | {
      status: 'ok';
      /** Packages the adapter considers new-or-changed relative to `state.cursor`; the core diffs versions. */
      packages: PackageSnapshot[];
      cursor: string | null;
      etag: string | null;
      /** False when the listing was truncated (e.g. a burst larger than one page) — reconciliation will catch the rest. */
      complete: boolean;
      /** Degradations worth an operator's attention (one short line each, no ids or URLs); they end up in the run log. */
      warnings?: string[];
    }
  /** Adapter chose not to poll this tick (e.g. Hexium index cadence, Nexus disabled). */
  | { status: 'skipped' };

export interface SourceAdapter {
  readonly config: SourceConfig;
  /** Cheap per-tick poll. */
  poll(ctx: PollContext): Promise<PollResult>;
  /** Full sweep for daily reconciliation; absent when the store has no index. Returns every package. */
  reconcile?(ctx: PollContext): Promise<PackageSnapshot[]>;
  /** Fetch and extract a changelog excerpt for one version. Null when unavailable. Counts as one subrequest. */
  fetchChangelog(ctx: PollContext, pkg: PackageSnapshot, version: string): Promise<{ excerpt: string | null; url: string | null }>;
}

export interface Clock {
  now(): Date;
}
