// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TickReport } from './tick.ts';

export const MAX_LOGGED_TEXT_CHARS = 200;

const SCHEME_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const WEBHOOK_PATH_PATTERN = /\S*webhooks\/\S*/gi;
const WEBHOOK_ID_TOKEN_PATTERN = /\b\d{17,20}\/[\w-]{20,}/g;

/** One line, without URLs or webhook paths (they carry tokens), capped in length. */
export function sanitizeLogText(text: string): string {
  return text
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
  const sources: Record<string, { status: string; events: number; error?: string }> = {};
  for (const [id, source] of Object.entries(report.sources)) {
    sources[id] =
      source.error === undefined
        ? { status: source.status, events: source.events }
        : { status: source.status, events: source.events, error: sanitizeLogText(source.error) };
  }
  return JSON.stringify({
    event: 'run',
    cron,
    sources,
    sent: report.sent,
    failed: report.failed,
    deferred: report.deferred,
    parked: report.parked,
    filtered: report.filtered,
    purged: report.purged,
    changelogFetches: report.changelogFetches,
    changelogSkipped: report.changelogSkipped,
    subrequests: report.subrequests,
    ...(report.drainError === undefined ? {} : { drainError: sanitizeLogText(report.drainError) }),
    elapsedMs: Math.round(elapsedMs),
  });
}
