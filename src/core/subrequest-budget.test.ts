// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FIXED_NOW_ISO, makeSnapshot, makeSubscription, okPoll } from '../testing/fakes.ts';
import { makeHarness, type Harness } from '../testing/harness.ts';
import { SUBREQUEST_LIMIT, SUBREQUEST_SEND_RESERVE, TICK_BUDGET } from './constants.ts';
import type { PollContext, PollResult, SourceAdapter } from './ports.ts';
import { runTick } from './tick.ts';
import type { PackageSnapshot, SourceConfig } from './types.ts';

const scheduled = Date.parse(FIXED_NOW_ISO);

/** Fires `pollFetches` requests per poll (swallowing refusals like the real adapters) and one per changelog. */
class BusyAdapter implements SourceAdapter {
  readonly config: SourceConfig;
  private results: PackageSnapshot[][] = [];
  changelogFetches = 0;

  constructor(
    id: string,
    private readonly pollFetches: number,
    private readonly changelogRequests = 1,
  ) {
    this.config = { id, store: 'thunderstore', community: 'valheim', enabled: true };
  }

  queue(packages: PackageSnapshot[]): this {
    this.results.push(packages);
    return this;
  }

  async poll(ctx: PollContext): Promise<PollResult> {
    for (let i = 0; i < this.pollFetches; i++) {
      try {
        await ctx.fetch(`https://${this.config.id.replace(':', '-')}.invalid/page/${i}`);
      } catch {
        // A refused secondary request is skipped like a network failure.
      }
    }
    const next = this.results.shift();
    return next === undefined ? { status: 'not-modified', etag: null } : okPoll(next);
  }

  async fetchChangelog(ctx: PollContext): Promise<{ excerpt: string | null; url: string | null }> {
    this.changelogFetches += 1;
    for (let i = 0; i < this.changelogRequests; i++) await ctx.fetch(`https://changelog.invalid/${i}`);
    return { excerpt: 'notes', url: null };
  }
}

function setup(adapters: BusyAdapter[], subscriptions = [makeSubscription()]): { h: Harness; network: { count: number } } {
  const h = makeHarness({ subscriptions });
  h.deps.adapters = adapters;
  h.deps.config = { ...h.deps.config, sources: adapters.map((a) => a.config) };
  const network = { count: 0 };
  h.deps.fetch = (async () => {
    network.count += 1;
    return new Response('ok');
  }) as typeof fetch;
  return { h, network };
}

const bootstrap = (h: Harness, source: string): void => {
  h.store.sources.set(source, { id: source, cursor: 'c0', etag: null, bootstrapped: true, lastOkAt: null });
};

const fresh = (n: number): PackageSnapshot[] =>
  Array.from({ length: n }, (_, i) => makeSnapshot({ packageId: `Owner${i}-Mod${i}`, owner: `Owner${i}`, name: `Mod${i}` }));

describe('runTick: shared subrequest budget', () => {
  it('never lets polls exceed the limit and defers the sources it cannot afford', async () => {
    const adapters = ['a', 'b', 'c'].map((n) => new BusyAdapter(`thunderstore:${n}`, 30));
    const { h, network } = setup(adapters);
    const report = await runTick(h.deps, scheduled);
    expect(network.count).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
    expect(report.subrequests).toBe(network.count);
    expect(report.deferred).toBeGreaterThanOrEqual(1);
    expect(Object.values(report.sources).filter((s) => s.status === 'deferred')).toHaveLength(report.deferred);
  });

  it('spends the budget in priority order and defers, rather than loses, the rest of the work', async () => {
    const adapter = new BusyAdapter('thunderstore:valheim', 20).queue(fresh(12));
    const subs = Array.from({ length: 10 }, (_, i) =>
      makeSubscription({ id: `s${i}`, webhookUrl: `https://discord.invalid/api/webhooks/${i}/t`, mode: 'immediate' }),
    );
    const { h, network } = setup([adapter], subs);
    bootstrap(h, 'thunderstore:valheim');

    const first = await runTick(h.deps, scheduled);
    expect(network.count + h.sender.calls.length).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
    expect(first.subrequests).toBe(network.count + h.sender.calls.length);
    expect(h.sender.calls.length).toBe(TICK_BUDGET.maxDiscordSends);
    expect(first.changelogFetches).toBeLessThan(TICK_BUDGET.maxChangelogFetches);
    expect(first.changelogFetches + first.changelogSkipped).toBe(12);
    expect(first.deferred).toBeGreaterThan(0);

    let ticks = 1;
    while (h.store.pendingRows().length > 0 && ticks < 40) {
      const report = await runTick(h.deps, scheduled + ticks * 300_000);
      expect(report.subrequests).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
      ticks += 1;
    }
    expect(h.store.pendingRows()).toEqual([]);
    const sends = h.sender.calls.map((c) => `${c.webhookUrl}|${c.payload.content}`);
    expect(sends).toHaveLength(10 * 12);
    expect(new Set(sends).size).toBe(10 * 12);
  });

  it('changelog fetches leave the send reserve untouched even when each one makes many requests', async () => {
    const adapter = new BusyAdapter('thunderstore:valheim', 0, 10).queue(fresh(12));
    const { h, network } = setup([adapter]);
    bootstrap(h, 'thunderstore:valheim');
    const report = await runTick(h.deps, scheduled);
    expect(report.changelogFetches).toBe(TICK_BUDGET.maxChangelogFetches);
    expect(network.count).toBeLessThanOrEqual(SUBREQUEST_LIMIT - SUBREQUEST_SEND_RESERVE);
    expect(h.sender.calls.length).toBe(Math.min(12, 5));
  });

  it('an adapter that fires far more requests than the budget cannot exceed it', async () => {
    const adapter = new BusyAdapter('thunderstore:valheim', 500);
    const { h, network } = setup([adapter]);
    await runTick(h.deps, scheduled);
    expect(network.count).toBe(SUBREQUEST_LIMIT);
  });
});
