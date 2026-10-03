// SPDX-License-Identifier: AGPL-3.0-or-later
import { renderDigest, renderImmediate } from '../render/index.ts';
import { raiseCapAlerts, type SourceCapUsage } from './alerts.ts';
import { SubrequestBudget } from './budget.ts';
import { maybeSendWeeklyReport } from './weekly.ts';
import { readDegradation, runUsageMonitor } from './usage-monitor.ts';
import {
  CADENCE,
  CLOUDFLARE,
  DEGRADATION,
  DELIVERED_RETENTION_DAYS,
  MS_PER_DAY,
  OUTBOX_PURGE_BATCH,
  SOURCE_STATE_REFRESH_MS,
  SUBREQUEST_SEND_RESERVE,
  TICK_BUDGET,
} from './constants.ts';
import { dedupeSnapshots, diffSnapshots } from './diff.ts';
import { drainOutbox, type Renderer } from './drain.ts';
import { compileFilter } from './filter.ts';
import { fanOut, type CompiledSubscription } from './fanout.ts';
import type { Clock, PollContext, Sender, SourceAdapter, Store, UsageReader } from './ports.ts';
import { sanitizeLogText } from './report.ts';
import type { Language } from '../i18n/index.ts';
import type { AppConfig, CapUsage, ModEvent, PackageSnapshot, SourceId, SourceState, StoreEmojis } from './types.ts';

export type { Renderer } from './drain.ts';

export interface TickDeps {
  store: Store;
  sender: Sender;
  adapters: SourceAdapter[];
  config: AppConfig;
  secrets: Record<string, string | undefined>;
  fetch: typeof fetch;
  clock: Clock;
  /** Defaults to the real renderer; tests inject a stub. */
  renderer?: Renderer;
  /** Custom emoji markup per store, used when rendering messages. */
  storeEmojis?: StoreEmojis;
  /** Custom emoji markup for the source subtext link, used when rendering messages. */
  ratatoskrEmoji?: string;
  /** Language of every rendered message. */
  locale?: Language;
  /** Reconcile cron triggers per day; defaults to `CADENCE.reconcileRunsPerDay`. */
  reconcileRunsPerDay?: number;
  /** Webhook of the alert channel; without it limit alerts are not sent. */
  alertWebhookUrl?: string;
  /** Reads D1 usage from the analytics API; without it the usage monitor, its degradation steps and the weekly report are off. */
  usage?: UsageReader;
}

export interface SourceReport {
  /** `ok`, `cold-start`, `not-modified`, `skipped`, `deferred`, `disabled` or `error`. */
  status: string;
  events: number;
  error?: string;
  /** Adapter-reported degradations of an otherwise successful poll. */
  warnings?: string[];
}

export interface TickReport {
  sources: Record<SourceId, SourceReport>;
  sent: number;
  failed: number;
  changelogFetches: number;
  /** Changelog jobs dropped because of a cap or the subrequest budget. They are not retried. */
  changelogSkipped: number;
  /** Work that runs later: sources not polled this tick and outbox rows not attempted. */
  deferred: number;
  /** Outbox rows parked in this run. */
  parked: number;
  /** Immediate messages delivered only after Discord rejected them with 400 and they were resent without their optional buttons. */
  degraded: number;
  /** Due rows no longer matching their subscription's filter; marked delivered without sending. */
  filtered: number;
  /** Delivered outbox rows deleted by a reconcile run. */
  purged: number;
  /** The D1 usage degradation step that applied to this run, 0 when none. */
  usageStep: number;
  /** Limit alerts and weekly reports sent to the alert channel. */
  alerts: number;
  /** Limit alerts Discord refused; they are tried again on the next run. */
  alertsFailed: number;
  /** Subrequests spent: source fetches, changelog fetches, Discord sends and alerts. */
  subrequests: number;
  drainError?: string;
}

const defaultRenderer: Renderer = { renderDigest, renderImmediate };

const TICK_MS = CADENCE.tickMinutes * 60_000;

interface ChangelogJob {
  adapter: SourceAdapter;
  ctx: PollContext;
  event: ModEvent;
}

interface SourceOutcome {
  report: SourceReport;
  jobs: ChangelogJob[];
  fetched: boolean;
  capUsage?: CapUsage[];
}

interface Run {
  deps: TickDeps;
  budget: SubrequestBudget;
  now: Date;
  nowIso: string;
  tickIndex: number;
  sliceHint: number | undefined;
  subs: CompiledSubscription[];
  degradation: number;
}

export async function runTick(deps: TickDeps, scheduledTimeMs: number): Promise<TickReport> {
  const report = newReport();
  const budget = new SubrequestBudget();
  const run = await startRun(deps, budget, scheduledTimeMs, undefined, report);
  const enabled = deps.adapters.filter((a) => {
    if (a.config.enabled) return true;
    report.sources[a.config.id] = { status: 'disabled', events: 0 };
    return false;
  });
  const jobs: ChangelogJob[] = [];
  const usages: SourceCapUsage[] = [];

  if (run !== null) {
    const monitor = await runUsageMonitor({ store: deps.store, reader: deps.usage, budget, now: run.now, tickIndex: run.tickIndex });
    run.degradation = monitor.degradation;
    report.usageStep = monitor.degradation;
    usages.push(...monitor.usages);
    let fetches = 0;
    for (const adapter of rotate(enabled, run.tickIndex)) {
      const id = adapter.config.id;
      if (fetches >= TICK_BUDGET.maxListingFetches || budget.remaining <= 0) {
        report.sources[id] = { status: 'deferred', events: 0 };
        report.deferred += 1;
        continue;
      }
      const outcome = await guarded(run, adapter, 'tick');
      report.sources[id] = outcome.report;
      if (outcome.fetched) fetches += 1;
      jobs.push(...outcome.jobs);
      for (const usage of outcome.capUsage ?? []) usages.push({ source: id, usage });
    }
  }
  return finish(deps, budget, report, jobs, run?.now ?? deps.clock.now(), usages, run?.degradation ?? 0);
}

export async function runReconcile(deps: TickDeps, scheduledTimeMs: number, reconcileIndex: number): Promise<TickReport> {
  const report = newReport();
  const budget = new SubrequestBudget();
  const runsPerDay = deps.reconcileRunsPerDay ?? CADENCE.reconcileRunsPerDay;
  const sliceHint = Math.floor(scheduledTimeMs / MS_PER_DAY) * runsPerDay + reconcileIndex;
  const run = await startRun(deps, budget, scheduledTimeMs, sliceHint, report);
  const candidates = deps.adapters.filter((a) => a.config.enabled && a.reconcile !== undefined);
  const jobs: ChangelogJob[] = [];
  const degradation = run === null ? 0 : await readDegradation(deps.store, deps.usage, run.now);
  report.usageStep = degradation;
  const paused = degradation >= DEGRADATION.pauseExtrasFrom;
  if (run !== null) await sendWeeklyReport(deps, budget, report, scheduledTimeMs, degradation, run.now);

  if (run !== null && candidates.length > 0 && !paused) {
    run.degradation = degradation;
    const adapter = candidates[((reconcileIndex % candidates.length) + candidates.length) % candidates.length]!;
    const outcome = await guarded(run, adapter, 'reconcile');
    report.sources[adapter.config.id] = outcome.report;
    jobs.push(...outcome.jobs);
  }
  const now = run?.now ?? deps.clock.now();
  await finish(deps, budget, report, jobs, now, [], degradation);
  if (!paused) report.purged = await purgeDelivered(deps, now);
  return report;
}

async function sendWeeklyReport(
  deps: TickDeps,
  budget: SubrequestBudget,
  report: TickReport,
  scheduledTimeMs: number,
  degradation: number,
  now: Date,
): Promise<void> {
  try {
    const sent = await maybeSendWeeklyReport({
      store: deps.store,
      sender: deps.sender,
      reader: deps.usage,
      webhookUrl: deps.alertWebhookUrl,
      budget,
      now,
      scheduledTimeMs,
      degradation,
    });
    if (sent) report.alerts += 1;
  } catch (err) {
    console.warn(`weekly report failed: ${sanitizeLogText(errorMessage(err))}`);
  }
}

function newReport(): TickReport {
  return {
    sources: {},
    sent: 0,
    failed: 0,
    changelogFetches: 0,
    changelogSkipped: 0,
    deferred: 0,
    parked: 0,
    degraded: 0,
    filtered: 0,
    purged: 0,
    usageStep: 0,
    alerts: 0,
    alertsFailed: 0,
    subrequests: 0,
  };
}

async function purgeDelivered(deps: TickDeps, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - DELIVERED_RETENTION_DAYS * MS_PER_DAY).toISOString();
  try {
    return await deps.store.purgeDelivered(cutoff, OUTBOX_PURGE_BATCH);
  } catch (err) {
    console.warn(`purge of delivered outbox rows failed: ${sanitizeLogText(errorMessage(err))}`);
    return 0;
  }
}

async function startRun(
  deps: TickDeps,
  budget: SubrequestBudget,
  scheduledTimeMs: number,
  sliceHint: number | undefined,
  report: TickReport,
): Promise<Run | null> {
  const now = deps.clock.now();
  try {
    const subs = (await deps.store.listSubscriptions())
      .filter((s) => s.enabled)
      .map((sub) => ({ sub, filter: compileFilter(sub.filter) }));
    return { deps, budget, now, nowIso: now.toISOString(), tickIndex: Math.floor(scheduledTimeMs / TICK_MS), sliceHint, subs, degradation: 0 };
  } catch (err) {
    report.drainError = `listSubscriptions failed: ${errorMessage(err)}`;
    for (const a of deps.adapters) {
      report.sources[a.config.id] = { status: 'error', events: 0, error: report.drainError };
    }
    return null;
  }
}

async function finish(
  deps: TickDeps,
  budget: SubrequestBudget,
  report: TickReport,
  jobs: ChangelogJob[],
  now: Date,
  usages: SourceCapUsage[] = [],
  degradation = 0,
): Promise<TickReport> {
  await raiseAlerts(deps, budget, report, usages, now);
  await fetchChangelogs(deps, budget, jobs, report, degradation);
  const drained = await drainOutbox({
    store: deps.store,
    sender: deps.sender,
    renderer: deps.renderer ?? defaultRenderer,
    ...(deps.storeEmojis === undefined ? {} : { storeEmojis: deps.storeEmojis }),
    ...(deps.ratatoskrEmoji === undefined ? {} : { ratatoskrEmoji: deps.ratatoskrEmoji }),
    ...(deps.locale === undefined ? {} : { locale: deps.locale }),
    now,
    budget,
  });
  report.sent += drained.sent;
  report.failed += drained.failed;
  report.deferred += drained.deferred;
  report.parked += drained.parked;
  report.degraded += drained.degraded;
  report.filtered += drained.filtered;
  report.subrequests = budget.used;
  if (drained.error !== undefined) report.drainError ??= drained.error;
  return report;
}

async function raiseAlerts(deps: TickDeps, budget: SubrequestBudget, report: TickReport, usages: SourceCapUsage[], now: Date): Promise<void> {
  try {
    const result = await raiseCapAlerts({ store: deps.store, sender: deps.sender, webhookUrl: deps.alertWebhookUrl, budget, usages, now });
    report.alerts += result.sent;
    report.alertsFailed += result.failed;
  } catch (err) {
    console.warn(`limit alerts failed: ${sanitizeLogText(errorMessage(err))}`);
  }
}

async function guarded(run: Run, adapter: SourceAdapter, kind: 'tick' | 'reconcile'): Promise<SourceOutcome> {
  try {
    return await processSource(run, adapter, kind);
  } catch (err) {
    return { report: { status: 'error', events: 0, error: errorMessage(err) }, jobs: [], fetched: true };
  }
}

/** True when `next` moves neither the cursor nor `bootstrapped` and `prev` was written less than `SOURCE_STATE_REFRESH_MS` ago. */
function isRedundantStateWrite(prev: SourceState | null, next: SourceState, nowMs: number): boolean {
  if (prev === null || !prev.bootstrapped || !next.bootstrapped || prev.cursor !== next.cursor) return false;
  if (prev.etag === next.etag && prev.lastOkAt === next.lastOkAt) return true;
  const writtenAt = prev.lastOkAt === null ? Number.NaN : Date.parse(prev.lastOkAt);
  return nowMs - writtenAt < SOURCE_STATE_REFRESH_MS;
}

async function processSource(run: Run, adapter: SourceAdapter, kind: 'tick' | 'reconcile'): Promise<SourceOutcome> {
  const { deps, now, nowIso } = run;
  const { store } = deps;
  const id = adapter.config.id;
  const state = await store.getSourceState(id);
  const ctx: PollContext = {
    fetch: run.budget.wrapFetch(deps.fetch),
    userAgent: deps.config.userAgent,
    state,
    tickIndex: run.tickIndex,
    now,
    secrets: deps.secrets,
    ...(run.sliceHint === undefined ? {} : { sliceHint: run.sliceHint }),
    ...(run.degradation === 0 ? {} : { degradation: run.degradation }),
  };

  if (kind === 'reconcile' && (state === null || !state.bootstrapped)) {
    return { report: { status: 'skipped', events: 0 }, jobs: [], fetched: false };
  }

  let snapshots: PackageSnapshot[];
  let cursor: string | null;
  let etag: string | null;
  let complete = true;
  let warned: Pick<SourceReport, 'warnings'> = {};
  let capUsage: CapUsage[] = [];
  if (kind === 'tick') {
    const result = await adapter.poll(ctx);
    if (result.status === 'skipped') return { report: { status: 'skipped', events: 0 }, jobs: [], fetched: false };
    if (result.status === 'not-modified') {
      if (state !== null) {
        const touched = { ...state, etag: result.etag ?? state.etag, lastOkAt: nowIso };
        if (!isRedundantStateWrite(state, touched, now.getTime())) await store.touchSource(touched);
      }
      return { report: { status: 'not-modified', events: 0 }, jobs: [], fetched: true };
    }
    snapshots = result.packages;
    cursor = result.cursor;
    etag = result.etag;
    complete = result.complete;
    if (result.warnings !== undefined && result.warnings.length > 0) warned = { warnings: result.warnings };
    capUsage = result.capUsage ?? [];
  } else {
    snapshots = await adapter.reconcile!(ctx);
    cursor = state?.cursor ?? null;
    etag = state?.etag ?? null;
  }

  const coldStart = state === null || !state.bootstrapped;
  const nextState: SourceState = {
    id,
    cursor,
    etag,
    bootstrapped: coldStart ? complete : true,
    lastOkAt: kind === 'tick' ? nowIso : (state?.lastOkAt ?? null),
  };

  if (coldStart) {
    await store.commit({ source: id, packages: dedupeSnapshots(snapshots), events: [], outbox: [], state: nextState });
    return { report: { status: 'cold-start', events: 0, ...warned }, jobs: [], fetched: true };
  }

  const known =
    kind === 'reconcile'
      ? await store.getAllKnownVersions(id)
      : snapshots.length === 0
        ? new Map<string, string>()
        : await store.getKnownVersions(id, [...new Set(snapshots.map((s) => s.packageId))]);
  const { events: detected } = diffSnapshots(known, snapshots, now);
  if (detected.length === 0 && isRedundantStateWrite(state, nextState, now.getTime())) {
    return { report: { status: 'ok', events: 0, ...warned }, jobs: [], fetched: true, capUsage };
  }
  const seen = detected.length === 0 ? new Set<string>() : await store.existingEventIds(detected.map((e) => e.id));
  const events = seen.size === 0 ? detected : detected.filter((e) => !seen.has(e.id));
  const { rows, detailedEventIds } = await fanOut(events, run.subs, store, now);
  await store.commit({ source: id, packages: detected.map((e) => e.pkg), events, outbox: rows, state: nextState });

  const jobs = events.filter((e) => detailedEventIds.has(e.id)).map((event) => ({ adapter, ctx, event }));
  return { report: { status: 'ok', events: events.length, ...warned }, jobs, fetched: true, capUsage };
}

async function fetchChangelogs(deps: TickDeps, budget: SubrequestBudget, jobs: ChangelogJob[], report: TickReport, degradation: number): Promise<void> {
  if (degradation >= DEGRADATION.pauseExtrasFrom) {
    report.changelogSkipped += jobs.length;
    return;
  }
  const selected = selectDetailJobs(jobs, budget.remaining - SUBREQUEST_SEND_RESERVE);
  report.changelogSkipped += jobs.length - selected.length;
  report.changelogFetches += selected.length;
  const changelogFetch = budget.wrapFetch(deps.fetch, SUBREQUEST_SEND_RESERVE);
  for (let i = 0; i < selected.length; i += CLOUDFLARE.simultaneousConnections) {
    await Promise.all(
      selected.slice(i, i + CLOUDFLARE.simultaneousConnections).map(async ({ adapter, ctx, event }) => {
        try {
          const { excerpt, url, websiteUrl } = await adapter.fetchChangelog({ ...ctx, fetch: changelogFetch }, event.pkg, event.versionTo);
          const website = websiteUrl ?? null;
          // A new package has no prior version to change from: keep the website this call may have found, but never its changelog.
          const isNew = event.kind === 'new';
          const changelog = isNew ? null : excerpt;
          const changelogUrl = isNew ? null : url;
          if (changelog !== null || changelogUrl !== null || website !== null) {
            await deps.store.setEventDetails(event.id, { changelog, changelogUrl, websiteUrl: website });
          }
        } catch {
          // Ignored: missing details never block delivery.
        }
      }),
    );
  }
}

/** In order, at most `maxChangelogFetches` jobs whose declared requests all fit in `spendable`; O(jobs). */
function selectDetailJobs(jobs: ChangelogJob[], spendable: number): ChangelogJob[] {
  const selected: ChangelogJob[] = [];
  let left = spendable;
  for (const job of jobs) {
    if (selected.length >= TICK_BUDGET.maxChangelogFetches) break;
    const cost = job.adapter.detailRequests ?? 1;
    if (cost > left) continue;
    left -= cost;
    selected.push(job);
  }
  return selected;
}

function rotate<T>(items: T[], index: number): T[] {
  if (items.length <= TICK_BUDGET.maxListingFetches) return items;
  const start = index % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
