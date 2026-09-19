// SPDX-License-Identifier: AGPL-3.0-or-later
import config from '../../ratatoskr.config.json';
import { runReconcile, runTick } from '../core/tick.ts';
import type { TickDeps } from '../core/tick.ts';
import type { AppConfig } from '../core/types.ts';
import { createAdapters } from '../sources/index.ts';
import { RECONCILE_CRONS, TICK_CRON } from './crons.ts';
import { D1Store } from './d1-store.ts';
import { DiscordSender } from './discord-sender.ts';

export interface Env {
  DB: D1Database;
  NEXUS_API_KEY?: string;
}

const MAX_LOGGED_MESSAGE_CHARS = 200;

function buildDeps(env: Env): TickDeps {
  const appConfig = config as AppConfig;
  const store = new D1Store(env.DB);
  return {
    store,
    sender: new DiscordSender(),
    adapters: createAdapters(appConfig, store),
    config: appConfig,
    secrets: { NEXUS_API_KEY: env.NEXUS_API_KEY },
    fetch: globalThis.fetch.bind(globalThis),
    clock: { now: () => new Date() },
  };
}

async function dispatch(controller: ScheduledController, env: Env): Promise<void> {
  const reconcileIndex = (RECONCILE_CRONS as readonly string[]).indexOf(controller.cron);
  if (controller.cron === TICK_CRON) {
    await runTick(buildDeps(env), controller.scheduledTime);
  } else if (reconcileIndex >= 0) {
    await runReconcile(buildDeps(env), controller.scheduledTime, reconcileIndex);
  } else {
    console.error(`unknown cron trigger: ${controller.cron}`);
  }
}

async function dispatchSafely(controller: ScheduledController, env: Env): Promise<void> {
  try {
    await dispatch(controller, env);
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`scheduled run failed (cron ${controller.cron}): ${message.slice(0, MAX_LOGGED_MESSAGE_CHARS)}`);
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatchSafely(controller, env));
  },
} satisfies ExportedHandler<Env>;
