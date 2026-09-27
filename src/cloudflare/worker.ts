// SPDX-License-Identifier: AGPL-3.0-or-later
import config from '../../ratatoskr.config.json';
import { formatRunLog, sanitizeLogText } from '../core/report.ts';
import { runReconcile, runTick } from '../core/tick.ts';
import type { TickDeps, TickReport } from '../core/tick.ts';
import type { AppConfig } from '../core/types.ts';
import { parseLanguage } from '../i18n/index.ts';
import { parseRatatoskrEmoji, parseStoreEmojis } from '../render/index.ts';
import { createAdapters } from '../sources/index.ts';
import { RECONCILE_CRONS, TICK_CRON } from './crons.ts';
import { D1Store } from './d1-store.ts';
import { DiscordSender } from './discord-sender.ts';

export interface Env {
  DB: D1Database;
  NEXUS_API_KEY?: string;
  /** Custom emoji per store: an object, or a JSON string of one, `{"thunderstore":"<:name:id>", ...}`. */
  STORE_EMOJIS?: string | Record<string, string>;
  /** Full custom emoji markup for the source button. */
  RATATOSKR_EMOJI?: string;
  /** Message language, a catalog name from `src/i18n`: `en` (default) or `ru`. */
  LANGUAGE?: string;
}

function buildDeps(env: Env): TickDeps {
  const appConfig = config as AppConfig;
  const store = new D1Store(env.DB);
  return {
    store,
    sender: new DiscordSender(),
    adapters: createAdapters(appConfig, store),
    config: appConfig,
    secrets: { NEXUS_API_KEY: env.NEXUS_API_KEY },
    storeEmojis: parseStoreEmojis(env.STORE_EMOJIS),
    ratatoskrEmoji: parseRatatoskrEmoji(env.RATATOSKR_EMOJI),
    locale: parseLanguage(env.LANGUAGE),
    fetch: globalThis.fetch.bind(globalThis),
    clock: { now: () => new Date() },
    reconcileRunsPerDay: RECONCILE_CRONS.length,
  };
}

async function dispatch(controller: ScheduledController, env: Env): Promise<void> {
  const reconcileIndex = (RECONCILE_CRONS as readonly string[]).indexOf(controller.cron);
  let report: TickReport;
  const startedAt = Date.now();
  if (controller.cron === TICK_CRON) {
    report = await runTick(buildDeps(env), controller.scheduledTime);
  } else if (reconcileIndex >= 0) {
    report = await runReconcile(buildDeps(env), controller.scheduledTime, reconcileIndex);
  } else {
    console.error(`unknown cron trigger: ${sanitizeLogText(controller.cron)}`);
    return;
  }
  console.log(formatRunLog({ cron: controller.cron, report, elapsedMs: Date.now() - startedAt }));
}

async function dispatchSafely(controller: ScheduledController, env: Env): Promise<void> {
  try {
    await dispatch(controller, env);
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`scheduled run failed (cron ${controller.cron}): ${sanitizeLogText(message)}`);
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatchSafely(controller, env));
  },
} satisfies ExportedHandler<Env>;
