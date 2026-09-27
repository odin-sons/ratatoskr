// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runTick = vi.hoisted(() => vi.fn());
const runReconcile = vi.hoisted(() => vi.fn());

vi.mock('../core/tick.ts', () => ({ runTick, runReconcile }));
vi.mock('../sources/index.ts', () => ({ createAdapters: () => [] }));

import { CADENCE } from '../core/constants.ts';
import type { TickReport } from '../core/tick.ts';
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

async function run(cron: string, e: Env = env): Promise<void> {
  const { ctx, pending } = ctxWithSpy();
  await worker.scheduled(controller(cron), e, ctx);
  await Promise.all(pending);
}

const REPORT: TickReport = {
  sources: { 'thunderstore:valheim': { status: 'ok', events: 2 } },
  sent: 2,
  failed: 0,
  changelogFetches: 1,
  changelogSkipped: 0,
  deferred: 0,
  parked: 0,
  degraded: 0,
  filtered: 0,
  purged: 0,
  subrequests: 4,
};

let errors: string[];
let logs: string[];
let warns: string[];

beforeEach(() => {
  runTick.mockReset().mockResolvedValue(REPORT);
  runReconcile.mockReset().mockResolvedValue(REPORT);
  errors = [];
  logs = [];
  warns = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
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

  it('passes the number of reconcile crons so slice hints advance once per run', async () => {
    await run(RECONCILE_CRONS[0]);
    expect(runReconcile.mock.calls[0]![0].reconcileRunsPerDay).toBe(RECONCILE_CRONS.length);
    expect(RECONCILE_CRONS.length).toBe(CADENCE.reconcileRunsPerDay);
  });

  it('logs one structured line per tick run with the report and no secrets', async () => {
    await run(TICK_CRON);
    expect(logs).toHaveLength(1);
    const entry = JSON.parse(logs[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      event: 'run',
      cron: TICK_CRON,
      sent: 2,
      subrequests: 4,
      sources: { 'thunderstore:valheim': { status: 'ok', events: 2 } },
    });
    expect(typeof entry.elapsedMs).toBe('number');
    expect(logs[0]).not.toContain('nexus-secret-key');
  });

  it('logs one structured line per reconcile run', async () => {
    await run(RECONCILE_CRONS[2]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ event: 'run', cron: RECONCILE_CRONS[2] });
  });

  it('logs no run line for an unknown cron or a failed run', async () => {
    await run('1 2 3 4 5');
    runTick.mockRejectedValue(new Error('boom'));
    await run(TICK_CRON);
    expect(logs).toEqual([]);
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

  it('keeps urls out of the failure log', async () => {
    runTick.mockRejectedValue(new Error('POST https://discord.com/api/webhooks/1/SecretToken failed'));
    await run(TICK_CRON);
    expect(errors[0]).not.toContain('SecretToken');
  });

  it('swallows a non-Error rejection from reconcile', async () => {
    runReconcile.mockRejectedValue('string failure');
    await expect(run(RECONCILE_CRONS[1])).resolves.toBeUndefined();
    expect(errors[0]).toContain('string failure');
  });

  it('keeps every reconcile cron off the tick grid so the two never run concurrently', () => {
    const tickMinutes = Number(/^\*\/(\d+) /.exec(TICK_CRON)![1]);
    expect(tickMinutes).toBe(CADENCE.tickMinutes);
    for (const cron of RECONCILE_CRONS) {
      const minute = cron.split(' ')[0]!;
      expect(minute).toMatch(/^\d+$/);
      expect(Number(minute) % tickMinutes).not.toBe(0);
    }
  });

  describe('STORE_EMOJIS', () => {
    const TS = '<:thunderstore:123456789012345678>';
    const HX = '<:hexium:123456789012345679>';

    it('reaches the tick and reconcile deps from an object setting', async () => {
      await run(TICK_CRON, { ...env, STORE_EMOJIS: { thunderstore: TS, hexium: HX } });
      await run(RECONCILE_CRONS[0], { ...env, STORE_EMOJIS: { thunderstore: TS } });
      expect(runTick.mock.calls[0]![0].storeEmojis).toEqual({ thunderstore: TS, hexium: HX });
      expect(runReconcile.mock.calls[0]![0].storeEmojis).toEqual({ thunderstore: TS });
      expect(warns).toEqual([]);
    });

    it('accepts a JSON string setting', async () => {
      await run(TICK_CRON, { ...env, STORE_EMOJIS: JSON.stringify({ nexus: '<a:nexus:123456789012345680>' }) });
      expect(runTick.mock.calls[0]![0].storeEmojis).toEqual({ nexus: '<a:nexus:123456789012345680>' });
    });

    it('means no emoji when absent or empty, without a warning', async () => {
      await run(TICK_CRON);
      await run(TICK_CRON, { ...env, STORE_EMOJIS: {} });
      expect(runTick.mock.calls.map((c) => c[0].storeEmojis)).toEqual([{}, {}]);
      expect(warns).toEqual([]);
    });

    it('ignores invalid entries with one warning naming only the key and still runs', async () => {
      await run(TICK_CRON, { ...env, STORE_EMOJIS: { thunderstore: TS, hexium: ':hexium:' } });
      expect(runTick).toHaveBeenCalledTimes(1);
      expect(runTick.mock.calls[0]![0].storeEmojis).toEqual({ thunderstore: TS });
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('hexium');
      expect(warns[0]).not.toContain(':hexium:');
    });

    it('survives an unparsable setting', async () => {
      await run(TICK_CRON, { ...env, STORE_EMOJIS: '{oops' });
      expect(runTick).toHaveBeenCalledTimes(1);
      expect(runTick.mock.calls[0]![0].storeEmojis).toEqual({});
      expect(warns).toHaveLength(1);
      expect(errors).toEqual([]);
    });
  });

  describe('RATATOSKR_EMOJI', () => {
    const RT = '<:ratatoskr:123456789012345681>';

    it('reaches the tick and reconcile deps', async () => {
      await run(TICK_CRON, { ...env, RATATOSKR_EMOJI: RT });
      await run(RECONCILE_CRONS[0], { ...env, RATATOSKR_EMOJI: RT });
      expect(runTick.mock.calls[0]![0].ratatoskrEmoji).toBe(RT);
      expect(runReconcile.mock.calls[0]![0].ratatoskrEmoji).toBe(RT);
      expect(warns).toEqual([]);
    });

    it('means no emoji when absent or empty, without a warning', async () => {
      await run(TICK_CRON);
      await run(TICK_CRON, { ...env, RATATOSKR_EMOJI: '' });
      expect(runTick.mock.calls.map((c) => c[0].ratatoskrEmoji)).toEqual([undefined, undefined]);
      expect(warns).toEqual([]);
    });

    it('ignores an invalid value with one warning naming only the key and still runs', async () => {
      await run(TICK_CRON, { ...env, RATATOSKR_EMOJI: ':ratatoskr: https://evil.example/x' });
      expect(runTick).toHaveBeenCalledTimes(1);
      expect(runTick.mock.calls[0]![0].ratatoskrEmoji).toBeUndefined();
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('RATATOSKR_EMOJI');
      expect(warns[0]).not.toContain('evil');
    });
  });

  describe('LANGUAGE', () => {
    it('reaches the tick and reconcile deps', async () => {
      await run(TICK_CRON, { ...env, LANGUAGE: 'ru' });
      await run(RECONCILE_CRONS[0], { ...env, LANGUAGE: 'ru' });
      expect(runTick.mock.calls[0]![0].locale).toBe('ru');
      expect(runReconcile.mock.calls[0]![0].locale).toBe('ru');
      expect(warns).toEqual([]);
    });

    it('defaults to en when absent or empty, without a warning', async () => {
      await run(TICK_CRON);
      await run(TICK_CRON, { ...env, LANGUAGE: '' });
      expect(runTick.mock.calls.map((c) => c[0].locale)).toEqual(['en', 'en']);
      expect(warns).toEqual([]);
    });

    it('falls back to en for an unknown value with one warning naming only the key', async () => {
      await run(TICK_CRON, { ...env, LANGUAGE: 'klingon-secret' });
      expect(runTick).toHaveBeenCalledTimes(1);
      expect(runTick.mock.calls[0]![0].locale).toBe('en');
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('LANGUAGE');
      expect(warns[0]).not.toContain('klingon');
    });
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

  it('ships wrangler.jsonc with the default language and no source-button emoji', () => {
    const raw = readFileSync(join(import.meta.dirname, '../../wrangler.jsonc'), 'utf8');
    const json = raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const wrangler = JSON.parse(json) as { vars?: Record<string, unknown> };
    expect(wrangler.vars?.LANGUAGE).toBe('en');
    expect(wrangler.vars?.RATATOSKR_EMOJI ?? '').toBe('');
  });

  it('ships wrangler.jsonc with an empty STORE_EMOJIS var: real emoji ids are operator configuration', () => {
    const raw = readFileSync(join(import.meta.dirname, '../../wrangler.jsonc'), 'utf8');
    const json = raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const wrangler = JSON.parse(json) as { vars?: Record<string, unknown> };
    expect(wrangler.vars?.STORE_EMOJIS).toEqual({});
    expect(raw).not.toMatch(/<a?:\w+:\d+>/);
  });
});
