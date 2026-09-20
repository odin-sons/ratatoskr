// SPDX-License-Identifier: AGPL-3.0-or-later
import { OUTBOX_MAX_ATTEMPTS } from '../core/constants.ts';
import { releaseKey } from '../core/ids.ts';
import type { CommitBatch, Store } from '../core/ports.ts';
import type {
  DueDelivery,
  ModEvent,
  OutboxRow,
  PackageSnapshot,
  SourceId,
  SourceState,
  Subscription,
} from '../core/types.ts';

export interface StoredOutboxRow extends OutboxRow {
  delivered: boolean;
  deliveredAt: string | null;
  parked: boolean;
  seq: number;
}

const pkgKey = (source: SourceId, packageId: string): string => `${source}|${packageId}`;
const pairKey = (subscriptionId: string, eventId: string): string => `${subscriptionId}|${eventId}`;

/** Map-backed `Store` that follows the port contract, including UNIQUE(subscription, event) idempotency. */
export class MemoryStore implements Store {
  readonly sources = new Map<SourceId, SourceState>();
  readonly packages = new Map<string, PackageSnapshot>();
  readonly events = new Map<string, ModEvent>();
  readonly subscriptions = new Map<string, Subscription>();
  readonly outbox = new Map<string, StoredOutboxRow>();

  private readonly pairs = new Set<string>();
  private seq = 0;
  private commitFailures: Error[] = [];

  commitCount = 0;

  /** The next `commit` throws before applying anything. */
  failNextCommit(err: Error = new Error('simulated commit failure')): void {
    this.commitFailures.push(err);
  }

  addSubscription(sub: Subscription): void {
    this.subscriptions.set(sub.id, sub);
  }

  seedPackages(source: SourceId, versions: Record<string, string>): void {
    for (const [packageId, version] of Object.entries(versions)) {
      const existing = this.packages.get(pkgKey(source, packageId));
      if (existing) this.packages.set(pkgKey(source, packageId), { ...existing, version });
      else this.packages.set(pkgKey(source, packageId), stubPackage(source, packageId, version));
    }
  }

  outboxRows(): StoredOutboxRow[] {
    return [...this.outbox.values()].sort((a, b) => a.seq - b.seq);
  }

  pendingRows(): StoredOutboxRow[] {
    return this.outboxRows().filter((r) => !r.delivered && !r.parked);
  }

  async getSourceState(source: SourceId): Promise<SourceState | null> {
    const state = this.sources.get(source);
    return state ? { ...state } : null;
  }

  async getKnownVersions(source: SourceId, packageIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of packageIds) {
      const pkg = this.packages.get(pkgKey(source, id));
      if (pkg) out.set(id, pkg.version);
    }
    return out;
  }

  async getAllKnownVersions(source: SourceId): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const pkg of this.packages.values()) if (pkg.source === source) out.set(pkg.packageId, pkg.version);
    return out;
  }

  async commit(batch: CommitBatch): Promise<void> {
    const failure = this.commitFailures.shift();
    if (failure) throw failure;
    this.commitCount += 1;

    for (const pkg of batch.packages) {
      const key = pkgKey(pkg.source, pkg.packageId);
      const prev = this.packages.get(key);
      this.packages.set(key, prev ? mergePackage(prev, pkg) : { ...pkg });
    }
    for (const event of batch.events) if (!this.events.has(event.id)) this.events.set(event.id, { ...event });
    for (const row of batch.outbox) {
      const pair = pairKey(row.subscriptionId, row.eventId);
      if (this.pairs.has(pair) || this.outbox.has(row.id)) continue;
      this.pairs.add(pair);
      this.outbox.set(row.id, { ...row, delivered: false, deliveredAt: null, parked: false, seq: this.seq++ });
    }
    this.sources.set(batch.source, { ...batch.state });
  }

  async touchSource(state: SourceState): Promise<void> {
    const existing = this.sources.get(state.id);
    if (!existing) return;
    this.sources.set(state.id, { ...existing, etag: state.etag, lastOkAt: state.lastOkAt });
  }

  async listSubscriptions(): Promise<Subscription[]> {
    return [...this.subscriptions.values()].filter((s) => s.enabled).map((s) => ({ ...s }));
  }

  async recentEventsByReleaseKeys(releaseKeys: string[], sinceIso: string): Promise<Map<string, ModEvent[]>> {
    const wanted = new Set(releaseKeys);
    const out = new Map<string, ModEvent[]>();
    if (wanted.size === 0) return out;
    for (const event of [...this.events.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))) {
      if (event.createdAt < sinceIso) continue;
      const key = releaseKey(event.pkg, event.versionTo);
      if (!wanted.has(key)) continue;
      const list = out.get(key);
      if (list === undefined) out.set(key, [{ ...event }]);
      else list.push({ ...event });
    }
    return out;
  }

  async takeDue(nowIso: string, limit: number): Promise<DueDelivery[]> {
    const due = this.outboxRows()
      .filter((r) => !r.delivered && !r.parked && r.attempts < OUTBOX_MAX_ATTEMPTS && r.nextAttemptAt <= nowIso)
      .sort((a, b) => (a.nextAttemptAt < b.nextAttemptAt ? -1 : a.nextAttemptAt > b.nextAttemptAt ? 1 : a.seq - b.seq));
    const out: DueDelivery[] = [];
    for (const stored of due) {
      const subscription = this.subscriptions.get(stored.subscriptionId);
      const event = this.events.get(stored.eventId);
      if (!subscription || !subscription.enabled || !event) continue;
      const { delivered: _d, deliveredAt: _da, parked: _p, seq: _s, ...row } = stored;
      out.push({ row, subscription: { ...subscription }, event: { ...event } });
      if (out.length >= limit) break;
    }
    return out;
  }

  async markDelivered(outboxIds: string[], deliveredAtIso: string): Promise<void> {
    for (const id of outboxIds) {
      const row = this.outbox.get(id);
      if (row && !row.delivered) {
        row.delivered = true;
        row.deliveredAt = deliveredAtIso;
      }
    }
  }

  async purgeDelivered(olderThanIso: string, limit: number): Promise<number> {
    let purged = 0;
    for (const row of this.outboxRows()) {
      if (purged >= limit) break;
      if (row.deliveredAt === null || row.deliveredAt >= olderThanIso) continue;
      this.outbox.delete(row.id);
      this.pairs.delete(pairKey(row.subscriptionId, row.eventId));
      purged += 1;
    }
    return purged;
  }

  async markFailedMany(outboxIds: string[], nextAttemptAtIso: string, parked: boolean): Promise<void> {
    for (const id of new Set(outboxIds)) {
      const row = this.outbox.get(id);
      if (!row || row.delivered) continue;
      row.attempts += 1;
      row.nextAttemptAt = nextAttemptAtIso;
      if (parked) row.parked = true;
    }
  }

  async rescheduleRows(outboxIds: string[], nextAttemptAtIso: string): Promise<void> {
    for (const id of outboxIds) {
      const row = this.outbox.get(id);
      if (row && !row.delivered && !row.parked) row.nextAttemptAt = nextAttemptAtIso;
    }
  }

  async existingEventIds(eventIds: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const id of eventIds) if (this.events.has(id)) found.add(id);
    return found;
  }

  async setEventChangelog(eventId: string, changelog: string | null, changelogUrl: string | null): Promise<void> {
    const event = this.events.get(eventId);
    if (event) this.events.set(eventId, { ...event, changelog, changelogUrl });
  }
}

function stubPackage(source: SourceId, packageId: string, version: string): PackageSnapshot {
  const store = source.split(':')[0] as PackageSnapshot['store'];
  const [owner = 'Owner', ...rest] = packageId.split('-');
  return {
    source,
    store,
    packageId,
    owner,
    name: rest.join('-') || packageId,
    version,
    url: `https://example.invalid/${packageId}`,
    iconUrl: null,
    description: null,
    categories: [],
    isNsfw: false,
    isDeprecated: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    sizeBytes: null,
  };
}

function mergePackage(prev: PackageSnapshot, next: PackageSnapshot): PackageSnapshot {
  return {
    ...next,
    iconUrl: next.iconUrl ?? prev.iconUrl,
    description: next.description ?? prev.description,
    sizeBytes: next.sizeBytes ?? prev.sizeBytes,
    categories: next.categories.length > 0 ? next.categories : prev.categories,
    isNsfw: next.isNsfw || prev.isNsfw,
    isDeprecated: next.isDeprecated || prev.isDeprecated,
  };
}
