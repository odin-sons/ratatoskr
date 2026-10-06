// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SubrequestBudget } from './budget.ts';
import {
  BOT_UNCONFIGURED_RETRY_SECONDS,
  DISCORD,
  DISCORD_EPOCH_MS,
  DISCORD_THREAD_NAME_MAX,
  MAX_DETAILED_PER_DIGEST,
  OUTBOX_BACKOFF,
  OUTBOX_MAX_ATTEMPTS,
  POISON_ISOLATION_MAX_ITEMS,
  THREAD_FRESH_MS,
  TICK_BUDGET,
} from './constants.ts';
import { fitDigestPrefix, type DigestFit } from './digest-fit.ts';
import { compileFilter, type CompiledFilter } from './filter.ts';
import { releaseKey } from './ids.ts';
import type { ForumPostResult, OpenThreadResult, SendResult, SendTarget, Sender, Store } from './ports.ts';
import { targetKey } from './send-target.ts';
import { sanitizeLogText } from './report.ts';
import type { Language } from '../i18n/index.ts';
import { hasWebhook } from './types.ts';
import type { DiscordMessage, DueDelivery, MessageRecord, ModEvent, ModThread, OutboxRow, StoreEmojis, Subscription } from './types.ts';

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
  unavailableLogged: boolean;
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
    unavailableLogged: false,
  };

  let due: DueDelivery[];
  try {
    due = await store.takeDue(now.toISOString(), TICK_BUDGET.maxOutboxRows);
  } catch (err) {
    drain.report.error = errorMessage(err);
    return drain.report;
  }

  const groups = new Map<string, { sub: Subscription; target: SendTarget; items: DueDelivery[] }>();
  const rowsByWebhook = new Map<string, string[]>();
  for (const item of due) {
    const sub = item.subscription;
    const target = subscriptionTarget(sub);
    if (target === null) continue;
    let group = groups.get(sub.id);
    if (group === undefined) groups.set(sub.id, (group = { sub, target, items: [] }));
    group.items.push(item);
    const key = targetKey(target);
    const webhookRows = rowsByWebhook.get(key);
    if (webhookRows === undefined) rowsByWebhook.set(key, [item.row.id]);
    else webhookRows.push(item.row.id);
  }

  for (const { sub, target, items } of groups.values()) {
    if (!sub.enabled) continue;
    try {
      await deliverGroup(drain, sub, target, items);
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

async function deliverGroup(drain: Drain, sub: Subscription, target: SendTarget, items: DueDelivery[]): Promise<void> {
  if (drain.deps.sender.canSend?.(target) === false) {
    const ids = items.map((item) => item.row.id);
    await drain.deps.store.rescheduleRows(ids, new Date(drain.deps.now.getTime() + BOT_UNCONFIGURED_RETRY_SECONDS * 1000).toISOString());
    for (const id of ids) drain.settled.add(id);
    if (!drain.unavailableLogged) {
      drain.unavailableLogged = true;
      console.warn('outbox rows are waiting: the sender cannot deliver to their target');
    }
    return;
  }
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
    for (const entry of kept) await deliverImmediate(drain, sub, target, entry);
  } else {
    await deliverDigest(drain, sub, target, kept, filter);
  }
}

/** Null when the subscription lacks the destination its transport needs; its rows stay queued. */
export function subscriptionTarget(sub: Subscription): SendTarget | null {
  if (sub.transport === 'bot') {
    return typeof sub.channelId === 'string' && sub.channelId !== '' ? { kind: 'bot', channelId: sub.channelId, threadId: sub.threadId ?? null } : null;
  }
  return hasWebhook(sub) ? { kind: 'webhook', url: sub.webhookUrl, threadId: sub.threadId } : null;
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

function renderContext(deps: DrainDeps, sub: Subscription): RenderContext {
  const context: RenderContext = {};
  if (deps.storeEmojis !== undefined) context.storeEmojis = deps.storeEmojis;
  if (deps.ratatoskrEmoji !== undefined) context.ratatoskrEmoji = deps.ratatoskrEmoji;
  if (deps.locale !== undefined) context.locale = deps.locale;
  if (sub.filter.includeChangelog === false) context.includeChangelog = false;
  return context;
}

async function deliverImmediate(drain: Drain, sub: Subscription, target: SendTarget, entry: CollapsedDelivery): Promise<void> {
  const { renderer, now } = drain.deps;
  const key = targetKey(target);
  if (allowance(drain, key) < 1) {
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
  if (target.kind === 'bot' && sub.threadPerMod === true) {
    await deliverRouted(drain, sub, target, entry, message);
    return;
  }
  let sent: SendResult[] = [];
  let failure = await sendAll(drain, target, [message], sent);
  if (failure !== null) {
    const reduced = reducedMessage(drain, sub, entry.delivery.event, message, failure, key);
    if (reduced !== null) {
      drain.report.failed -= 1;
      sent = [];
      failure = await sendAll(drain, target, [reduced], sent);
      if (failure === null) {
        drain.report.degraded += 1;
        console.warn(`outbox degraded immediate message event=${sanitizeLogText(entry.delivery.event.id)}: sent without optional buttons`);
      }
    }
  }
  if (failure === null) {
    const landed = sent[0];
    if (landed?.ok === true && landed.messageId !== undefined) {
      await writeMapping(() => drain.deps.store.putMessage(messageRecord(drain, entry.delivery.event, landed.messageId!, landed.channelId ?? threadOrChannel(target))));
    }
    await markDelivered(drain, entry.rows.map((r) => r.id));
  } else {
    const soft = softenFreshGone(drain, target, failure);
    await failRows(drain, entry.rows, soft, soft === failure ? key : undefined);
  }
}

/**
 * After Discord answers 400 to a message with components (a button URL it refuses that we cannot predict), the same event
 * rendered with only the mod page button; null when the failure is another one, no send is left, or the
 * message has nothing more to drop.
 */
function reducedMessage(drain: Drain, sub: Subscription, event: ModEvent, message: DiscordMessage, failure: SendFailure, key: string): DiscordMessage | null {
  const { result } = failure;
  if (result.retryable || result.status !== 400 || message.components === undefined || allowance(drain, key) < 1) return null;
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

async function deliverDigest(drain: Drain, sub: Subscription, target: SendTarget, kept: CollapsedDelivery[], filter: CompiledFilter): Promise<void> {
  const { renderer, now } = drain.deps;
  const context = renderContext(drain.deps, sub);
  const key = targetKey(target);
  const rowCount = (entries: readonly CollapsedDelivery[]): number => entries.reduce((sum, k) => sum + k.rows.length, 0);
  const room = allowance(drain, key);
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
  const failure = await sendAll(drain, target, found.fit.messages);
  if (failure === null) {
    await markDelivered(drain, sentRows.map((r) => r.id));
  } else {
    const soft = softenFreshGone(drain, target, failure);
    await failRows(drain, sentRows, soft, soft === failure ? key : undefined);
  }
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
 * `perWebhook`/`blocked` key on `targetKey` - never fold `threadId` into that key. Accepted results are appended to `accepted`.
 */
async function sendAll(drain: Drain, target: SendTarget, messages: DiscordMessage[], accepted?: SendResult[]): Promise<SendFailure | null> {
  const webhook = targetKey(target);
  for (const message of messages) {
    const { result, attempted } = await request(drain, webhook, () => drain.deps.sender.send(target, message));
    if (result.ok) {
      drain.report.sent += 1;
      accepted?.push(result);
      continue;
    }
    drain.report.failed += 1;
    if (result.retryable) drain.blocked.add(webhook);
    return { result, attempted };
  }
  return null;
}

/** One Discord request against the shared budget and the per-key counters; a budget refusal or a throw is a transient failure. */
async function request<T extends { ok: boolean }>(drain: Drain, key: string, run: () => Promise<T>): Promise<{ result: T | FailedResult; attempted: boolean }> {
  const { budget } = drain.deps;
  if (budget !== undefined && !budget.tryConsume()) return { result: TRANSIENT_FAILURE, attempted: false };
  let result: T | FailedResult;
  try {
    result = await run();
  } catch {
    result = TRANSIENT_FAILURE;
  }
  drain.sends += 1;
  drain.perWebhook.set(key, (drain.perWebhook.get(key) ?? 0) + 1);
  return { result, attempted: true };
}

type BotTarget = Extract<SendTarget, { kind: 'bot' }>;

const UNSUPPORTED: FailedResult = { ok: false, retryable: false, status: 0 };

type Route =
  | { op: 'post'; cost: 1 }
  | { op: 'message'; cost: 1 }
  | { op: 'thread'; cost: 1; threadId: string }
  | { op: 'open'; cost: 2; anchorMessageId: string };

type RouteOutcome = { ok: true } | { ok: false; failure: SendFailure; reset: boolean };

function planRoute(kind: 'text' | 'forum', thread: ModThread | null): Route {
  if (thread !== null && thread.threadId !== '') return { op: 'thread', cost: 1, threadId: thread.threadId };
  if (kind === 'text' && thread?.anchorMessageId) return { op: 'open', cost: 2, anchorMessageId: thread.anchorMessageId };
  return kind === 'forum' ? { op: 'post', cost: 1 } : { op: 'message', cost: 1 };
}

function threadName(event: ModEvent): string {
  const name = event.pkg.name.trim() === '' ? event.pkg.packageId : event.pkg.name.trim();
  return Array.from(name).slice(0, DISCORD_THREAD_NAME_MAX).join('');
}

function threadOrChannel(target: SendTarget): string {
  if (target.kind === 'bot') return target.threadId ? target.threadId : target.channelId;
  return '';
}

function messageRecord(drain: Drain, event: ModEvent, messageId: string, channelId: string): MessageRecord {
  return {
    messageId,
    channelId,
    source: event.pkg.source,
    packageId: event.pkg.packageId,
    eventId: event.id,
    createdAt: drain.deps.now.toISOString(),
  };
}

/** A failed map write only costs a later duplicate post; the message itself exists. */
async function writeMapping(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch {
    console.warn('outbox mapping write failed');
  }
}

function isFreshThread(threadId: string, createdAt: string | undefined, now: Date): boolean {
  const fresh = (ageMs: number): boolean => ageMs >= 0 && ageMs < THREAD_FRESH_MS;
  if (createdAt !== undefined && fresh(now.getTime() - Date.parse(createdAt))) return true;
  return /^\d{17,20}$/.test(threadId) && fresh(now.getTime() - (Number(BigInt(threadId) >> 22n) + DISCORD_EPOCH_MS));
}

/** A `gone` answer for a thread created moments ago becomes a retryable failure with backoff. */
function softenFreshGone(drain: Drain, target: SendTarget, failure: SendFailure, createdAt?: string): SendFailure {
  const { result } = failure;
  if (result.retryable || result.gone !== true || target.kind !== 'bot' || !target.threadId) return failure;
  if (!isFreshThread(target.threadId, createdAt, drain.deps.now)) return failure;
  return { result: { ok: false, retryable: true, retryAfterSeconds: null, status: result.status }, attempted: failure.attempted };
}

/**
 * Immediate delivery of a `thread_per_mod` bot subscription: `mod_threads` decides between a forum post, a plain
 * message that becomes the anchor, a thread opened on the anchor, or a message into the mod's thread. A thread that is
 * gone resets its mapping and the row is sent again as a new post or message, in this tick when the allowance
 * covers it, otherwise on the next one without spending an attempt.
 */
async function deliverRouted(drain: Drain, sub: Subscription, target: BotTarget, entry: CollapsedDelivery, message: DiscordMessage): Promise<void> {
  const { store, now } = drain.deps;
  const event = entry.delivery.event;
  const key = targetKey(target);
  const kind = sub.channelKind ?? 'text';
  const ids = entry.rows.map((row) => row.id);
  let thread = await store.getModThread(target.channelId, event.pkg.source, event.pkg.packageId);
  for (let pass = 0; ; pass += 1) {
    const route = planRoute(kind, thread);
    if (allowance(drain, key) < route.cost) {
      drain.report.deferred += ids.length;
      if (pass > 0) {
        await store.rescheduleRows(ids, now.toISOString());
        for (const id of ids) drain.settled.add(id);
      }
      return;
    }
    const outcome = await runRoute(drain, target, event, message, route, thread);
    if (outcome.ok) {
      await markDelivered(drain, ids);
      return;
    }
    if (outcome.reset && pass === 0) {
      await writeMapping(() => store.deleteModThread(target.channelId, event.pkg.source, event.pkg.packageId));
      console.warn('outbox thread gone: mapping reset');
      drain.report.failed -= 1;
      thread = null;
      continue;
    }
    const { failure } = outcome;
    await failRows(drain, entry.rows, failure, failure.result.retryable && failure.attempted ? key : undefined);
    return;
  }
}

/** Opens the mod's thread on the message just sent; '' when it fails, leaving the anchor for the next delivery. */
async function openThreadOn(drain: Drain, target: BotTarget, event: ModEvent, messageId: string): Promise<string> {
  const { sender } = drain.deps;
  const opened = await request<OpenThreadResult>(drain, targetKey(target), () => sender.openThreadOnMessage?.(target.channelId, messageId, threadName(event)) ?? Promise.resolve(UNSUPPORTED));
  if (opened.result.ok) return opened.result.threadId;
  return !opened.result.retryable && opened.result.threadExists === true ? messageId : '';
}

async function runRoute(
  drain: Drain,
  target: BotTarget,
  event: ModEvent,
  message: DiscordMessage,
  route: Route,
  thread: ModThread | null,
): Promise<RouteOutcome> {
  const { sender, store, now } = drain.deps;
  const key = targetKey(target);
  const { channelId } = target;
  const nowIso = now.toISOString();
  const { source, packageId } = event.pkg;
  const fail = (failure: SendFailure, reset = false): RouteOutcome => {
    drain.report.failed += 1;
    if (failure.result.retryable) drain.blocked.add(key);
    return { ok: false, failure, reset };
  };

  if (route.op === 'post') {
    const res = await request<ForumPostResult>(drain, key, () => sender.createForumPost?.(channelId, threadName(event), message) ?? Promise.resolve(UNSUPPORTED));
    if (!res.result.ok) return fail({ result: res.result, attempted: res.attempted });
    drain.report.sent += 1;
    const { threadId, messageId } = res.result;
    await writeMapping(() => store.putModThread({ channelId, source, packageId, threadId, anchorMessageId: null, createdAt: nowIso }));
    await writeMapping(() => store.putMessage(messageRecord(drain, event, messageId, threadId)));
    return { ok: true };
  }

  if (route.op === 'message') {
    const res = await request<SendResult>(drain, key, () => sender.send({ kind: 'bot', channelId, threadId: null }, message));
    if (!res.result.ok) return fail({ result: res.result, attempted: res.attempted });
    drain.report.sent += 1;
    const landed = res.result;
    const messageId = landed.messageId;
    if (messageId !== undefined) {
      const threadId = allowance(drain, key) >= 1 ? await openThreadOn(drain, target, event, messageId) : '';
      await writeMapping(() => store.putModThread({ channelId, source, packageId, threadId, anchorMessageId: messageId, createdAt: nowIso }));
      await writeMapping(() => store.putMessage(messageRecord(drain, event, messageId, landed.channelId ?? channelId)));
    }
    return { ok: true };
  }

  let threadId: string;
  let createdAt = thread?.createdAt;
  if (route.op === 'open') {
    const { anchorMessageId } = route;
    const opened = await request<OpenThreadResult>(drain, key, () => sender.openThreadOnMessage?.(channelId, anchorMessageId, threadName(event)) ?? Promise.resolve(UNSUPPORTED));
    if (opened.result.ok) threadId = opened.result.threadId;
    else if (!opened.result.retryable && opened.result.threadExists === true) threadId = anchorMessageId;
    else return fail({ result: opened.result, attempted: opened.attempted }, !opened.result.retryable && opened.result.gone === true);
    createdAt = nowIso;
    const openedId = threadId;
    await writeMapping(() => store.putModThread({ channelId, source, packageId, threadId: openedId, anchorMessageId, createdAt: nowIso }));
  } else {
    threadId = route.threadId;
  }

  const into: BotTarget = { kind: 'bot', channelId, threadId };
  const res = await request<SendResult>(drain, key, () => sender.send(into, message));
  if (!res.result.ok) {
    const failure = softenFreshGone(drain, into, { result: res.result, attempted: res.attempted }, createdAt);
    return fail(failure, route.op === 'thread' && !failure.result.retryable && failure.result.gone === true);
  }
  drain.report.sent += 1;
  const landed = res.result;
  const messageId = landed.messageId;
  if (messageId !== undefined) await writeMapping(() => store.putMessage(messageRecord(drain, event, messageId, landed.channelId ?? threadId)));
  return { ok: true };
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
