// SPDX-License-Identifier: AGPL-3.0-or-later
import { renderDigest, renderImmediate } from '../render/index.ts';
import { CADENCE, CLOUDFLARE, TICK_BUDGET } from './constants.ts';
import { dedupeSnapshots, diffSnapshots } from './diff.ts';
import { drainOutbox, type Renderer } from './drain.ts';
import { compileFilter } from './filter.ts';
import { fanOut, type CompiledSubscription } from './fanout.ts';
import type { Clock, PollContext, Sender, SourceAdapter, Store } from './ports.ts';
import type { AppConfig, ModEvent, PackageSnapshot, SourceId, SourceState } from './types.ts';

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
}

export interface SourceReport {
  /** `ok`, `cold-start`, `not-modified`, `skipped`, `deferred`, `disabled` or `error`. */
  status: string;
  events: number;
  error?: string;
}

export interface TickReport {
  sources: Record<SourceId, SourceReport>;
  sent: number;
  failed: number;
  changelogFetches: number;
  /** Units of work left for the next tick: sources not polled, changelog fetches skipped, outbox rows not attempted. */
  deferred: number;
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
}

interface Run {
  deps: TickDeps;
  now: Date;
  nowIso: string;
  tickIndex: number;
  subs: CompiledSubscription[];
}

export async function runTick(deps: TickDeps, scheduledTimeMs: number): Promise<TickReport> {
  const report = newReport();
  const run = await startRun(deps, scheduledTimeMs, report);
  const enabled = deps.adapters.filter((a) => {
    if (a.config.enabled) return true;
    report.sources[a.config.id] = { status: 'disabled', events: 0 };
    return false;
  });
  const jobs: ChangelogJob[] = [];

  if (run !== null) {
    let fetches = 0;
    for (const adapter of rotate(enabled, run.tickIndex)) {
      const id = adapter.config.id;
      if (fetches >= TICK_BUDGET.maxListingFetches) {
        report.sources[id] = { status: 'deferred', events: 0 };
        report.deferred += 1;
        continue;
      }
      const outcome = await guarded(run, adapter, 'tick');
      report.sources[id] = outcome.report;
      if (outcome.fetched) fetches += 1;
      jobs.push(...outcome.jobs);
    }
  }
  return finish(deps, report, jobs, run?.now ?? deps.clock.now());
}

export async function runReconcile(deps: TickDeps, scheduledTimeMs: number, reconcileIndex: number): Promise<TickReport> {
  const report = newReport();
  const run = await startRun(deps, scheduledTimeMs, report);
  const candidates = deps.adapters.filter((a) => a.config.enabled && a.reconcile !== undefined);
  const jobs: ChangelogJob[] = [];

  if (run !== null && candidates.length > 0) {
    const adapter = candidates[((reconcileIndex % candidates.length) + candidates.length) % candidates.length]!;
    const outcome = await guarded(run, adapter, 'reconcile');
    report.sources[adapter.config.id] = outcome.report;
    jobs.push(...outcome.jobs);
  }
  return finish(deps, report, jobs, run?.now ?? deps.clock.now());
}

function newReport(): TickReport {
  return { sources: {}, sent: 0, failed: 0, changelogFetches: 0, deferred: 0 };
}

async function startRun(deps: TickDeps, scheduledTimeMs: number, report: TickReport): Promise<Run | null> {
  const now = deps.clock.now();
  try {
    const subs = (await deps.store.listSubscriptions())
      .filter((s) => s.enabled)
      .map((sub) => ({ sub, filter: compileFilter(sub.filter) }));
    return { deps, now, nowIso: now.toISOString(), tickIndex: Math.floor(scheduledTimeMs / TICK_MS), subs };
  } catch (err) {
    report.drainError = `listSubscriptions failed: ${errorMessage(err)}`;
    for (const a of deps.adapters) {
      report.sources[a.config.id] = { status: 'error', events: 0, error: report.drainError };
    }
    return null;
  }
}

async function finish(deps: TickDeps, report: TickReport, jobs: ChangelogJob[], now: Date): Promise<TickReport> {
  await fetchChangelogs(deps.store, jobs, report);
  const drained = await drainOutbox({
    store: deps.store,
    sender: deps.sender,
    renderer: deps.renderer ?? defaultRenderer,
    now,
  });
  report.sent += drained.sent;
  report.failed += drained.failed;
  report.deferred += drained.deferred;
  if (drained.error !== undefined) report.drainError ??= drained.error;
  return report;
}

async function guarded(run: Run, adapter: SourceAdapter, kind: 'tick' | 'reconcile'): Promise<SourceOutcome> {
  try {
    return await processSource(run, adapter, kind);
  } catch (err) {
    return { report: { status: 'error', events: 0, error: errorMessage(err) }, jobs: [], fetched: true };
  }
}

async function processSource(run: Run, adapter: SourceAdapter, kind: 'tick' | 'reconcile'): Promise<SourceOutcome> {
  const { deps, now, nowIso } = run;
  const { store } = deps;
  const id = adapter.config.id;
  const state = await store.getSourceState(id);
  const ctx: PollContext = {
    fetch: deps.fetch,
    userAgent: deps.config.userAgent,
    state,
    tickIndex: run.tickIndex,
    now,
    secrets: deps.secrets,
  };

  if (kind === 'reconcile' && (state === null || !state.bootstrapped)) {
    return { report: { status: 'skipped', events: 0 }, jobs: [], fetched: false };
  }

  let snapshots: PackageSnapshot[];
  let cursor: string | null;
  let etag: string | null;
  let complete = true;
  if (kind === 'tick') {
    const result = await adapter.poll(ctx);
    if (result.status === 'skipped') return { report: { status: 'skipped', events: 0 }, jobs: [], fetched: false };
    if (result.status === 'not-modified') {
      if (state !== null) await store.touchSource({ ...state, etag: result.etag ?? state.etag, lastOkAt: nowIso });
      return { report: { status: 'not-modified', events: 0 }, jobs: [], fetched: true };
    }
    snapshots = result.packages;
    cursor = result.cursor;
    etag = result.etag;
    complete = result.complete;
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
    return { report: { status: 'cold-start', events: 0 }, jobs: [], fetched: true };
  }

  const known =
    kind === 'reconcile'
      ? await store.getAllKnownVersions(id)
      : snapshots.length === 0
        ? new Map<string, string>()
        : await store.getKnownVersions(id, [...new Set(snapshots.map((s) => s.packageId))]);
  const { events } = diffSnapshots(known, snapshots, now);
  const { rows, detailedEventIds } = await fanOut(events, run.subs, store, now);
  await store.commit({ source: id, packages: events.map((e) => e.pkg), events, outbox: rows, state: nextState });

  const jobs = events.filter((e) => detailedEventIds.has(e.id)).map((event) => ({ adapter, ctx, event }));
  return { report: { status: 'ok', events: events.length }, jobs, fetched: true };
}

async function fetchChangelogs(store: Store, jobs: ChangelogJob[], report: TickReport): Promise<void> {
  const selected = jobs.slice(0, TICK_BUDGET.maxChangelogFetches);
  report.deferred += jobs.length - selected.length;
  report.changelogFetches += selected.length;
  for (let i = 0; i < selected.length; i += CLOUDFLARE.simultaneousConnections) {
    await Promise.all(
      selected.slice(i, i + CLOUDFLARE.simultaneousConnections).map(async ({ adapter, ctx, event }) => {
        try {
          const { excerpt, url } = await adapter.fetchChangelog(ctx, event.pkg, event.versionTo);
          if (excerpt !== null || url !== null) await store.setEventChangelog(event.id, excerpt, url);
        } catch {
          // Ignored: a missing changelog never blocks delivery.
        }
      }),
    );
  }
}

function rotate<T>(items: T[], index: number): T[] {
  if (items.length <= TICK_BUDGET.maxListingFetches) return items;
  const start = index % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
