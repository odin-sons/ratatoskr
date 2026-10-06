// SPDX-License-Identifier: AGPL-3.0-or-later
import { AUTOCOMPLETE_MAX_RESULTS, AUTOCOMPLETE_MIN_PREFIX, AUTOCOMPLETE_OWNER_SCAN_LIMIT, OUTBOX_MAX_ATTEMPTS } from '../core/constants.ts';
import { releaseKey } from '../core/ids.ts';
import type { CommitBatch, EventDetails, Store } from '../core/ports.ts';
import type {
  AlertState,
  DueDelivery,
  MessageRecord,
  ModEvent,
  ModThread,
  OutboxRow,
  PackageMatch,
  PackageSnapshot,
  SourceId,
  SourceState,
  Subscription,
  SubscriptionPatch,
} from '../core/types.ts';

export interface StoredOutboxRow extends OutboxRow {
  delivered: boolean;
  deliveredAt: string | null;
  parked: boolean;
  seq: number;
}

const pkgKey = (source: SourceId, packageId: string): string => `${source}|${packageId}`;
const threadKey = (channelId: string, source: SourceId, packageId: string): string => `${channelId}|${source}|${packageId}`;
const pairKey = (subscriptionId: string, eventId: string): string => `${subscriptionId}|${eventId}`;

/** Map-backed `Store` that follows the port contract, including UNIQUE(subscription, event) idempotency. */
export class MemoryStore implements Store {
  readonly sources = new Map<SourceId, SourceState>();
  readonly packages = new Map<string, PackageSnapshot>();
  readonly events = new Map<string, ModEvent>();
  readonly subscriptions = new Map<string, Subscription>();
  readonly outbox = new Map<string, StoredOutboxRow>();
  readonly alertStates = new Map<string, AlertState>();
  readonly modThreads = new Map<string, ModThread>();
  readonly messages = new Map<string, MessageRecord>();

  private readonly pairs = new Set<string>();
  private seq = 0;
  private commitFailures: Error[] = [];

  commitCount = 0;
  touchCount = 0;

  /** The next `commit` throws before applying anything. */
  failNextCommit(err: Error = new Error('simulated commit failure')): void {
    this.commitFailures.push(err);
  }

  addSubscription(sub: Subscription): void {
    this.subscriptions.set(sub.id, withDefaults(sub));
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
    this.touchCount += 1;
    const existing = this.sources.get(state.id);
    if (!existing) return;
    this.sources.set(state.id, { ...existing, etag: state.etag, lastOkAt: state.lastOkAt });
  }

  async listSubscriptions(): Promise<Subscription[]> {
    return [...this.subscriptions.values()].filter((s) => s.enabled).map((s) => ({ ...s }));
  }

  async createSubscription(sub: Subscription): Promise<void> {
    if (this.subscriptions.has(sub.id)) throw new Error(`subscription ${sub.id} already exists`);
    this.subscriptions.set(sub.id, withDefaults(sub));
  }

  async updateSubscription(id: string, patch: SubscriptionPatch): Promise<boolean> {
    const current = this.subscriptions.get(id);
    if (!current) return false;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    this.subscriptions.set(id, withDefaults({ ...current, ...defined }));
    return true;
  }

  async deleteSubscription(id: string): Promise<boolean> {
    await this.clearUndelivered([id]);
    return this.subscriptions.delete(id);
  }

  async setPausedUntil(subscriptionIds: string[], until: number): Promise<void> {
    for (const id of subscriptionIds) {
      const current = this.subscriptions.get(id);
      if (current) this.subscriptions.set(id, { ...current, pausedUntil: until });
    }
  }

  async clearUndelivered(subscriptionIds: string[]): Promise<void> {
    const ids = new Set(subscriptionIds);
    for (const row of this.outboxRows()) {
      if (!ids.has(row.subscriptionId) || row.delivered) continue;
      this.outbox.delete(row.id);
      this.pairs.delete(pairKey(row.subscriptionId, row.eventId));
    }
  }

  async listSubscriptionsByChannel(channelId: string): Promise<Subscription[]> {
    return [...this.subscriptions.values()].filter((s) => s.channelId === channelId).map((s) => ({ ...s }));
  }

  async listSubscriptionsByGuild(guildId: string): Promise<Subscription[]> {
    return [...this.subscriptions.values()].filter((s) => s.guildId === guildId).map((s) => ({ ...s }));
  }

  async countSubscriptions(): Promise<number> {
    return this.subscriptions.size;
  }

  async getModThread(channelId: string, source: SourceId, packageId: string): Promise<ModThread | null> {
    const thread = this.modThreads.get(threadKey(channelId, source, packageId));
    return thread ? { ...thread } : null;
  }

  async putModThread(thread: ModThread): Promise<void> {
    this.modThreads.set(threadKey(thread.channelId, thread.source, thread.packageId), { ...thread });
  }

  async getModThreadByThreadId(channelId: string, threadId: string): Promise<ModThread | null> {
    for (const thread of this.modThreads.values()) if (thread.channelId === channelId && thread.threadId === threadId) return { ...thread };
    return null;
  }

  async deleteModThread(channelId: string, source: SourceId, packageId: string): Promise<void> {
    this.modThreads.delete(threadKey(channelId, source, packageId));
  }

  async putMessage(message: MessageRecord): Promise<void> {
    this.messages.set(message.messageId, { ...message });
  }

  async getMessage(messageId: string): Promise<MessageRecord | null> {
    const message = this.messages.get(messageId);
    return message ? { ...message } : null;
  }

  async purgeMessages(olderThanIso: string, limit: number): Promise<number> {
    let purged = 0;
    for (const [id, message] of this.messages) {
      if (purged >= limit) break;
      if (message.createdAt >= olderThanIso) continue;
      this.messages.delete(id);
      purged += 1;
    }
    return purged;
  }

  async searchPackages(prefix: string, options: { sfwOnly?: boolean } = {}): Promise<PackageMatch[]> {
    if (prefix.length < AUTOCOMPLETE_MIN_PREFIX) return [];
    const wanted = foldAscii(prefix);
    return [...this.packages.values()]
      .filter((p) => foldAscii(p.name).startsWith(wanted) && !(options.sfwOnly === true && p.isNsfw))
      .sort((a, b) => compareFolded(a.name, b.name))
      .slice(0, AUTOCOMPLETE_MAX_RESULTS)
      .map((p) => ({ source: p.source, packageId: p.packageId, owner: p.owner, name: p.name }));
  }

  async packageExists(packageId: string, sources: SourceId[]): Promise<boolean> {
    return sources.some((source) => this.packages.has(pkgKey(source, packageId)));
  }

  async getPackagesById(packageId: string, sources: SourceId[]): Promise<PackageSnapshot[]> {
    return sources.flatMap((source) => {
      const pkg = this.packages.get(pkgKey(source, packageId));
      return pkg ? [{ ...pkg }] : [];
    });
  }

  async getEventById(eventId: string): Promise<ModEvent | null> {
    const event = this.events.get(eventId);
    return event === undefined ? null : this.joined(event);
  }

  async searchOwners(prefix: string): Promise<string[]> {
    if (prefix.length < AUTOCOMPLETE_MIN_PREFIX) return [];
    const wanted = foldAscii(prefix);
    const scanned = [...this.packages.values()]
      .filter((p) => foldAscii(p.owner).startsWith(wanted))
      .sort((a, b) => compareFolded(a.owner, b.owner))
      .slice(0, AUTOCOMPLETE_OWNER_SCAN_LIMIT);
    const owners = new Map<string, string>();
    for (const p of scanned) if (!owners.has(foldAscii(p.owner))) owners.set(foldAscii(p.owner), p.owner);
    return [...owners.values()].slice(0, AUTOCOMPLETE_MAX_RESULTS);
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
      if (list === undefined) out.set(key, [this.joined(event)]);
      else list.push(this.joined(event));
    }
    return out;
  }

  /** Like the SQL join: the event with the package as currently stored (sticky fields included) at the event's version. */
  private joined(event: ModEvent): ModEvent {
    const current = this.packages.get(pkgKey(event.pkg.source, event.pkg.packageId));
    return { ...event, pkg: { ...(current ?? event.pkg), version: event.versionTo, downloadUrl: (current ?? event.pkg).downloadUrl ?? null, downloads: (current ?? event.pkg).downloads ?? null, likes: (current ?? event.pkg).likes ?? null, websiteUrl: (current ?? event.pkg).websiteUrl ?? null } };
  }

  async takeDue(nowIso: string, limit: number): Promise<DueDelivery[]> {
    const due = this.outboxRows()
      .filter((r) => !r.delivered && !r.parked && r.attempts < OUTBOX_MAX_ATTEMPTS && r.nextAttemptAt <= nowIso)
      .sort((a, b) => (a.nextAttemptAt < b.nextAttemptAt ? -1 : a.nextAttemptAt > b.nextAttemptAt ? 1 : a.seq - b.seq));
    const out: DueDelivery[] = [];
    for (const stored of due) {
      const subscription = this.subscriptions.get(stored.subscriptionId);
      const event = this.events.get(stored.eventId);
      if (!subscription || !subscription.enabled || (subscription.pausedUntil ?? 0) * 1000 > Date.parse(nowIso) || (subscription.transport ?? 'webhook') !== 'webhook' || !event) continue;
      const { delivered: _d, deliveredAt: _da, parked: _p, seq: _s, ...row } = stored;
      out.push({ row, subscription: { ...subscription }, event: this.joined(event) });
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

  async setEventDetails(eventId: string, details: EventDetails): Promise<void> {
    const event = this.events.get(eventId);
    if (!event) return;
    this.events.set(eventId, { ...event, changelog: details.changelog, changelogUrl: details.changelogUrl });
    if (details.websiteUrl === null) return;
    const key = pkgKey(event.pkg.source, event.pkg.packageId);
    const current = this.packages.get(key);
    if (current) this.packages.set(key, { ...current, websiteUrl: details.websiteUrl });
  }

  async getAlertStates(keys: string[]): Promise<Map<string, AlertState>> {
    const found = new Map<string, AlertState>();
    for (const key of keys) {
      const state = this.alertStates.get(key);
      if (state !== undefined) found.set(key, { ...state });
    }
    return found;
  }

  async setAlertState(key: string, state: AlertState): Promise<void> {
    this.alertStates.set(key, { ...state });
  }
}

/** SQLite's NOCASE folds ASCII letters only. */
function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function compareFolded(a: string, b: string): number {
  const x = foldAscii(a);
  const y = foldAscii(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function withDefaults(sub: Subscription): Subscription {
  return {
    ...sub,
    transport: sub.transport ?? 'webhook',
    webhookUrl: sub.webhookUrl ?? null,
    channelId: sub.channelId ?? null,
    threadId: sub.threadId ?? null,
    label: sub.label ?? null,
    createdBy: sub.createdBy ?? null,
    threadPerMod: sub.threadPerMod ?? false,
    pausedUntil: sub.pausedUntil ?? 0,
  };
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
    downloadUrl: null,
    downloads: null,
    likes: null,
    websiteUrl: null,
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
    downloadUrl: next.version !== prev.version ? (next.downloadUrl ?? null) : (next.downloadUrl ?? prev.downloadUrl ?? null),
    downloads: next.downloads ?? prev.downloads ?? null,
    likes: next.likes ?? prev.likes ?? null,
    websiteUrl: next.websiteUrl ?? prev.websiteUrl ?? null,
    description: next.description ?? prev.description,
    sizeBytes: next.sizeBytes ?? prev.sizeBytes,
    categories: next.categories.length > 0 ? next.categories : prev.categories,
    isNsfw: next.isNsfw || prev.isNsfw,
    isDeprecated: next.isDeprecated || prev.isDeprecated,
  };
}
