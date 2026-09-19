// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD, OUTBOX_BACKOFF, OUTBOX_MAX_ATTEMPTS, TICK_BUDGET } from './constants.ts';
import { compileFilter } from './filter.ts';
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
}

export interface DrainReport {
  /** Discord messages accepted. */
  sent: number;
  /** Discord messages that failed (or renders that threw). */
  failed: number;
  /** Outbox rows left untouched because a per-tick cap was reached. */
  deferred: number;
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

interface Unit {
  rows: OutboxRow[];
  render(): DiscordMessage[];
}

interface Progress {
  sends: number;
  perWebhook: Map<string, number>;
  blocked: Set<string>;
}

/**
 * Sends every due outbox row within the per-tick caps. A digest is one unit:
 * its rows are marked delivered only after all of its messages were accepted,
 * so a failure midway can resend earlier messages on the retry.
 */
export async function drainOutbox(deps: DrainDeps): Promise<DrainReport> {
  const { store, now } = deps;
  const report: DrainReport = { sent: 0, failed: 0, deferred: 0 };
  const progress: Progress = { sends: 0, perWebhook: new Map(), blocked: new Set() };

  let due: DueDelivery[];
  try {
    due = await store.takeDue(now.toISOString(), TICK_BUDGET.maxOutboxRows);
  } catch (err) {
    report.error = errorMessage(err);
    return report;
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
      for (const unit of buildUnits(sub, items, deps)) await runUnit(sub, unit, deps, progress, report);
    } catch (err) {
      report.error ??= errorMessage(err);
    }
  }
  return report;
}

function buildUnits(sub: Subscription, items: DueDelivery[], deps: DrainDeps): Unit[] {
  const { renderer, now } = deps;
  const kept = sub.filter.dedupAcrossStores === false ? items.map((d) => ({ delivery: d, rows: [d.row] })) : collapseEquivalent(items);
  if (sub.mode === 'immediate') {
    return kept.map((k) => ({ rows: k.rows, render: () => [renderer.renderImmediate(k.delivery.event, { now })] }));
  }
  const filter = compileFilter(sub.filter);
  return [
    {
      rows: kept.flatMap((k) => k.rows),
      render: () =>
        renderer.renderDigest(
          kept.map((k) => k.delivery.event),
          { detailed: (e) => e.kind === 'new' || filter.isWatchlistHit(e), now },
        ),
    },
  ];
}

async function runUnit(sub: Subscription, unit: Unit, deps: DrainDeps, progress: Progress, report: DrainReport): Promise<void> {
  const { store, sender, now } = deps;
  const webhook = sub.webhookUrl;
  const webhookSends = (): number => progress.perWebhook.get(webhook) ?? 0;
  const capReached = (): boolean =>
    progress.blocked.has(webhook) || progress.sends >= TICK_BUDGET.maxDiscordSends || webhookSends() >= DISCORD.webhookRequestsPer2s;

  if (capReached()) {
    report.deferred += unit.rows.length;
    return;
  }

  let messages: DiscordMessage[];
  try {
    messages = unit.render();
  } catch {
    report.failed += 1;
    await failRows(store, unit.rows, { ok: false, retryable: true, retryAfterSeconds: null, status: 0 }, now);
    return;
  }

  // An oversized unit is still sent whole when it is first in line; splitting a digest would duplicate on retry.
  const n = messages.length;
  if (
    (progress.sends > 0 && progress.sends + n > TICK_BUDGET.maxDiscordSends) ||
    (webhookSends() > 0 && webhookSends() + n > DISCORD.webhookRequestsPer2s)
  ) {
    report.deferred += unit.rows.length;
    return;
  }

  let failure: FailedResult | null = null;
  for (const message of messages) {
    let result: SendResult;
    try {
      result = await sender.send(webhook, message);
    } catch {
      result = { ok: false, retryable: true, retryAfterSeconds: null, status: 0 };
    }
    progress.sends += 1;
    progress.perWebhook.set(webhook, webhookSends() + 1);
    if (result.ok) {
      report.sent += 1;
      continue;
    }
    report.failed += 1;
    failure = result;
    break;
  }

  if (failure === null) {
    await store.markDelivered(unit.rows.map((r) => r.id));
    return;
  }
  if (failure.retryable) progress.blocked.add(webhook);
  await failRows(store, unit.rows, failure, now);
}

async function failRows(store: Store, rows: OutboxRow[], result: FailedResult, now: Date): Promise<void> {
  for (const row of rows) {
    const { nextAttemptAt, parked } = scheduleFailure(row, result, now);
    await store.markFailed(row.id, nextAttemptAt, parked);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
