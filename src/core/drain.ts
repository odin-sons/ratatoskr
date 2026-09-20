// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SubrequestBudget } from './budget.ts';
import { DISCORD, OUTBOX_BACKOFF, OUTBOX_MAX_ATTEMPTS, TICK_BUDGET } from './constants.ts';
import { fitDigestPrefix } from './digest-fit.ts';
import { compileFilter, type CompiledFilter } from './filter.ts';
import { releaseKey } from './ids.ts';
import type { SendResult, Sender, Store } from './ports.ts';
import type { DiscordMessage, DueDelivery, ModEvent, OutboxRow, Subscription } from './types.ts';

export interface Renderer {
  renderDigest(events: ModEvent[], opts: { detailed: (event: ModEvent) => boolean; now: Date }): DiscordMessage[];
  renderImmediate(event: ModEvent, opts: { now: Date }): DiscordMessage;
}

export interface DrainDeps {
  store: Store;
  sender: Sender;
  renderer: Renderer;
  now: Date;
  /** Shared per-invocation subrequest pool; every Discord send spends one. */
  budget?: SubrequestBudget;
}

export interface DrainReport {
  /** Discord messages accepted. */
  sent: number;
  /** Discord messages that failed (or renders that threw). */
  failed: number;
  /** Outbox rows left untouched because a per-tick cap or the budget was reached; they are due again next tick. */
  deferred: number;
  /** Outbox rows parked in this drain. */
  parked: number;
  /** Due rows no longer matching their subscription's filter; marked delivered without sending. */
  filtered: number;
  error?: string;
}

export interface CollapsedDelivery {
  delivery: DueDelivery;
  /** The kept row plus every row it absorbed; they succeed or fail together. */
  rows: OutboxRow[];
}

type FailedResult = Extract<SendResult, { ok: false }>;

export function backoffSeconds(attempts: number): number {
  return Math.min(OUTBOX_BACKOFF.baseSeconds * 2 ** attempts, OUTBOX_BACKOFF.maxSeconds);
}

export function scheduleFailure(
  row: OutboxRow,
  result: FailedResult,
  now: Date,
): { nextAttemptAt: string; parked: boolean } {
  if (!result.retryable) return { nextAttemptAt: now.toISOString(), parked: true };
  const seconds = Math.max(0, result.retryAfterSeconds ?? backoffSeconds(row.attempts));
  return {
    nextAttemptAt: new Date(now.getTime() + Math.ceil(seconds * 1000)).toISOString(),
    parked: row.attempts + 1 >= OUTBOX_MAX_ATTEMPTS,
  };
}

/** Merges deliveries of the same release from different stores into the first one, filling `alsoOn`. */
export function collapseEquivalent(items: DueDelivery[]): CollapsedDelivery[] {
  const out: CollapsedDelivery[] = [];
  const byKey = new Map<string, CollapsedDelivery>();
  for (const item of items) {
    const key = releaseKey(item.event.pkg, item.event.versionTo);
    const first = byKey.get(key);
    if (first === undefined) {
      const entry = { delivery: item, rows: [item.row] };
      byKey.set(key, entry);
      out.push(entry);
    } else if (first.delivery.event.pkg.store === item.event.pkg.store) {
      out.push({ delivery: item, rows: [item.row] });
    } else {
      const event = first.delivery.event;
      const store = item.event.pkg.store;
      if (!event.alsoOn.some((a) => a.store === store)) {
        first.delivery = { ...first.delivery, event: { ...event, alsoOn: [...event.alsoOn, { store, url: item.event.pkg.url }] } };
      }
      first.rows.push(item.row);
    }
  }
  return out;
}

const TRANSIENT_FAILURE: FailedResult = { ok: false, retryable: true, retryAfterSeconds: null, status: 0 };

interface Drain {
  deps: DrainDeps;
  report: DrainReport;
  sends: number;
  perWebhook: Map<string, number>;
  blocked: Set<string>;
}

/**
 * Sends every due outbox row within the per-tick caps and the shared subrequest budget.
 *
 * A digest is delivered progressively: the oldest rows that fit the remaining message allowance of its webhook are
 * rendered and sent, and only those rows are marked delivered; the rest stay due for the next tick. A failure midway
 * fails just the rows of the attempted prefix, so a partly sent prefix may repeat its earlier messages on the retry.
 *
 * Cost: O(rows) grouping and filtering, one `markDelivered` and at most one render sequence per digest
 * (see `fitDigestPrefix`), one send per message up to the caps.
 */
export async function drainOutbox(deps: DrainDeps): Promise<DrainReport> {
  const { store, now } = deps;
  const drain: Drain = {
    deps,
    report: { sent: 0, failed: 0, deferred: 0, parked: 0, filtered: 0 },
    sends: 0,
    perWebhook: new Map(),
    blocked: new Set(),
  };

  let due: DueDelivery[];
  try {
    due = await store.takeDue(now.toISOString(), TICK_BUDGET.maxOutboxRows);
  } catch (err) {
    drain.report.error = errorMessage(err);
    return drain.report;
  }

  const groups = new Map<string, { sub: Subscription; items: DueDelivery[] }>();
  for (const item of due) {
    let group = groups.get(item.subscription.id);
    if (group === undefined) groups.set(item.subscription.id, (group = { sub: item.subscription, items: [] }));
    group.items.push(item);
  }

  for (const { sub, items } of groups.values()) {
    if (!sub.enabled) continue;
    try {
      await deliverGroup(drain, sub, items);
    } catch (err) {
      drain.report.error ??= errorMessage(err);
    }
  }
  return drain.report;
}


async function deliverGroup(drain: Drain, sub: Subscription, items: DueDelivery[]): Promise<void> {
  const { store, now } = drain.deps;
  const filter = compileFilter(sub.filter);
  const current: DueDelivery[] = [];
  const stale: string[] = [];
  for (const item of items) {
    if (filter.matches(item.event)) current.push(item);
    else stale.push(item.row.id);
  }
  if (stale.length > 0) {
    await store.markDelivered(stale, now.toISOString());
    drain.report.filtered += stale.length;
  }
  if (current.length === 0) return;

  const kept = sub.filter.dedupAcrossStores === false ? current.map((d) => ({ delivery: d, rows: [d.row] })) : collapseEquivalent(current);
  if (sub.mode === 'immediate') {
    for (const entry of kept) await deliverImmediate(drain, sub, entry);
  } else {
    await deliverDigest(drain, sub, kept, filter);
  }
}

/** Messages still allowed for `webhook` in this tick: per-tick cap, per-webhook cap and the shared budget. */
function allowance(drain: Drain, webhook: string): number {
  if (drain.blocked.has(webhook)) return 0;
  const room = Math.min(
    TICK_BUDGET.maxDiscordSends - drain.sends,
    DISCORD.webhookRequestsPer2s - (drain.perWebhook.get(webhook) ?? 0),
    drain.deps.budget?.remaining ?? Number.POSITIVE_INFINITY,
  );
  return Math.max(0, room);
}

async function deliverImmediate(drain: Drain, sub: Subscription, entry: CollapsedDelivery): Promise<void> {
  const { store, renderer, now } = drain.deps;
  if (allowance(drain, sub.webhookUrl) < 1) {
    drain.report.deferred += entry.rows.length;
    return;
  }
  let message: DiscordMessage;
  try {
    message = renderer.renderImmediate(entry.delivery.event, { now });
  } catch {
    drain.report.failed += 1;
    await failRows(drain, entry.rows, TRANSIENT_FAILURE);
    return;
  }
  const failure = await sendAll(drain, sub.webhookUrl, [message]);
  if (failure === null) await store.markDelivered(entry.rows.map((r) => r.id), now.toISOString());
  else await failRows(drain, entry.rows, failure);
}

async function deliverDigest(drain: Drain, sub: Subscription, kept: CollapsedDelivery[], filter: CompiledFilter): Promise<void> {
  const { store, renderer, now } = drain.deps;
  const allRows = kept.flatMap((k) => k.rows);
  const room = allowance(drain, sub.webhookUrl);
  if (room < 1) {
    drain.report.deferred += allRows.length;
    return;
  }

  const detailed = (event: ModEvent): boolean => event.kind === 'new' || filter.isWatchlistHit(event);
  let fit;
  try {
    fit = fitDigestPrefix(
      kept,
      room,
      (k) => detailed(k.delivery.event),
      (prefix) => renderer.renderDigest(prefix.map((k) => k.delivery.event), { detailed, now }),
    );
  } catch {
    drain.report.failed += 1;
    await failRows(drain, allRows, TRANSIENT_FAILURE);
    return;
  }

  const sentRows = kept.slice(0, fit.count).flatMap((k) => k.rows);
  drain.report.deferred += allRows.length - sentRows.length;
  const failure = await sendAll(drain, sub.webhookUrl, fit.messages);
  if (failure === null) await store.markDelivered(sentRows.map((r) => r.id), now.toISOString());
  else await failRows(drain, sentRows, failure);
}

/** Sends in order, stopping at the first failure; returns it, or `null` when every message was accepted. */
async function sendAll(drain: Drain, webhook: string, messages: DiscordMessage[]): Promise<FailedResult | null> {
  const { sender, budget } = drain.deps;
  for (const message of messages) {
    let result: SendResult;
    if (budget !== undefined && !budget.tryConsume()) {
      result = TRANSIENT_FAILURE;
    } else {
      try {
        result = await sender.send(webhook, message);
      } catch {
        result = TRANSIENT_FAILURE;
      }
      drain.sends += 1;
      drain.perWebhook.set(webhook, (drain.perWebhook.get(webhook) ?? 0) + 1);
    }
    if (result.ok) {
      drain.report.sent += 1;
      continue;
    }
    drain.report.failed += 1;
    if (result.retryable) drain.blocked.add(webhook);
    return result;
  }
  return null;
}

async function failRows(drain: Drain, rows: OutboxRow[], result: FailedResult): Promise<void> {
  const { store, now } = drain.deps;
  let parked = 0;
  for (const row of rows) {
    const next = scheduleFailure(row, result, now);
    await store.markFailed(row.id, next.nextAttemptAt, next.parked);
    if (next.parked) parked += 1;
  }
  if (parked > 0) {
    drain.report.parked += parked;
    console.warn(`outbox parked rows=${parked} status=${result.status}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
