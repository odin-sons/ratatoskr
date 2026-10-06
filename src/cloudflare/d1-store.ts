// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AUTOCOMPLETE_MAX_RESULTS,
  AUTOCOMPLETE_MIN_PREFIX,
  AUTOCOMPLETE_OWNER_SCAN_LIMIT,
  CLOUDFLARE,
  DEFAULT_DIGEST_INTERVAL_MIN,
  OUTBOX_MAX_ATTEMPTS,
} from '../core/constants.ts';
import { parseFilter } from '../core/filter.ts';
import { releaseKey } from '../core/ids.ts';
import type { CommitBatch, EventDetails, Store } from '../core/ports.ts';
import { sanitizeLogText } from '../core/report.ts';
import type {
  AlertState,
  DeliveryMode,
  DueDelivery,
  EventKind,
  MessageRecord,
  ModEvent,
  ModThread,
  PackageMatch,
  PackageSnapshot,
  OutboxRow,
  SourceId,
  SourceState,
  StoreKind,
  Subscription,
  SubscriptionPatch,
  SubscriptionTransport,
} from '../core/types.ts';
import { D1_MAX_BATCH_STATEMENTS } from './limits.ts';

type Prefixed<P extends string, T> = { [K in keyof T & string as `${P}${K}`]: T[K] };

interface SourceCols {
  id: string;
  cursor: string | null;
  etag: string | null;
  bootstrapped: number;
  last_ok_at: string | null;
}

interface PackageCols {
  source: string;
  package_id: string;
  store: string;
  latest_version: string;
  name: string;
  owner: string;
  url: string;
  icon_url: string | null;
  download_url: string | null;
  downloads: number | null;
  likes: number | null;
  website_url: string | null;
  description: string | null;
  categories: string;
  size_bytes: number | null;
  is_nsfw: number;
  is_deprecated: number;
  updated_at: string;
}

interface EventCols {
  id: string;
  source: string;
  package_id: string;
  kind: string;
  version_from: string | null;
  version_to: string;
  changelog: string | null;
  changelog_url: string | null;
  created_at: string;
}

interface SubscriptionCols {
  id: string;
  guild_id: string;
  transport: string;
  webhook_url: string | null;
  channel_id: string | null;
  thread_id: string | null;
  label: string | null;
  created_by: string | null;
  filter: string;
  mode: string;
  digest_interval_min: number | null;
  enabled: number;
  thread_per_mod: number;
  paused_until: number;
}

interface ModThreadCols {
  channel_id: string;
  source: string;
  package_id: string;
  thread_id: string;
  anchor_message_id: string | null;
  created_at: string;
}

interface MessageCols {
  message_id: string;
  channel_id: string;
  source: string;
  package_id: string;
  event_id: string | null;
  created_at: string;
}

interface OutboxCols {
  id: string;
  subscription_id: string;
  event_id: string;
  attempts: number;
  next_attempt_at: string;
}

type EventJoinRow = Prefixed<'e_', EventCols> & Prefixed<'p_', PackageCols>;
type DueJoinRow = EventJoinRow & Prefixed<'o_', OutboxCols> & Prefixed<'s_', SubscriptionCols>;

const PACKAGE_WRITE_COLUMNS = [
  'source',
  'package_id',
  'store',
  'latest_version',
  'name',
  'owner',
  'url',
  'icon_url',
  'download_url',
  'downloads',
  'likes',
  'website_url',
  'description',
  'categories',
  'size_bytes',
  'is_nsfw',
  'is_deprecated',
  'updated_at',
] as const satisfies readonly (keyof PackageCols)[];

const EVENT_WRITE_COLUMNS = [
  'id',
  'source',
  'package_id',
  'kind',
  'version_from',
  'version_to',
  'changelog',
  'changelog_url',
  'release_key',
  'created_at',
] as const;

const OUTBOX_WRITE_COLUMNS = [
  'id',
  'subscription_id',
  'event_id',
  'attempts',
  'next_attempt_at',
] as const satisfies readonly (keyof OutboxCols)[];

const SOURCE_COLUMNS = ['id', 'cursor', 'etag', 'bootstrapped', 'last_ok_at'] as const;

const EVENT_READ_COLUMNS: readonly (keyof EventCols)[] = [
  'id',
  'source',
  'package_id',
  'kind',
  'version_from',
  'version_to',
  'changelog',
  'changelog_url',
  'created_at',
];
const PACKAGE_READ_COLUMNS: readonly (keyof PackageCols)[] = PACKAGE_WRITE_COLUMNS;
const OUTBOX_READ_COLUMNS: readonly (keyof OutboxCols)[] = OUTBOX_WRITE_COLUMNS;
const SUBSCRIPTION_READ_COLUMNS: readonly (keyof SubscriptionCols)[] = [
  'id',
  'guild_id',
  'transport',
  'webhook_url',
  'channel_id',
  'thread_id',
  'label',
  'created_by',
  'filter',
  'mode',
  'digest_interval_min',
  'enabled',
  'thread_per_mod',
  'paused_until',
];
const MOD_THREAD_COLUMNS = ['channel_id', 'source', 'package_id', 'thread_id', 'anchor_message_id', 'created_at'] as const satisfies readonly (keyof ModThreadCols)[];
const MESSAGE_COLUMNS = ['message_id', 'channel_id', 'source', 'package_id', 'event_id', 'created_at'] as const satisfies readonly (keyof MessageCols)[];

function selectColumns(table: string, alias: string, columns: readonly string[]): string {
  return columns.map((c) => `${table}.${c} AS ${alias}_${c}`).join(', ');
}

const EVENT_JOIN_SELECT = `${selectColumns('e', 'e', EVENT_READ_COLUMNS)}, ${selectColumns('p', 'p', PACKAGE_READ_COLUMNS)}`;
const EVENT_JOIN_PACKAGES = 'JOIN packages p ON p.source = e.source AND p.package_id = e.package_id';

const SQL_SOURCE_STATE = `SELECT ${SOURCE_COLUMNS.join(', ')} FROM sources WHERE id = ?`;
const SQL_SOURCE_UPSERT = `INSERT INTO sources (${SOURCE_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET cursor = excluded.cursor, etag = excluded.etag, bootstrapped = excluded.bootstrapped, last_ok_at = excluded.last_ok_at`;
const SQL_SOURCE_TOUCH = `INSERT INTO sources (${SOURCE_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET etag = excluded.etag, last_ok_at = excluded.last_ok_at`;
const SQL_ALL_KNOWN = 'SELECT package_id, latest_version FROM packages WHERE source = ?';
const SUBSCRIPTION_SELECT = `SELECT ${SUBSCRIPTION_READ_COLUMNS.join(', ')} FROM subscriptions`;
const SQL_SUBSCRIPTIONS = `${SUBSCRIPTION_SELECT} WHERE enabled = 1`;
const SQL_SUBSCRIPTIONS_BY_CHANNEL = `${SUBSCRIPTION_SELECT} WHERE channel_id = ?`;
const SQL_SUBSCRIPTIONS_BY_GUILD = `${SUBSCRIPTION_SELECT} WHERE guild_id = ?`;
const SQL_CREATE_SUBSCRIPTION = `INSERT INTO subscriptions (${SUBSCRIPTION_READ_COLUMNS.join(', ')}) VALUES (${placeholders(SUBSCRIPTION_READ_COLUMNS.length)})`;
const SQL_DELETE_SUBSCRIPTION_OUTBOX = 'DELETE FROM outbox WHERE subscription_id = ? AND delivered_at IS NULL';
const SQL_DELETE_SUBSCRIPTION = 'DELETE FROM subscriptions WHERE id = ?';
const SQL_SUBSCRIPTION_EXISTS = 'SELECT id FROM subscriptions WHERE id = ?';
const SQL_GET_MOD_THREAD = `SELECT ${MOD_THREAD_COLUMNS.join(', ')} FROM mod_threads WHERE channel_id = ? AND source = ? AND package_id = ?`;
const SQL_PUT_MOD_THREAD = `INSERT INTO mod_threads (${MOD_THREAD_COLUMNS.join(', ')}) VALUES (${placeholders(MOD_THREAD_COLUMNS.length)}) ON CONFLICT (channel_id, source, package_id) DO UPDATE SET thread_id = excluded.thread_id, anchor_message_id = excluded.anchor_message_id, created_at = excluded.created_at`;
const SQL_DELETE_MOD_THREAD = 'DELETE FROM mod_threads WHERE channel_id = ? AND source = ? AND package_id = ?';
const SQL_GET_MESSAGE = `SELECT ${MESSAGE_COLUMNS.join(', ')} FROM messages WHERE message_id = ?`;
const SQL_PUT_MESSAGE = `INSERT INTO messages (${MESSAGE_COLUMNS.join(', ')}) VALUES (${placeholders(MESSAGE_COLUMNS.length)}) ON CONFLICT (message_id) DO UPDATE SET channel_id = excluded.channel_id, source = excluded.source, package_id = excluded.package_id, event_id = excluded.event_id, created_at = excluded.created_at`;
const SQL_PURGE_MESSAGES = 'DELETE FROM messages WHERE message_id IN (SELECT message_id FROM messages WHERE created_at < ? LIMIT ?)';
const SQL_SEARCH_PACKAGES = 'SELECT source, package_id, owner, name FROM packages WHERE name COLLATE NOCASE >= ? AND name COLLATE NOCASE < ? ORDER BY name COLLATE NOCASE LIMIT ?';
const SQL_SEARCH_OWNERS = 'SELECT owner FROM packages WHERE owner COLLATE NOCASE >= ? AND owner COLLATE NOCASE < ? ORDER BY owner COLLATE NOCASE LIMIT ?';
/** Above every UTF-8 sequence, so `prefix + this` bounds the range of names starting with `prefix`. */
const PREFIX_UPPER_BOUND = '\u{10FFFF}';
const SUBSCRIPTION_FILTER_IS_OBJECT = "CASE WHEN json_valid(s.filter) THEN json_type(s.filter) = 'object' ELSE 0 END";
// Unary plus keeps the planner driving from idx_outbox_pending instead of subscriptions.
const SQL_TAKE_DUE = `SELECT ${selectColumns('o', 'o', OUTBOX_READ_COLUMNS)}, ${selectColumns('s', 's', SUBSCRIPTION_READ_COLUMNS)}, ${EVENT_JOIN_SELECT} FROM outbox o JOIN events e ON e.id = o.event_id ${EVENT_JOIN_PACKAGES} JOIN subscriptions s ON s.id = o.subscription_id WHERE o.parked = 0 AND o.delivered_at IS NULL AND o.next_attempt_at <= ? AND o.attempts < ? AND +s.enabled = 1 AND s.transport = 'webhook' AND ${SUBSCRIPTION_FILTER_IS_OBJECT} ORDER BY o.next_attempt_at, o.rowid LIMIT ?`;
const SQL_MARK_DELIVERED_PREFIX = 'UPDATE outbox SET delivered_at = ? WHERE delivered_at IS NULL AND id IN';
const SQL_PURGE_DELIVERED = 'DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE delivered_at < ? LIMIT ?)';
const SQL_MARK_FAILED_PREFIX = 'UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, parked = MAX(parked, ?) WHERE delivered_at IS NULL AND id IN';
const SQL_RESCHEDULE_PREFIX = 'UPDATE outbox SET next_attempt_at = ? WHERE delivered_at IS NULL AND parked = 0 AND id IN';
const SQL_SET_ALERT_STATE = 'INSERT INTO alert_state (alert_key, level, notified_at) VALUES (?, ?, ?) ON CONFLICT (alert_key) DO UPDATE SET level = excluded.level, notified_at = excluded.notified_at';
const SQL_SET_CHANGELOG = 'UPDATE events SET changelog = ?, changelog_url = ? WHERE id = ?';
const SQL_SET_WEBSITE =
  'UPDATE packages SET website_url = ? WHERE source = (SELECT source FROM events WHERE id = ?) AND package_id = (SELECT package_id FROM events WHERE id = ?)';

const KNOWN_VERSIONS_IDS_PER_QUERY = CLOUDFLARE.d1MaxBoundParams - 1;
const RELEASE_KEYS_PER_QUERY = CLOUDFLARE.d1MaxBoundParams - 1;
const DELIVERED_IDS_PER_QUERY = CLOUDFLARE.d1MaxBoundParams - 1;
const FAILED_IDS_PER_QUERY = CLOUDFLARE.d1MaxBoundParams - 2;
const RESCHEDULE_IDS_PER_QUERY = CLOUDFLARE.d1MaxBoundParams - 1;
const EVENT_IDS_PER_QUERY = CLOUDFLARE.d1MaxBoundParams;
const ALERT_KEYS_PER_QUERY = CLOUDFLARE.d1MaxBoundParams;

function sqlAlertStates(keys: number): string {
  return `SELECT alert_key, level, notified_at FROM alert_state WHERE alert_key IN (${placeholders(keys)})`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function rowsPerStatement(columns: number): number {
  return Math.floor(CLOUDFLARE.d1MaxBoundParams / columns);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function multiRowValues(rows: number, columns: number): string {
  const tuple = `(${placeholders(columns)})`;
  return Array.from({ length: rows }, () => tuple).join(', ');
}

function upsertExpression(column: string): string {
  switch (column) {
    case 'download_url':
      return 'CASE WHEN excluded.latest_version <> packages.latest_version THEN excluded.download_url ELSE COALESCE(excluded.download_url, packages.download_url) END';
    case 'icon_url':
    case 'downloads':
    case 'likes':
    case 'website_url':
    case 'description':
    case 'size_bytes':
      return `COALESCE(excluded.${column}, packages.${column})`;
    case 'categories':
      return `CASE WHEN excluded.categories = '[]' THEN packages.categories ELSE excluded.categories END`;
    case 'is_nsfw':
    case 'is_deprecated':
      return `MAX(excluded.${column}, packages.${column})`;
    default:
      return `excluded.${column}`;
  }
}

function sqlUpsertPackages(rows: number): string {
  const cols = PACKAGE_WRITE_COLUMNS;
  const updates = cols
    .slice(2)
    .map((c) => `${c} = ${upsertExpression(c)}`)
    .join(', ');
  return `INSERT INTO packages (${cols.join(', ')}) VALUES ${multiRowValues(rows, cols.length)} ON CONFLICT (source, package_id) DO UPDATE SET ${updates}`;
}

function sqlInsertEvents(rows: number): string {
  return `INSERT OR IGNORE INTO events (${EVENT_WRITE_COLUMNS.join(', ')}) VALUES ${multiRowValues(rows, EVENT_WRITE_COLUMNS.length)}`;
}

function sqlInsertOutbox(rows: number): string {
  return `INSERT OR IGNORE INTO outbox (${OUTBOX_WRITE_COLUMNS.join(', ')}) VALUES ${multiRowValues(rows, OUTBOX_WRITE_COLUMNS.length)}`;
}

function sqlKnownVersions(ids: number): string {
  return `SELECT package_id, latest_version FROM packages WHERE source = ? AND package_id IN (${placeholders(ids)})`;
}

function sqlMarkDelivered(ids: number): string {
  return `${SQL_MARK_DELIVERED_PREFIX} (${placeholders(ids)})`;
}

function sqlMarkFailed(ids: number): string {
  return `${SQL_MARK_FAILED_PREFIX} (${placeholders(ids)})`;
}

function sqlReschedule(ids: number): string {
  return `${SQL_RESCHEDULE_PREFIX} (${placeholders(ids)})`;
}

function sqlExistingEventIds(ids: number): string {
  return `SELECT id FROM events WHERE id IN (${placeholders(ids)})`;
}

function sqlRecentByReleaseKeys(keys: number): string {
  return `SELECT ${EVENT_JOIN_SELECT}, e.release_key AS e_release_key FROM events e ${EVENT_JOIN_PACKAGES} WHERE e.release_key IN (${placeholders(keys)}) AND e.created_at >= ? ORDER BY e.created_at`;
}

export class D1Store implements Store {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async getSourceState(source: SourceId): Promise<SourceState | null> {
    const row = await this.db.prepare(SQL_SOURCE_STATE).bind(source).first<SourceCols>();
    return row === null ? null : mapSourceState(row);
  }

  async getKnownVersions(source: SourceId, packageIds: string[]): Promise<Map<string, string>> {
    const known = new Map<string, string>();
    if (packageIds.length === 0) return known;
    const statements = chunk(packageIds, KNOWN_VERSIONS_IDS_PER_QUERY).map((ids) =>
      this.db.prepare(sqlKnownVersions(ids.length)).bind(source, ...ids),
    );
    const results = await this.db.batch<{ package_id: string; latest_version: string }>(statements);
    for (const result of results) {
      for (const row of result.results) known.set(row.package_id, row.latest_version);
    }
    return known;
  }

  async getAllKnownVersions(source: SourceId): Promise<Map<string, string>> {
    const { results } = await this.db
      .prepare(SQL_ALL_KNOWN)
      .bind(source)
      .all<{ package_id: string; latest_version: string }>();
    return new Map(results.map((row) => [row.package_id, row.latest_version]));
  }

  async commit(batch: CommitBatch): Promise<void> {
    assertSingleSource(batch);

    // Split-commit order: outbox rows, then events, then packages, then state. An event that exists therefore
    // implies its outbox rows exist, which the existingEventIds filter in tick.ts relies on.
    const statements: D1PreparedStatement[] = [];
    for (const rows of chunk(batch.outbox, rowsPerStatement(OUTBOX_WRITE_COLUMNS.length))) {
      statements.push(this.db.prepare(sqlInsertOutbox(rows.length)).bind(...rows.flatMap(outboxValues)));
    }
    for (const rows of chunk(batch.events, rowsPerStatement(EVENT_WRITE_COLUMNS.length))) {
      statements.push(this.db.prepare(sqlInsertEvents(rows.length)).bind(...rows.flatMap(eventValues)));
    }
    for (const rows of chunk(dedupePackages(batch.packages), rowsPerStatement(PACKAGE_WRITE_COLUMNS.length))) {
      statements.push(this.db.prepare(sqlUpsertPackages(rows.length)).bind(...rows.flatMap(packageValues)));
    }
    const stateStatement = this.db.prepare(SQL_SOURCE_UPSERT).bind(...sourceValues(batch.state));

    const groups = chunk(statements, D1_MAX_BATCH_STATEMENTS - 1);
    const last = groups.pop() ?? [];
    for (const group of groups) await this.db.batch(group);
    await this.db.batch([...last, stateStatement]);
  }

  async touchSource(state: SourceState): Promise<void> {
    await this.db
      .prepare(SQL_SOURCE_TOUCH)
      .bind(...sourceValues(state))
      .run();
  }

  async listSubscriptions(): Promise<Subscription[]> {
    const { results } = await this.db.prepare(SQL_SUBSCRIPTIONS).all<SubscriptionCols>();
    return mapValidSubscriptions(results);
  }

  async createSubscription(sub: Subscription): Promise<void> {
    await this.db.prepare(SQL_CREATE_SUBSCRIPTION).bind(...subscriptionValues(sub)).run();
  }

  async updateSubscription(id: string, patch: SubscriptionPatch): Promise<boolean> {
    const assignments = subscriptionAssignments(patch);
    if (assignments.length === 0) return (await this.db.prepare(SQL_SUBSCRIPTION_EXISTS).bind(id).first()) !== null;
    const sql = `UPDATE subscriptions SET ${assignments.map((a) => `${a.column} = ?`).join(', ')} WHERE id = ?`;
    const result = await this.db.prepare(sql).bind(...assignments.map((a) => a.value), id).run();
    return result.meta.changes > 0;
  }

  async deleteSubscription(id: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(SQL_DELETE_SUBSCRIPTION_OUTBOX).bind(id),
      this.db.prepare(SQL_DELETE_SUBSCRIPTION).bind(id),
    ]);
    return results[1]!.meta.changes > 0;
  }

  async listSubscriptionsByChannel(channelId: string): Promise<Subscription[]> {
    const { results } = await this.db.prepare(SQL_SUBSCRIPTIONS_BY_CHANNEL).bind(channelId).all<SubscriptionCols>();
    return mapValidSubscriptions(results);
  }

  async listSubscriptionsByGuild(guildId: string): Promise<Subscription[]> {
    const { results } = await this.db.prepare(SQL_SUBSCRIPTIONS_BY_GUILD).bind(guildId).all<SubscriptionCols>();
    return mapValidSubscriptions(results);
  }

  async getModThread(channelId: string, source: SourceId, packageId: string): Promise<ModThread | null> {
    const row = await this.db.prepare(SQL_GET_MOD_THREAD).bind(channelId, source, packageId).first<ModThreadCols>();
    if (row === null) return null;
    return {
      channelId: row.channel_id,
      source: row.source,
      packageId: row.package_id,
      threadId: row.thread_id,
      anchorMessageId: row.anchor_message_id,
      createdAt: row.created_at,
    };
  }

  async putModThread(thread: ModThread): Promise<void> {
    await this.db
      .prepare(SQL_PUT_MOD_THREAD)
      .bind(thread.channelId, thread.source, thread.packageId, thread.threadId, thread.anchorMessageId, thread.createdAt)
      .run();
  }

  async deleteModThread(channelId: string, source: SourceId, packageId: string): Promise<void> {
    await this.db.prepare(SQL_DELETE_MOD_THREAD).bind(channelId, source, packageId).run();
  }

  async putMessage(message: MessageRecord): Promise<void> {
    await this.db
      .prepare(SQL_PUT_MESSAGE)
      .bind(message.messageId, message.channelId, message.source, message.packageId, message.eventId, message.createdAt)
      .run();
  }

  async getMessage(messageId: string): Promise<MessageRecord | null> {
    const row = await this.db.prepare(SQL_GET_MESSAGE).bind(messageId).first<MessageCols>();
    if (row === null) return null;
    return {
      messageId: row.message_id,
      channelId: row.channel_id,
      source: row.source,
      packageId: row.package_id,
      eventId: row.event_id,
      createdAt: row.created_at,
    };
  }

  async purgeMessages(olderThanIso: string, limit: number): Promise<number> {
    const result = await this.db.prepare(SQL_PURGE_MESSAGES).bind(olderThanIso, limit).run();
    return result.meta.changes;
  }

  async searchPackages(prefix: string): Promise<PackageMatch[]> {
    if (prefix.length < AUTOCOMPLETE_MIN_PREFIX) return [];
    const { results } = await this.db
      .prepare(SQL_SEARCH_PACKAGES)
      .bind(prefix, prefix + PREFIX_UPPER_BOUND, AUTOCOMPLETE_MAX_RESULTS)
      .all<{ source: string; package_id: string; owner: string; name: string }>();
    return results.map((r) => ({ source: r.source, packageId: r.package_id, owner: r.owner, name: r.name }));
  }

  async searchOwners(prefix: string): Promise<string[]> {
    if (prefix.length < AUTOCOMPLETE_MIN_PREFIX) return [];
    const { results } = await this.db
      .prepare(SQL_SEARCH_OWNERS)
      .bind(prefix, prefix + PREFIX_UPPER_BOUND, AUTOCOMPLETE_OWNER_SCAN_LIMIT)
      .all<{ owner: string }>();
    const owners = new Map<string, string>();
    for (const { owner } of results) {
      const folded = owner.replace(/[A-Z]/g, (c) => c.toLowerCase());
      if (!owners.has(folded)) owners.set(folded, owner);
    }
    return [...owners.values()].slice(0, AUTOCOMPLETE_MAX_RESULTS);
  }

  async recentEventsByReleaseKeys(releaseKeys: string[], sinceIso: string): Promise<Map<string, ModEvent[]>> {
    const byKey = new Map<string, ModEvent[]>();
    if (releaseKeys.length === 0) return byKey;
    const statements = chunk([...new Set(releaseKeys)], RELEASE_KEYS_PER_QUERY).map((keys) =>
      this.db.prepare(sqlRecentByReleaseKeys(keys.length)).bind(...keys, sinceIso),
    );
    const results = await this.db.batch<EventJoinRow & { e_release_key: string }>(statements);
    for (const result of results) {
      for (const row of result.results) {
        const list = byKey.get(row.e_release_key);
        if (list === undefined) byKey.set(row.e_release_key, [mapEvent(row)]);
        else list.push(mapEvent(row));
      }
    }
    return byKey;
  }

  async takeDue(nowIso: string, limit: number): Promise<DueDelivery[]> {
    const { results } = await this.db.prepare(SQL_TAKE_DUE).bind(nowIso, OUTBOX_MAX_ATTEMPTS, limit).all<DueJoinRow>();
    const subscriptions = new Map<string, Subscription | null>();
    const due: DueDelivery[] = [];
    for (const row of results) {
      let subscription = subscriptions.get(row.s_id);
      if (subscription === undefined) {
        const cols = unprefix<SubscriptionCols>(row, 's_', SUBSCRIPTION_READ_COLUMNS);
        subscription = mapSubscription(cols);
        subscriptions.set(cols.id, subscription);
        if (subscription === null) warnInvalidSubscription(cols.id);
      }
      if (subscription !== null) due.push({ row: mapOutbox(row), subscription, event: mapEvent(row) });
    }
    return due;
  }

  async markDelivered(outboxIds: string[], deliveredAtIso: string): Promise<void> {
    if (outboxIds.length === 0) return;
    const statements = chunk(outboxIds, DELIVERED_IDS_PER_QUERY).map((ids) =>
      this.db.prepare(sqlMarkDelivered(ids.length)).bind(deliveredAtIso, ...ids),
    );
    await this.db.batch(statements);
  }

  async purgeDelivered(olderThanIso: string, limit: number): Promise<number> {
    const result = await this.db.prepare(SQL_PURGE_DELIVERED).bind(olderThanIso, limit).run();
    return result.meta.changes;
  }

  async markFailedMany(outboxIds: string[], nextAttemptAtIso: string, parked: boolean): Promise<void> {
    if (outboxIds.length === 0) return;
    const statements = chunk([...new Set(outboxIds)], FAILED_IDS_PER_QUERY).map((ids) =>
      this.db.prepare(sqlMarkFailed(ids.length)).bind(nextAttemptAtIso, parked ? 1 : 0, ...ids),
    );
    await this.db.batch(statements);
  }

  async rescheduleRows(outboxIds: string[], nextAttemptAtIso: string): Promise<void> {
    if (outboxIds.length === 0) return;
    const statements = chunk(outboxIds, RESCHEDULE_IDS_PER_QUERY).map((ids) =>
      this.db.prepare(sqlReschedule(ids.length)).bind(nextAttemptAtIso, ...ids),
    );
    await this.db.batch(statements);
  }

  async existingEventIds(eventIds: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (eventIds.length === 0) return found;
    const statements = chunk([...new Set(eventIds)], EVENT_IDS_PER_QUERY).map((ids) =>
      this.db.prepare(sqlExistingEventIds(ids.length)).bind(...ids),
    );
    const results = await this.db.batch<{ id: string }>(statements);
    for (const result of results) for (const row of result.results) found.add(row.id);
    return found;
  }

  async setEventDetails(eventId: string, details: EventDetails): Promise<void> {
    const changelog = this.db.prepare(SQL_SET_CHANGELOG).bind(details.changelog, details.changelogUrl, eventId);
    if (details.websiteUrl === null) {
      await changelog.run();
      return;
    }
    await this.db.batch([changelog, this.db.prepare(SQL_SET_WEBSITE).bind(details.websiteUrl, eventId, eventId)]);
  }

  async getAlertStates(keys: string[]): Promise<Map<string, AlertState>> {
    const found = new Map<string, AlertState>();
    if (keys.length === 0) return found;
    const statements = chunk([...new Set(keys)], ALERT_KEYS_PER_QUERY).map((ids) => this.db.prepare(sqlAlertStates(ids.length)).bind(...ids));
    const results = await this.db.batch<{ alert_key: string; level: number; notified_at: string }>(statements);
    for (const result of results) {
      for (const row of result.results) found.set(row.alert_key, { level: row.level, notifiedAt: row.notified_at });
    }
    return found;
  }

  async setAlertState(key: string, state: AlertState): Promise<void> {
    await this.db.prepare(SQL_SET_ALERT_STATE).bind(key, state.level, state.notifiedAt).run();
  }
}

function assertSingleSource(batch: CommitBatch): void {
  const source = batch.source;
  const consistent =
    batch.state.id === source &&
    batch.packages.every((p) => p.source === source) &&
    batch.events.every((e) => e.pkg.source === source);
  if (!consistent) throw new Error(`commit batch mixes sources (expected ${source})`);
}

function dedupePackages(packages: readonly PackageSnapshot[]): PackageSnapshot[] {
  const byId = new Map<string, PackageSnapshot>();
  for (const pkg of packages) byId.set(pkg.packageId, pkg);
  return [...byId.values()];
}

function packageValues(p: PackageSnapshot): (string | number | null)[] {
  return [
    p.source,
    p.packageId,
    p.store,
    p.version,
    p.name,
    p.owner,
    p.url,
    p.iconUrl,
    p.downloadUrl ?? null,
    p.downloads ?? null,
    p.likes ?? null,
    p.websiteUrl ?? null,
    p.description,
    JSON.stringify(p.categories),
    p.sizeBytes,
    p.isNsfw ? 1 : 0,
    p.isDeprecated ? 1 : 0,
    p.updatedAt,
  ];
}

function eventValues(e: ModEvent): (string | number | null)[] {
  return [
    e.id,
    e.pkg.source,
    e.pkg.packageId,
    e.kind,
    e.versionFrom,
    e.versionTo,
    e.changelog,
    e.changelogUrl,
    releaseKey(e.pkg, e.versionTo),
    e.createdAt,
  ];
}

function outboxValues(o: OutboxRow): (string | number)[] {
  return [o.id, o.subscriptionId, o.eventId, o.attempts, o.nextAttemptAt];
}

function sourceValues(s: SourceState): (string | number | null)[] {
  return [s.id, s.cursor, s.etag, s.bootstrapped ? 1 : 0, s.lastOkAt];
}

function unprefix<T>(row: object, prefix: string, columns: readonly string[]): T {
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = source[`${prefix}${c}`];
  return out as T;
}

function mapSourceState(row: SourceCols): SourceState {
  return {
    id: row.id,
    cursor: row.cursor,
    etag: row.etag,
    bootstrapped: row.bootstrapped === 1,
    lastOkAt: row.last_ok_at,
  };
}

function subscriptionValues(s: Subscription): (string | number | null)[] {
  return [
    s.id,
    s.guildId,
    s.transport ?? 'webhook',
    s.webhookUrl ?? null,
    s.channelId ?? null,
    s.threadId ?? null,
    s.label ?? null,
    s.createdBy ?? null,
    JSON.stringify(s.filter),
    s.mode,
    s.digestIntervalMin,
    s.enabled ? 1 : 0,
    s.threadPerMod ? 1 : 0,
    s.pausedUntil ?? 0,
  ];
}

function subscriptionAssignments(patch: SubscriptionPatch): { column: string; value: string | number | null }[] {
  const out: { column: string; value: string | number | null }[] = [];
  if (patch.filter !== undefined) out.push({ column: 'filter', value: JSON.stringify(patch.filter) });
  if (patch.mode !== undefined) out.push({ column: 'mode', value: patch.mode });
  if (patch.digestIntervalMin !== undefined) out.push({ column: 'digest_interval_min', value: patch.digestIntervalMin });
  if (patch.enabled !== undefined) out.push({ column: 'enabled', value: patch.enabled ? 1 : 0 });
  if (patch.label !== undefined) out.push({ column: 'label', value: patch.label });
  if (patch.threadId !== undefined) out.push({ column: 'thread_id', value: patch.threadId });
  if (patch.threadPerMod !== undefined) out.push({ column: 'thread_per_mod', value: patch.threadPerMod ? 1 : 0 });
  if (patch.pausedUntil !== undefined) out.push({ column: 'paused_until', value: patch.pausedUntil });
  return out;
}

function mapSubscription(row: SubscriptionCols): Subscription | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.filter);
  } catch {
    return null;
  }
  const filter = parseFilter(parsed);
  if (filter === null || (row.mode !== 'immediate' && row.mode !== 'digest')) return null;
  if (row.transport !== 'webhook' && row.transport !== 'bot') return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    transport: row.transport as SubscriptionTransport,
    webhookUrl: row.webhook_url,
    channelId: row.channel_id,
    threadId: row.thread_id,
    label: row.label,
    createdBy: row.created_by,
    threadPerMod: row.thread_per_mod === 1,
    pausedUntil: row.paused_until,
    filter,
    mode: row.mode as DeliveryMode,
    digestIntervalMin: row.digest_interval_min ?? DEFAULT_DIGEST_INTERVAL_MIN,
    enabled: row.enabled === 1,
  };
}

function warnInvalidSubscription(id: string): void {
  console.warn(`subscription ${sanitizeLogText(id)} skipped: invalid filter or mode`);
}

function mapValidSubscriptions(rows: readonly SubscriptionCols[]): Subscription[] {
  const out: Subscription[] = [];
  for (const row of rows) {
    const subscription = mapSubscription(row);
    if (subscription === null) warnInvalidSubscription(row.id);
    else out.push(subscription);
  }
  return out;
}

function mapOutbox(row: Prefixed<'o_', OutboxCols>): OutboxRow {
  return {
    id: row.o_id,
    subscriptionId: row.o_subscription_id,
    eventId: row.o_event_id,
    attempts: row.o_attempts,
    nextAttemptAt: row.o_next_attempt_at,
  };
}

function parseCategories(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((c) => typeof c === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function mapEvent(row: EventJoinRow): ModEvent {
  const pkg: PackageSnapshot = {
    source: row.p_source,
    store: row.p_store as StoreKind,
    packageId: row.p_package_id,
    owner: row.p_owner,
    name: row.p_name,
    version: row.e_version_to,
    url: row.p_url,
    iconUrl: row.p_icon_url,
    downloadUrl: row.p_download_url,
    downloads: row.p_downloads,
    likes: row.p_likes,
    websiteUrl: row.p_website_url,
    description: row.p_description,
    categories: parseCategories(row.p_categories),
    isNsfw: row.p_is_nsfw === 1,
    isDeprecated: row.p_is_deprecated === 1,
    updatedAt: row.p_updated_at,
    sizeBytes: row.p_size_bytes,
  };
  return {
    id: row.e_id,
    kind: row.e_kind as EventKind,
    versionFrom: row.e_version_from,
    versionTo: row.e_version_to,
    changelog: row.e_changelog,
    changelogUrl: row.e_changelog_url,
    createdAt: row.e_created_at,
    pkg,
    alsoOn: [],
  };
}
