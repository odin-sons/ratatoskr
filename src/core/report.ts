// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TickReport } from './tick.ts';

export const MAX_LOGGED_TEXT_CHARS = 200;

/** Adapter warnings logged per source and run. */
export const MAX_LOGGED_WARNINGS = 5;

const SCHEME_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const WEBHOOK_PATH_PATTERN = /\S*webhooks\/\S*/gi;
const WEBHOOK_ID_TOKEN_PATTERN = /\b\d{17,20}\/[\w-]{20,}/g;

/** One line, without URLs or webhook paths (they carry tokens), capped in length. */
export function sanitizeLogText(text: string): string {
  return text
    .slice(0, MAX_LOGGED_TEXT_CHARS * 4)
    .replace(SCHEME_URL_PATTERN, '[url]')
    .replace(WEBHOOK_PATH_PATTERN, '[url]')
    .replace(WEBHOOK_ID_TOKEN_PATTERN, '[url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LOGGED_TEXT_CHARS);
}

export interface RunLogInput {
  cron: string;
  report: TickReport;
  elapsedMs: number;
}

/** The single structured log line for one scheduled run. */
export function formatRunLog({ cron, report, elapsedMs }: RunLogInput): string {
  const sources: Record<string, { status: string; events: number; error?: string; warnings?: string[] }> = {};
  for (const [id, source] of Object.entries(report.sources)) {
    sources[id] = {
      status: source.status,
      events: source.events,
      ...(source.error === undefined ? {} : { error: sanitizeLogText(source.error) }),
      ...(source.warnings === undefined || source.warnings.length === 0
        ? {}
        : { warnings: source.warnings.slice(0, MAX_LOGGED_WARNINGS).map(sanitizeLogText) }),
    };
  }
  return JSON.stringify({
    event: 'run',
    cron,
    sources,
    sent: report.sent,
    failed: report.failed,
    deferred: report.deferred,
    parked: report.parked,
    degraded: report.degraded,
    filtered: report.filtered,
    purged: report.purged,
    alerts: report.alerts,
    alertsFailed: report.alertsFailed,
    changelogFetches: report.changelogFetches,
    changelogSkipped: report.changelogSkipped,
    subrequests: report.subrequests,
    ...(report.drainError === undefined ? {} : { drainError: sanitizeLogText(report.drainError) }),
    elapsedMs: Math.round(elapsedMs),
  });
}
