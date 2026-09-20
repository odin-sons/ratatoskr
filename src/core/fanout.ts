// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEDUP_WINDOW_HOURS, DEFAULT_DIGEST_INTERVAL_MIN } from './constants.ts';
import type { CompiledFilter } from './filter.ts';
import { outboxId, releaseKey } from './ids.ts';
import type { Store } from './ports.ts';
import type { ModEvent, OutboxRow, Subscription } from './types.ts';

export interface CompiledSubscription {
  sub: Subscription;
  filter: CompiledFilter;
}

export interface FanOutResult {
  rows: OutboxRow[];
  /** Ids of events that at least one receiving subscription shows in detail. */
  detailedEventIds: Set<string>;
}

/** Next multiple of the interval (epoch-aligned) at or after `now`. */
export function nextDigestBoundary(now: Date, intervalMin: number): string {
  const minutes = Number.isFinite(intervalMin) && intervalMin > 0 ? intervalMin : DEFAULT_DIGEST_INTERVAL_MIN;
  const stepMs = minutes * 60_000;
  return new Date(Math.ceil(now.getTime() / stepMs) * stepMs).toISOString();
}

/**
 * Creates one outbox row per (subscription, event) pair that matches the
 * subscription's filter. Skips a pair when the same release from another
 * store already produced an event that this subscription's filter also accepts.
 *
 * Cost: O(events x subscriptions) filter checks, one store query per call.
 */
export async function fanOut(
  events: ModEvent[],
  subs: CompiledSubscription[],
  store: Pick<Store, 'recentEventsByReleaseKeys'>,
  now: Date,
): Promise<FanOutResult> {
  const rows: OutboxRow[] = [];
  const detailedEventIds = new Set<string>();
  const nowIso = now.toISOString();
  const sinceIso = new Date(now.getTime() - DEDUP_WINDOW_HOURS * 3_600_000).toISOString();

  const matched: { event: ModEvent; subs: CompiledSubscription[] }[] = [];
  const keys = new Set<string>();
  for (const event of events) {
    const receivers = subs.filter(({ filter }) => filter.matches(event));
    if (receivers.length === 0) continue;
    matched.push({ event, subs: receivers });
    if (receivers.some(({ sub }) => sub.filter.dedupAcrossStores !== false)) keys.add(releaseKey(event.pkg, event.versionTo));
  }
  const recent = keys.size === 0 ? new Map<string, ModEvent[]>() : await store.recentEventsByReleaseKeys([...keys], sinceIso);

  for (const { event, subs: receivers } of matched) {
    const others = recent.get(releaseKey(event.pkg, event.versionTo)) ?? [];
    for (const { sub, filter } of receivers) {
      if (sub.filter.dedupAcrossStores !== false && others.some((r) => r.id !== event.id && r.pkg.store !== event.pkg.store && filter.matches(r))) {
        continue;
      }
      rows.push({
        id: outboxId(sub.id, event.id),
        subscriptionId: sub.id,
        eventId: event.id,
        attempts: 0,
        nextAttemptAt: sub.mode === 'digest' ? nextDigestBoundary(now, sub.digestIntervalMin) : nowIso,
      });
      if (event.kind === 'new' || filter.isWatchlistHit(event)) detailedEventIds.add(event.id);
    }
  }
  return { rows, detailedEventIds };
}
