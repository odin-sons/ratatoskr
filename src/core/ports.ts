// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  AlertState,
  CapUsage,
  DiscordMessage,
  DueDelivery,
  MessageRecord,
  ModEvent,
  ModThread,
  OutboxRow,
  PackageMatch,
  PackageSnapshot,
  SourceConfig,
  SourceId,
  SourceState,
  Subscription,
  SubscriptionPatch,
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

  /** Enabled subscriptions, paused ones included (fan-out skips those). */
  listSubscriptions(): Promise<Subscription[]>;

  /** Inserts a subscription; rejects when the id exists. */
  createSubscription(sub: Subscription): Promise<void>;

  /** Applies the fields present in `patch`; false when the subscription does not exist. */
  updateSubscription(id: string, patch: SubscriptionPatch): Promise<boolean>;

  /** Deletes the subscription and its undelivered outbox rows; false when it does not exist. */
  deleteSubscription(id: string): Promise<boolean>;

  /** Every subscription (disabled and paused included) whose `channelId` is `channelId`. */
  listSubscriptionsByChannel(channelId: string): Promise<Subscription[]>;

  /** Every subscription (disabled and paused included) of a guild. */
  listSubscriptionsByGuild(guildId: string): Promise<Subscription[]>;

  getModThread(channelId: string, source: SourceId, packageId: string): Promise<ModThread | null>;

  /** Inserts or replaces the thread of a mod in a channel. */
  putModThread(thread: ModThread): Promise<void>;

  deleteModThread(channelId: string, source: SourceId, packageId: string): Promise<void>;

  /** Inserts or replaces the record of a bot message. */
  putMessage(message: MessageRecord): Promise<void>;

  getMessage(messageId: string): Promise<MessageRecord | null>;

  /** Deletes at most `limit` message records created before `olderThanIso`; returns how many were deleted. */
  purgeMessages(olderThanIso: string, limit: number): Promise<number>;

  /**
   * Packages whose name starts with `prefix`, ignoring ASCII case, ordered by name. A prefix shorter than
   * `AUTOCOMPLETE_MIN_PREFIX` returns nothing; at most `AUTOCOMPLETE_MAX_RESULTS` results.
   */
  searchPackages(prefix: string): Promise<PackageMatch[]>;

  /**
   * Distinct owners starting with `prefix`, ignoring ASCII case, ordered alphabetically, with the same minimum length
   * and cap as `searchPackages`. Reads at most `AUTOCOMPLETE_OWNER_SCAN_LIMIT` index entries.
   */
  searchOwners(prefix: string): Promise<string[]>;

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

  /**
   * Stores the extracted changelog (and its full-changelog URL) on an already-committed event and, when `websiteUrl`
   * is not null, the package's website (latest non-null wins).
   */
  setEventDetails(eventId: string, details: EventDetails): Promise<void>;

  /** Alert state per key; keys never alerted on are absent. */
  getAlertStates(keys: string[]): Promise<Map<string, AlertState>>;

  /** Records the level an alert was last sent (or cleared) at. */
  setAlertState(key: string, state: AlertState): Promise<void>;
}

/** What the per-event details phase learns about one event. */
export interface EventDetails {
  changelog: string | null;
  changelogUrl: string | null;
  websiteUrl: string | null;
}

// ---------------------------------------------------------------------------
// Discord port.
// ---------------------------------------------------------------------------

/** `threadId` delivers into an existing forum post or channel thread instead of the parent channel. */
export type SendTarget =
  | { kind: 'webhook'; url: string; threadId?: string | null }
  | { kind: 'bot'; channelId: string; threadId?: string | null };

export type SendResult =
  | {
      ok: true;
      /** Bot targets only. */
      messageId?: string;
      /** Bot targets only: the channel or thread the message landed in. */
      channelId?: string;
    }
  | { ok: false; retryable: true; retryAfterSeconds: number | null; status: number }
  /** 4xx other than 429: bad webhook, deleted channel. Do not retry. `gone`: the channel or thread is missing or archived. */
  | { ok: false; retryable: false; status: number; gone?: true };

export interface Sender {
  send(target: SendTarget, payload: DiscordMessage): Promise<SendResult>;
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
  /** Degradation step from the D1 usage monitor, 0 when none applies; see `DEGRADATION`. */
  degradation?: number;
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
      /** Fixed internal limits this poll measured against (see `CapUsage`). */
      capUsage?: CapUsage[];
    }
  /** Adapter chose not to poll this tick (e.g. Hexium index cadence, Nexus disabled). */
  | { status: 'skipped' };

export interface SourceAdapter {
  readonly config: SourceConfig;
  /** Cheap per-tick poll. */
  poll(ctx: PollContext): Promise<PollResult>;
  /** Full sweep for daily reconciliation; absent when the store has no index. Returns every package. */
  reconcile?(ctx: PollContext): Promise<PackageSnapshot[]>;
  /**
   * Requests the details phase spends per event at most (default 1): the changelog and, for stores whose listing lacks
   * it, the package website. The tick uses it to keep the phase inside the subrequest budget.
   */
  readonly detailRequests?: number;
  /**
   * Fetch and extract a changelog excerpt for one version and, when the listing did not carry it, the package website.
   * Nulls when unavailable; `websiteUrl` is absent unless one was found. Spends at most `detailRequests` subrequests.
   */
  fetchChangelog(
    ctx: PollContext,
    pkg: PackageSnapshot,
    version: string,
  ): Promise<{ excerpt: string | null; url: string | null; websiteUrl?: string | null }>;
}

export interface Clock {
  now(): Date;
}

// ---------------------------------------------------------------------------
// D1 usage port.
// ---------------------------------------------------------------------------

/** D1 usage of one UTC day, summed over every database in the account. */
export interface DailyUsage {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  rowsRead: number;
  rowsWritten: number;
  /** Size of the largest database in the account, null when unknown. */
  databaseBytes: number | null;
}

export interface UsageReader {
  /** Daily usage for the `days` UTC days ending with the one `now` falls in, oldest first, days without queries as zeros. */
  daily(now: Date, days: number): Promise<DailyUsage[]>;
}
