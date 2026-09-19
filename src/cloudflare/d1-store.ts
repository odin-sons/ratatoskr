// SPDX-License-Identifier: AGPL-3.0-or-later
import { CLOUDFLARE, DEFAULT_DIGEST_INTERVAL_MIN } from '../core/constants.ts';
import { releaseKey } from '../core/ids.ts';
import type { CommitBatch, Store } from '../core/ports.ts';
import type {
  DeliveryMode,
  DueDelivery,
  EventKind,
  ModEvent,
  PackageSnapshot,
  OutboxRow,
  SourceId,
  SourceState,
  StoreKind,
  Subscription,
  SubscriptionFilter,
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
  webhook_url: string;
  filter: string;
  mode: string;
  digest_interval_min: number | null;
  enabled: number;
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
  'webhook_url',
  'filter',
  'mode',
  'digest_interval_min',
  'enabled',
];

function selectColumns(table: string, alias: string, columns: readonly string[]): string {
  return columns.map((c) => `${table}.${c} AS ${alias}_${c}`).join(', ');
}

const EVENT_JOIN_SELECT = `${selectColumns('e', 'e', EVENT_READ_COLUMNS)}, ${selectColumns('p', 'p', PACKAGE_READ_COLUMNS)}`;
const EVENT_JOIN_PACKAGES = 'JOIN packages p ON p.source = e.source AND p.package_id = e.package_id';

const SQL_SOURCE_STATE = `SELECT ${SOURCE_COLUMNS.join(', ')} FROM sources WHERE id = ?`;
const SQL_SOURCE_UPSERT = `INSERT INTO sources (${SOURCE_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET cursor = excluded.cursor, etag = excluded.etag, bootstrapped = excluded.bootstrapped, last_ok_at = excluded.last_ok_at`;
const SQL_SOURCE_TOUCH = `INSERT INTO sources (${SOURCE_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET etag = excluded.etag, last_ok_at = excluded.last_ok_at`;
const SQL_ALL_KNOWN = 'SELECT package_id, latest_version FROM packages WHERE source = ?';
const SQL_SUBSCRIPTIONS = `SELECT ${SUBSCRIPTION_READ_COLUMNS.join(', ')} FROM subscriptions WHERE enabled = 1`;
const SQL_RECENT_BY_RELEASE = `SELECT ${EVENT_JOIN_SELECT} FROM events e ${EVENT_JOIN_PACKAGES} WHERE e.release_key = ? AND e.created_at >= ? ORDER BY e.created_at`;
// Unary plus keeps the planner driving from idx_outbox_due instead of subscriptions.
const SQL_TAKE_DUE = `SELECT ${selectColumns('o', 'o', OUTBOX_READ_COLUMNS)}, ${selectColumns('s', 's', SUBSCRIPTION_READ_COLUMNS)}, ${EVENT_JOIN_SELECT} FROM outbox o JOIN events e ON e.id = o.event_id ${EVENT_JOIN_PACKAGES} JOIN subscriptions s ON s.id = o.subscription_id WHERE o.parked = 0 AND o.next_attempt_at <= ? AND +s.enabled = 1 ORDER BY o.next_attempt_at, o.rowid LIMIT ?`;
const SQL_MARK_FAILED = 'UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, parked = ? WHERE id = ?';
const SQL_SET_CHANGELOG = 'UPDATE events SET changelog = ?, changelog_url = ? WHERE id = ?';

const KNOWN_VERSIONS_IDS_PER_QUERY = CLOUDFLARE.d1MaxBoundParams - 1;

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
    case 'icon_url':
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

function sqlDeleteOutbox(ids: number): string {
  return `DELETE FROM outbox WHERE id IN (${placeholders(ids)})`;
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

    // Order is crash-safe when split across batches: packages (which suppress
    // re-detection) and the cursor come after the idempotent event/outbox inserts.
    const statements: D1PreparedStatement[] = [];
    for (const rows of chunk(batch.events, rowsPerStatement(EVENT_WRITE_COLUMNS.length))) {
      statements.push(this.db.prepare(sqlInsertEvents(rows.length)).bind(...rows.flatMap(eventValues)));
    }
    for (const rows of chunk(batch.outbox, rowsPerStatement(OUTBOX_WRITE_COLUMNS.length))) {
      statements.push(this.db.prepare(sqlInsertOutbox(rows.length)).bind(...rows.flatMap(outboxValues)));
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
    return results.map(mapSubscription);
  }

  async recentEventsByReleaseKey(key: string, sinceIso: string): Promise<ModEvent[]> {
    const { results } = await this.db.prepare(SQL_RECENT_BY_RELEASE).bind(key, sinceIso).all<EventJoinRow>();
    return results.map(mapEvent);
  }

  async takeDue(nowIso: string, limit: number): Promise<DueDelivery[]> {
    const { results } = await this.db.prepare(SQL_TAKE_DUE).bind(nowIso, limit).all<DueJoinRow>();
    return results.map((row) => ({
      row: mapOutbox(row),
      subscription: mapSubscription(unprefix<SubscriptionCols>(row, 's_', SUBSCRIPTION_READ_COLUMNS)),
      event: mapEvent(row),
    }));
  }

  async markDelivered(outboxIds: string[]): Promise<void> {
    if (outboxIds.length === 0) return;
    const statements = chunk(outboxIds, CLOUDFLARE.d1MaxBoundParams).map((ids) =>
      this.db.prepare(sqlDeleteOutbox(ids.length)).bind(...ids),
    );
    await this.db.batch(statements);
  }

  async markFailed(outboxId: string, nextAttemptAtIso: string, parked: boolean): Promise<void> {
    await this.db.prepare(SQL_MARK_FAILED).bind(nextAttemptAtIso, parked ? 1 : 0, outboxId).run();
  }

  async setEventChangelog(eventId: string, changelog: string | null, changelogUrl: string | null): Promise<void> {
    await this.db.prepare(SQL_SET_CHANGELOG).bind(changelog, changelogUrl, eventId).run();
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

function mapSubscription(row: SubscriptionCols): Subscription {
  return {
    id: row.id,
    guildId: row.guild_id,
    webhookUrl: row.webhook_url,
    filter: JSON.parse(row.filter) as SubscriptionFilter,
    mode: row.mode as DeliveryMode,
    digestIntervalMin: row.digest_interval_min ?? DEFAULT_DIGEST_INTERVAL_MIN,
    enabled: row.enabled === 1,
  };
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
    description: row.p_description,
    categories: JSON.parse(row.p_categories) as string[],
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
