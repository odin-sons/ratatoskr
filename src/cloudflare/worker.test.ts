// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runTick = vi.hoisted(() => vi.fn());
const runReconcile = vi.hoisted(() => vi.fn());

vi.mock('../core/tick.ts', () => ({ runTick, runReconcile }));
vi.mock('../sources/index.ts', () => ({ createAdapters: () => [] }));

import { RECONCILE_CRONS, TICK_CRON } from './crons.ts';
import worker, { type Env } from './worker.ts';

const env = { DB: {} as D1Database, NEXUS_API_KEY: 'nexus-secret-key' } satisfies Env;

function controller(cron: string, scheduledTime = 1_800_000_000_000): ScheduledController {
  return { cron, scheduledTime, type: 'scheduled', noRetry: () => {} } as ScheduledController;
}

function ctxWithSpy(): { ctx: ExecutionContext; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
  return { ctx, pending };
}

async function run(cron: string): Promise<void> {
  const { ctx, pending } = ctxWithSpy();
  await worker.scheduled(controller(cron), env, ctx);
  await Promise.all(pending);
}

let errors: string[];

beforeEach(() => {
  runTick.mockReset();
  runReconcile.mockReset();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worker', () => {
  it('exposes only scheduled (no fetch handler)', () => {
    expect(Object.keys(worker)).toEqual(['scheduled']);
  });

  it('routes the tick cron to runTick with deps built from env', async () => {
    await run(TICK_CRON);
    expect(runReconcile).not.toHaveBeenCalled();
    expect(runTick).toHaveBeenCalledTimes(1);
    const [deps, scheduledTime] = runTick.mock.calls[0]!;
    expect(scheduledTime).toBe(1_800_000_000_000);
    expect(deps.secrets).toEqual({ NEXUS_API_KEY: 'nexus-secret-key' });
    expect(typeof deps.store.commit).toBe('function');
    expect(typeof deps.sender.send).toBe('function');
    expect(Array.isArray(deps.adapters)).toBe(true);
    expect(deps.config.sources).toBeDefined();
    expect(typeof deps.fetch).toBe('function');
    expect(deps.clock.now()).toBeInstanceOf(Date);
  });

  it.each(RECONCILE_CRONS.map((cron, i) => [cron, i] as const))('routes %s to runReconcile(%i)', async (cron, index) => {
    await run(cron);
    expect(runTick).not.toHaveBeenCalled();
    expect(runReconcile).toHaveBeenCalledTimes(1);
    expect(runReconcile.mock.calls[0]![1]).toBe(1_800_000_000_000);
    expect(runReconcile.mock.calls[0]![2]).toBe(index);
  });

  it('logs and ignores an unknown cron', async () => {
    await run('1 2 3 4 5');
    expect(runTick).not.toHaveBeenCalled();
    expect(runReconcile).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });

  it('swallows and logs a failing tick without leaking secrets', async () => {
    runTick.mockRejectedValue(new Error('boom'));
    await expect(run(TICK_CRON)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('boom');
    expect(errors[0]).not.toContain('nexus-secret-key');
  });

  it('swallows a non-Error rejection from reconcile', async () => {
    runReconcile.mockRejectedValue('string failure');
    await expect(run(RECONCILE_CRONS[1])).resolves.toBeUndefined();
    expect(errors[0]).toContain('string failure');
  });

  it('keeps wrangler.jsonc crons in sync with the code', () => {
    const raw = readFileSync(join(import.meta.dirname, '../../wrangler.jsonc'), 'utf8');
    const json = raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const wrangler = JSON.parse(json) as Record<string, unknown> & { triggers: { crons: string[] } };
    expect(wrangler.triggers.crons).toEqual([TICK_CRON, ...RECONCILE_CRONS]);
    expect(wrangler.main).toBe('src/cloudflare/worker.ts');
    expect(wrangler.workers_dev).toBe(false);
    expect(wrangler.preview_urls).toBe(false);
    expect(wrangler.routes).toBeUndefined();
  });
});
