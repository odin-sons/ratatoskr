// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SubrequestBudget } from './budget.ts';
import { DISCORD, MAX_DETAILED_PER_DIGEST, OUTBOX_BACKOFF, OUTBOX_MAX_ATTEMPTS, POISON_ISOLATION_MAX_ITEMS, TICK_BUDGET } from './constants.ts';
import { fitDigestPrefix, type DigestFit } from './digest-fit.ts';
import { compileFilter, type CompiledFilter } from './filter.ts';
import { releaseKey } from './ids.ts';
import type { SendResult, SendTarget, Sender, Store } from './ports.ts';
import { targetKey } from './send-target.ts';
import { sanitizeLogText } from './report.ts';
import type { Language } from '../i18n/index.ts';
import { hasWebhook } from './types.ts';
import type { DiscordMessage, DueDelivery, ModEvent, OutboxRow, StoreEmojis, WebhookSubscription } from './types.ts';

/** Presentation settings handed to every render call. */
export interface RenderContext {
  /** Custom emoji markup per store. */
  storeEmojis?: StoreEmojis;
  /** Custom emoji markup for the source subtext link. */
  ratatoskrEmoji?: string;
  /** Message language. */
  locale?: Language;
  /** `false` renders an immediate message with only the mod page button. */
  optionalButtons?: boolean;
  /** `false` never shows the Changelog block, however long or short the excerpt. */
  includeChangelog?: boolean;
}

export interface Renderer {
  renderDigest(events: ModEvent[], opts: { detailed: (event: ModEvent) => boolean; now: Date } & RenderContext): DiscordMessage[];
  renderImmediate(event: ModEvent, opts: { now: Date } & RenderContext): DiscordMessage;
}

export interface DrainDeps {
  store: Store;
  sender: Sender;
  renderer: Renderer;
  now: Date;
  /** Custom emoji markup per store, handed to every render call. */
  storeEmojis?: StoreEmojis;
  /** Custom emoji markup for the source subtext link, handed to every render call. */
  ratatoskrEmoji?: string;
  /** Language of every rendered message. */
  locale?: Language;
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
  /** Immediate messages Discord rejected with 400 and accepted without their optional buttons. */
  degraded: number;
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

function isRateLimitWithDelay(result: FailedResult): result is FailedResult & { retryable: true; retryAfterSeconds: number } {
  return result.retryable && result.status === 429 && result.retryAfterSeconds !== null;
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

interface SendFailure {
  result: FailedResult;
  /** True when the failure came from a request to the webhook, not from the local budget. */
  attempted: boolean;
}

interface Drain {
  deps: DrainDeps;
  report: DrainReport;
  sends: number;
  perWebhook: Map<string, number>;
  blocked: Set<string>;
  /** Rows delivered, failed or parked in this drain. */
  settled: Set<string>;
  /** Webhooks that failed retryably in this drain, with the time their remaining rows become due again. */
  retryAt: Map<string, string>;
}

/**
 * Sends every due outbox row within the per-tick caps and the shared subrequest budget.
 *
 * A digest is delivered progressively: the oldest rows that fit the remaining message allowance of its webhook are
 * rendered and sent, and only those rows are marked delivered; the rest stay due for the next tick. A failure midway
 * fails just the rows of the attempted prefix, so a partly sent prefix may repeat its earlier messages on the retry.
 *
 * When a webhook fails retryably, its remaining rows of the window move to the same retry time (attempts untouched)
 * so they stop occupying the oldest slots of `takeDue`. An event that cannot be rendered is parked.
 *
 * Cost, with R rows in the window and W failing webhooks: O(R) grouping and filtering, one `markDelivered` and at
 * most one render sequence per digest (see `fitDigestPrefix`), one send per message up to the caps, at most one
 * `markFailedMany` per distinct (schedule, parked) outcome and one `rescheduleRows` per failing webhook, each a
 * single `db.batch` of ceil(n / 98) statements. Isolating unrenderable events renders at most
 * `POISON_ISOLATION_MAX_ITEMS` events per digest.
 */
export async function drainOutbox(deps: DrainDeps): Promise<DrainReport> {
  const { store, now } = deps;
  const drain: Drain = {
    deps,
    report: { sent: 0, failed: 0, deferred: 0, parked: 0, degraded: 0, filtered: 0 },
    sends: 0,
    perWebhook: new Map(),
    blocked: new Set(),
    settled: new Set(),
    retryAt: new Map(),
  };

  let due: DueDelivery[];
  try {
    due = await store.takeDue(now.toISOString(), TICK_BUDGET.maxOutboxRows);
  } catch (err) {
    drain.report.error = errorMessage(err);
    return drain.report;
  }

  const groups = new Map<string, { sub: WebhookSubscription; items: DueDelivery[] }>();
  const rowsByWebhook = new Map<string, string[]>();
  for (const item of due) {
    const sub = item.subscription;
    if (!hasWebhook(sub)) continue;
    let group = groups.get(sub.id);
    if (group === undefined) groups.set(sub.id, (group = { sub, items: [] }));
    group.items.push(item);
    const key = subscriptionKey(sub);
    const webhookRows = rowsByWebhook.get(key);
    if (webhookRows === undefined) rowsByWebhook.set(key, [item.row.id]);
    else webhookRows.push(item.row.id);
  }

  for (const { sub, items } of groups.values()) {
    if (!sub.enabled) continue;
    try {
      await deliverGroup(drain, sub, items);
    } catch (err) {
      drain.report.error ??= errorMessage(err);
    }
  }
  for (const [webhook, retryAt] of drain.retryAt) {
    const ids = (rowsByWebhook.get(webhook) ?? []).filter((id) => !drain.settled.has(id));
    if (ids.length === 0) continue;
    try {
      await store.rescheduleRows(ids, retryAt);
    } catch (err) {
      drain.report.error ??= errorMessage(err);
    }
  }
  return drain.report;
}

async function deliverGroup(drain: Drain, sub: WebhookSubscription, items: DueDelivery[]): Promise<void> {
  const filter = compileFilter(sub.filter);
  const current: DueDelivery[] = [];
  const stale: string[] = [];
  for (const item of items) {
    if (filter.matches(item.event)) current.push(item);
    else stale.push(item.row.id);
  }
  if (stale.length > 0) {
    await markDelivered(drain, stale);
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

function subscriptionTarget(sub: WebhookSubscription): SendTarget {
  return { kind: 'webhook', url: sub.webhookUrl, threadId: sub.threadId };
}

function subscriptionKey(sub: WebhookSubscription): string {
  return targetKey(subscriptionTarget(sub));
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

function renderContext(deps: DrainDeps, sub: WebhookSubscription): RenderContext {
  const context: RenderContext = {};
  if (deps.storeEmojis !== undefined) context.storeEmojis = deps.storeEmojis;
  if (deps.ratatoskrEmoji !== undefined) context.ratatoskrEmoji = deps.ratatoskrEmoji;
  if (deps.locale !== undefined) context.locale = deps.locale;
  if (sub.filter.includeChangelog === false) context.includeChangelog = false;
  return context;
}

async function deliverImmediate(drain: Drain, sub: WebhookSubscription, entry: CollapsedDelivery): Promise<void> {
  const { renderer, now } = drain.deps;
  if (allowance(drain, subscriptionKey(sub)) < 1) {
    drain.report.deferred += entry.rows.length;
    return;
  }
  let message: DiscordMessage;
  try {
    message = renderer.renderImmediate(entry.delivery.event, { now, ...renderContext(drain.deps, sub) });
  } catch {
    await parkUnrenderable(drain, [entry]);
    return;
  }
  let failure = await sendAll(drain, subscriptionTarget(sub), [message]);
  if (failure !== null) {
    const reduced = reducedMessage(drain, sub, entry.delivery.event, message, failure);
    if (reduced !== null) {
      drain.report.failed -= 1;
      failure = await sendAll(drain, subscriptionTarget(sub), [reduced]);
      if (failure === null) {
        drain.report.degraded += 1;
        console.warn(`outbox degraded immediate message event=${sanitizeLogText(entry.delivery.event.id)}: sent without optional buttons`);
      }
    }
  }
  if (failure === null) await markDelivered(drain, entry.rows.map((r) => r.id));
  else await failRows(drain, entry.rows, failure, subscriptionKey(sub));
}

/**
 * After Discord answers 400 to a message with components (a button URL it refuses that we cannot predict), the same event
 * rendered with only the mod page button; null when the failure is another one, no send is left, or the
 * message has nothing more to drop.
 */
function reducedMessage(drain: Drain, sub: WebhookSubscription, event: ModEvent, message: DiscordMessage, failure: SendFailure): DiscordMessage | null {
  const { result } = failure;
  if (result.retryable || result.status !== 400 || message.components === undefined || allowance(drain, subscriptionKey(sub)) < 1) return null;
  try {
    const reduced = drain.deps.renderer.renderImmediate(event, { now: drain.deps.now, ...renderContext(drain.deps, sub), optionalButtons: false });
    return JSON.stringify(reduced) === JSON.stringify(message) ? null : reduced;
  } catch {
    return null;
  }
}

/**
 * A new package is always detailed and never counted against the cap: it never carries a changelog (see
 * `changelogExcerpt` in `src/render/detailed.ts`), so it stays cheap regardless of how many are backlogged. A
 * watchlist hit is detailed only among the first `MAX_DETAILED_PER_DIGEST` of them, oldest first; the rest of the
 * backlog still gets a message, just as a compact line instead of a full embed with changelog.
 */
function cappedDetailed(entries: readonly CollapsedDelivery[], isWatchlistHit: (event: ModEvent) => boolean): (event: ModEvent) => boolean {
  const detailedIds = new Set<string>();
  let capped = 0;
  for (const { delivery } of entries) {
    const event = delivery.event;
    if (event.kind === 'new') detailedIds.add(event.id);
    else if (isWatchlistHit(event) && capped < MAX_DETAILED_PER_DIGEST) {
      detailedIds.add(event.id);
      capped += 1;
    }
  }
  return (event: ModEvent): boolean => detailedIds.has(event.id);
}

async function deliverDigest(drain: Drain, sub: WebhookSubscription, kept: CollapsedDelivery[], filter: CompiledFilter): Promise<void> {
  const { renderer, now } = drain.deps;
  const context = renderContext(drain.deps, sub);
  const rowCount = (entries: readonly CollapsedDelivery[]): number => entries.reduce((sum, k) => sum + k.rows.length, 0);
  const room = allowance(drain, subscriptionKey(sub));
  if (room < 1) {
    drain.report.deferred += rowCount(kept);
    return;
  }

  const detailed = cappedDetailed(kept, (event) => filter.isWatchlistHit(event));
  const renderEntries = (entries: readonly CollapsedDelivery[]): DiscordMessage[] =>
    renderer.renderDigest(entries.map((k) => k.delivery.event), { detailed, now, ...context });

  const found = fitOrIsolate(kept, room, detailed, renderEntries);
  if (found.poison.length > 0) await parkUnrenderable(drain, found.poison);
  const { live } = found;
  if (found.fit === null) {
    if (found.irreproducible.length === 0) {
      drain.report.deferred += rowCount(live);
      return;
    }
    drain.report.failed += 1;
    drain.report.deferred += rowCount(live) - rowCount(found.irreproducible);
    await failRows(drain, found.irreproducible.flatMap((k) => k.rows), TRANSIENT_FAILURE);
    return;
  }

  const sentRows = live.slice(0, found.fit.count).flatMap((k) => k.rows);
  drain.report.deferred += rowCount(live) - sentRows.length;
  const failure = await sendAll(drain, subscriptionTarget(sub), found.fit.messages);
  if (failure === null) await markDelivered(drain, sentRows.map((r) => r.id));
  else await failRows(drain, sentRows, failure, subscriptionKey(sub));
}

interface FitOutcome {
  /** Entries left after removing the unrenderable ones. */
  live: CollapsedDelivery[];
  /** Null when nothing can be sent this tick. */
  fit: DigestFit | null;
  poison: CollapsedDelivery[];
  /** The attempted prefix of a render error that no single entry reproduces. */
  irreproducible: CollapsedDelivery[];
}

/**
 * `fitDigestPrefix` over `entries`; when rendering throws, the failing entries of the attempted prefix are isolated,
 * removed and the fit retried, all within one shared `POISON_ISOLATION_MAX_ITEMS` budget.
 */
function fitOrIsolate(
  entries: CollapsedDelivery[],
  room: number,
  detailed: (event: ModEvent) => boolean,
  render: (entries: readonly CollapsedDelivery[]) => DiscordMessage[],
): FitOutcome {
  const poison: CollapsedDelivery[] = [];
  const probe = { spent: 0 };
  let live = entries;
  for (;;) {
    let attempted = 0;
    try {
      const fit = fitDigestPrefix(live, room, (k) => detailed(k.delivery.event), (prefix) => {
        attempted = prefix.length;
        return render(prefix);
      });
      return { live, fit, poison, irreproducible: [] };
    } catch {
      const prefix = live.slice(0, attempted);
      if (prefix.length === 0) return { live, fit: null, poison, irreproducible: live };
      const isolated = isolatePoison(prefix, render, probe);
      if (isolated.poison.length === 0) {
        return { live, fit: null, poison, irreproducible: isolated.truncated ? [] : prefix };
      }
      poison.push(...isolated.poison);
      const removed = new Set(isolated.poison);
      live = live.filter((k) => !removed.has(k));
      if (isolated.truncated || live.length === 0) return { live, fit: null, poison, irreproducible: [] };
    }
  }
}

/**
 * Finds the entries of `entries` (known to fail to render as a whole) that fail on their own, by bisection.
 * Cost: about 2n events rendered for one failing entry among n, at most n log n for many; probing stops, with
 * `truncated` set, once `probe.spent` reaches `POISON_ISOLATION_MAX_ITEMS`.
 */
function isolatePoison(
  entries: readonly CollapsedDelivery[],
  render: (entries: readonly CollapsedDelivery[]) => unknown,
  probe: { spent: number },
): { poison: CollapsedDelivery[]; truncated: boolean } {
  const poison: CollapsedDelivery[] = [];
  let truncated = false;

  const fails = (from: number, to: number): boolean | null => {
    if (probe.spent + (to - from) > POISON_ISOLATION_MAX_ITEMS) {
      truncated = true;
      return null;
    }
    probe.spent += to - from;
    try {
      render(entries.slice(from, to));
      return false;
    } catch {
      return true;
    }
  };

  const isolate = (from: number, to: number, verified: boolean): void => {
    if (to - from === 1) {
      if (verified || fails(from, to) === true) poison.push(entries[from]!);
      return;
    }
    const mid = from + ((to - from) >> 1);
    const left = fails(from, mid);
    if (left === null) return;
    if (!left) {
      isolate(mid, to, false);
      return;
    }
    isolate(from, mid, true);
    if (truncated) return;
    if (fails(mid, to) === true) isolate(mid, to, true);
  };

  isolate(0, entries.length, true);
  return { poison, truncated };
}

/**
 * Sends in order, stopping at the first failure; returns it, or `null` when every message was accepted.
 * `perWebhook`/`blocked` key on `targetKey` — never fold `threadId` into that key.
 */
async function sendAll(drain: Drain, target: SendTarget, messages: DiscordMessage[]): Promise<SendFailure | null> {
  const webhook = targetKey(target);
  const { sender, budget } = drain.deps;
  for (const message of messages) {
    let result: SendResult;
    let attempted = true;
    if (budget !== undefined && !budget.tryConsume()) {
      result = TRANSIENT_FAILURE;
      attempted = false;
    } else {
      try {
        result = await sender.send(target, message);
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
    return { result, attempted };
  }
  return null;
}

async function markDelivered(drain: Drain, ids: string[]): Promise<void> {
  await drain.deps.store.markDelivered(ids, drain.deps.now.toISOString());
  for (const id of ids) drain.settled.add(id);
}

/** Reschedules the rows by their own attempt count; `webhook` is passed when a request to it failed. */
async function failRows(drain: Drain, rows: OutboxRow[], failure: FailedResult | SendFailure, webhook?: string): Promise<void> {
  const { store, now } = drain.deps;
  const result = 'result' in failure ? failure.result : failure;
  if (isRateLimitWithDelay(result)) {
    const nextAttemptAt = new Date(now.getTime() + Math.ceil(Math.max(0, result.retryAfterSeconds) * 1000)).toISOString();
    const ids = rows.map((row) => row.id);
    await store.rescheduleRows(ids, nextAttemptAt);
    for (const id of ids) drain.settled.add(id);
    if (webhook !== undefined) drain.retryAt.set(webhook, nextAttemptAt);
    return;
  }
  const groups = new Map<string, { nextAttemptAt: string; parked: boolean; ids: string[] }>();
  for (const row of rows) {
    const next = scheduleFailure(row, result, now);
    const key = `${next.parked ? 1 : 0}|${next.nextAttemptAt}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { ...next, ids: [row.id] });
    else group.ids.push(row.id);
  }
  let parked = 0;
  for (const { nextAttemptAt, parked: isParked, ids } of groups.values()) {
    await store.markFailedMany(ids, nextAttemptAt, isParked);
    for (const id of ids) drain.settled.add(id);
    if (isParked) parked += ids.length;
  }
  if (webhook !== undefined && 'result' in failure && failure.attempted && result.retryable && rows.length > 0 && !drain.retryAt.has(webhook)) {
    drain.retryAt.set(webhook, scheduleFailure(rows[0]!, result, now).nextAttemptAt);
  }
  if (parked > 0) {
    drain.report.parked += parked;
    console.warn(`outbox parked rows=${parked} status=${result.status}`);
  }
}

/** Parks the rows of entries that cannot be rendered: retrying a deterministic failure only wastes attempts. */
async function parkUnrenderable(drain: Drain, entries: CollapsedDelivery[]): Promise<void> {
  const ids = entries.flatMap((entry) => entry.rows.map((row) => row.id));
  await drain.deps.store.markFailedMany(ids, drain.deps.now.toISOString(), true);
  for (const id of ids) drain.settled.add(id);
  drain.report.failed += entries.length;
  drain.report.parked += ids.length;
  for (const entry of entries) console.warn(`outbox parked unrenderable event=${sanitizeLogText(entry.delivery.event.id)}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
