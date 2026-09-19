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

  /** Events with this `releaseKey` (see ids.ts) created at or after `sinceIso`, joined with their package. Backed by an index. */
  recentEventsByReleaseKey(releaseKey: string, sinceIso: string): Promise<ModEvent[]>;

  /** Rows with `nextAttemptAt <= nowIso` and attempts < ceiling, oldest first, joined for rendering. */
  takeDue(nowIso: string, limit: number): Promise<DueDelivery[]>;

  markDelivered(outboxIds: string[]): Promise<void>;

  /** Reschedule (or park when `parked`) a failed row and bump `attempts`. */
  markFailed(outboxId: string, nextAttemptAtIso: string, parked: boolean): Promise<void>;

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
