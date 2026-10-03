// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SubrequestBudget } from './budget.ts';
import { CAP_ALERT_REPEAT_MS, CAP_ALERT_THRESHOLDS, PROJECT } from './constants.ts';
import type { Sender, Store } from './ports.ts';
import { sanitizeLogText } from './report.ts';
import type { CapUsage, DiscordMessage, SourceId } from './types.ts';

export interface SourceCapUsage {
  source: SourceId;
  usage: CapUsage;
}

/** Level of an exceeded limit; 1 to 3 are the shares in `CAP_ALERT_THRESHOLDS`, 0 is below the first. */
export const EXCEEDED_LEVEL = CAP_ALERT_THRESHOLDS.length + 1;

const LEVEL_ICONS = ['', '🟡', '🟠', '🔴', '⛔'];

export function capLevel(usage: CapUsage): number {
  if (usage.exceeded) return EXCEEDED_LEVEL;
  if (usage.value === null || usage.limit <= 0) return 0;
  const share = usage.value / usage.limit;
  return CAP_ALERT_THRESHOLDS.filter((threshold) => share >= threshold).length;
}

const alertKey = ({ source, usage }: SourceCapUsage): string => `${source}:${usage.id}`;

const formatNumber = (n: number): string => n.toLocaleString('en-US');

export function formatCapAlert({ source, usage }: SourceCapUsage, level: number): DiscordMessage {
  const icon = LEVEL_ICONS[level] ?? '';
  const headline =
    usage.exceeded || usage.value === null
      ? `${icon} ${source}: ${usage.label} exceeded (limit ${formatNumber(usage.limit)} ${usage.unit}).`
      : `${icon} ${source}: ${usage.label} at ${Math.floor((usage.value / usage.limit) * 100)} % (${formatNumber(usage.value)} of ${formatNumber(usage.limit)} ${usage.unit}).`;
  const repeat = usage.exceeded ? ` Reported again every ${CAP_ALERT_REPEAT_MS / 3_600_000} hours until it is fixed.` : '';
  return {
    content: `${headline} ${usage.consequence}${repeat} Limit: \`${usage.constant}\`.\n-# [ratatoskr v${PROJECT.version}](${PROJECT.repoUrl})`,
    allowed_mentions: { parse: [] },
  };
}

export interface RaiseAlertsInput {
  store: Pick<Store, 'getAlertStates' | 'setAlertState'>;
  sender: Sender;
  /** The alert channel's webhook; without it nothing is sent and nothing is recorded, so a later run still alerts. */
  webhookUrl: string | undefined;
  budget: SubrequestBudget;
  usages: SourceCapUsage[];
  now: Date;
}

export interface AlertsResult {
  sent: number;
  failed: number;
}

/**
 * Sends one alert each time a limit reaches a higher level than the last one reported, and repeats an exceeded
 * limit once a day. A failed send records nothing, so the next run tries again.
 */
export async function raiseCapAlerts(input: RaiseAlertsInput): Promise<AlertsResult> {
  const { store, sender, webhookUrl, budget, usages, now } = input;
  const result: AlertsResult = { sent: 0, failed: 0 };
  if (usages.length === 0) return result;

  const states = await store.getAlertStates(usages.map(alertKey));
  let unconfigured = false;
  for (const entry of usages) {
    const key = alertKey(entry);
    const level = capLevel(entry.usage);
    const stored = states.get(key);
    const storedLevel = stored?.level ?? 0;
    const repeatDue = level === EXCEEDED_LEVEL && stored !== undefined && !(now.getTime() - Date.parse(stored.notifiedAt) < CAP_ALERT_REPEAT_MS);
    if (level <= storedLevel && !repeatDue) {
      if (stored !== undefined && level < storedLevel) {
        const lowered = { level, notifiedAt: stored.notifiedAt };
        await store.setAlertState(key, lowered);
        states.set(key, lowered);
      }
      continue;
    }
    if (webhookUrl === undefined) {
      unconfigured = true;
      continue;
    }
    if (!budget.tryConsume()) continue;
    const sent = await sender.send(webhookUrl, formatCapAlert(entry, level));
    if (!sent.ok) {
      result.failed += 1;
      continue;
    }
    result.sent += 1;
    const next = { level, notifiedAt: now.toISOString() };
    try {
      await store.setAlertState(key, next);
      states.set(key, next);
    } catch (err) {
      console.warn(`alert state not saved: ${sanitizeLogText(err instanceof Error ? err.message : String(err))}`);
    }
  }
  if (unconfigured) console.warn('alert due but ALERT_WEBHOOK_URL is not set');
  return result;
}
