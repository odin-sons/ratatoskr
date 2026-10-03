// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { bestOf } from '../testing/timing.ts';
import { MAX_LOGGED_TEXT_CHARS, MAX_LOGGED_WARNINGS, formatRunLog, sanitizeLogText } from './report.ts';
import type { TickReport } from './tick.ts';

const report = (over: Partial<TickReport> = {}): TickReport => ({
  sources: {
    'thunderstore:valheim': { status: 'ok', events: 3 },
    'hexium:valheim': { status: 'error', events: 0, error: 'HTTP 503 from https://valheim.hexium.gg/api/v1/package/' },
    'nexus:valheim': { status: 'skipped', events: 0 },
  },
  sent: 4,
  failed: 1,
  changelogFetches: 2,
  changelogSkipped: 5,
  deferred: 7,
  parked: 3,
  degraded: 2,
  filtered: 1,
  purged: 0,
  alerts: 1,
  alertsFailed: 0,
  subrequests: 19,
  ...over,
});

const parse = (line: string): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>;

describe('formatRunLog', () => {
  it('is a single line of JSON carrying cron, counters and elapsed time', () => {
    const line = formatRunLog({ cron: '*/5 * * * *', report: report(), elapsedMs: 123 });
    expect(line).not.toContain('\n');
    expect(parse(line)).toMatchObject({
      event: 'run',
      cron: '*/5 * * * *',
      sent: 4,
      failed: 1,
      deferred: 7,
      parked: 3,
      degraded: 2,
      filtered: 1,
      purged: 0,
      alerts: 1,
      alertsFailed: 0,
      changelogFetches: 2,
      changelogSkipped: 5,
      subrequests: 19,
      elapsedMs: 123,
    });
  });

  it('lists every source with status, events and error', () => {
    const { sources } = parse(formatRunLog({ cron: 'c', report: report(), elapsedMs: 1 })) as {
      sources: Record<string, { status: string; events: number; error?: string }>;
    };
    expect(sources['thunderstore:valheim']).toEqual({ status: 'ok', events: 3 });
    expect(sources['nexus:valheim']).toEqual({ status: 'skipped', events: 0 });
    expect(sources['hexium:valheim']!.status).toBe('error');
    expect(sources['hexium:valheim']!.error).toContain('HTTP 503');
  });

  it('removes urls from error messages', () => {
    const line = formatRunLog({ cron: 'c', report: report(), elapsedMs: 1 });
    expect(line).not.toContain('hexium.gg');
    expect(line).not.toContain('https://');
  });

  it('never leaks a webhook url or token embedded in an error', () => {
    const secret = 'https://discord.com/api/webhooks/123456789012345678/SuperSecretToken_abc';
    const line = formatRunLog({
      cron: 'c',
      report: report({
        sources: { s: { status: 'error', events: 0, error: `failed for ${secret} again` } },
        drainError: `send to ${secret} broke`,
      }),
      elapsedMs: 1,
    });
    expect(line).not.toContain('SuperSecretToken');
    expect(line).not.toContain('discord.com');
  });

  it('truncates long error messages', () => {
    const line = formatRunLog({
      cron: 'c',
      report: report({ sources: { s: { status: 'error', events: 0, error: 'x'.repeat(5000) } }, drainError: 'y'.repeat(5000) }),
      elapsedMs: 1,
    });
    const parsed = parse(line) as { sources: { s: { error: string } }; drainError: string };
    expect(parsed.sources.s.error.length).toBeLessThanOrEqual(MAX_LOGGED_TEXT_CHARS);
    expect(parsed.drainError.length).toBeLessThanOrEqual(MAX_LOGGED_TEXT_CHARS);
  });

  it('includes the drain error only when there is one', () => {
    expect(parse(formatRunLog({ cron: 'c', report: report(), elapsedMs: 1 }))).not.toHaveProperty('drainError');
    expect(parse(formatRunLog({ cron: 'c', report: report({ drainError: 'd1 down' }), elapsedMs: 1 }))).toMatchObject({ drainError: 'd1 down' });
  });

  it("lists a source's warnings, redacted and truncated, and omits them when there are none", () => {
    const secret = 'https://discord.com/api/webhooks/123456789012345678/SuperSecretToken_abc';
    const line = formatRunLog({
      cron: 'c',
      report: report({
        sources: {
          a: { status: 'ok', events: 0, warnings: ['package-index above cap: updates not detected', `saw ${secret} here`, 'x'.repeat(5000)] },
          b: { status: 'ok', events: 1 },
        },
      }),
      elapsedMs: 1,
    });
    const { sources } = parse(line) as { sources: Record<string, { warnings?: string[] }> };
    expect(sources.a!.warnings![0]).toBe('package-index above cap: updates not detected');
    expect(sources.a!.warnings![1]).toBe('saw [url] here');
    expect(sources.a!.warnings![2]!.length).toBeLessThanOrEqual(MAX_LOGGED_TEXT_CHARS);
    expect(sources.b).not.toHaveProperty('warnings');
    expect(line).not.toContain('SuperSecretToken');
  });

  it('caps how many warnings of one source are logged', () => {
    const warnings = Array.from({ length: MAX_LOGGED_WARNINGS + 10 }, (_, i) => `w${i}`);
    const line = formatRunLog({ cron: 'c', report: report({ sources: { a: { status: 'ok', events: 0, warnings } } }), elapsedMs: 1 });
    const { sources } = parse(line) as { sources: Record<string, { warnings: string[] }> };
    expect(sources.a!.warnings).toEqual(warnings.slice(0, MAX_LOGGED_WARNINGS));
  });

  it('rounds the elapsed time to whole milliseconds', () => {
    expect(parse(formatRunLog({ cron: 'c', report: report(), elapsedMs: 12.6 }))).toMatchObject({ elapsedMs: 13 });
  });
});

describe('sanitizeLogText cost', () => {
  it('stays linear on very long input without whitespace', () => {
    const text = `x${'a'.repeat(20_000)}`;
    expect(bestOf(5, () => sanitizeLogText(text))).toBeLessThan(25);
    expect(sanitizeLogText(text)).toHaveLength(MAX_LOGGED_TEXT_CHARS);
  });

  it('still redacts a URL that starts inside the kept prefix of a long text', () => {
    const text = `${'y '.repeat(50)}https://discord.com/api/webhooks/123456789012345678/${'T'.repeat(300)}`;
    expect(sanitizeLogText(text)).not.toContain('T'.repeat(10));
  });
});

describe('sanitizeLogText', () => {
  it('replaces urls, collapses whitespace and truncates', () => {
    expect(sanitizeLogText('a\n  b http://x.invalid/p?q=1 c')).toBe('a b [url] c');
    expect(sanitizeLogText('z'.repeat(MAX_LOGGED_TEXT_CHARS + 50))).toHaveLength(MAX_LOGGED_TEXT_CHARS);
  });

  it.each([
    ['upper-case scheme', 'failed HTTPS://DISCORD.COM/API/WEBHOOKS/1/SecretTok again'],
    ['mixed-case scheme', 'failed Https://discord.com/api/webhooks/1/SecretTok again'],
    ['scheme-less host', 'failed discord.com/api/webhooks/123456789012345678/SecretTok again'],
    ['scheme-less legacy host', 'failed discordapp.com/api/webhooks/123456789012345678/SecretTok again'],
    ['upper-case scheme-less path', 'failed DISCORD.COM/API/WEBHOOKS/1/SecretTok again'],
    ['bare api path', 'failed /api/webhooks/1/SecretTok again'],
    ['versioned api path', 'failed POST api/v10/webhooks/1/SecretTok again'],
    ['path without api', 'failed webhooks/1/SecretTok again'],
    ['query after the token', 'failed discord.com/api/webhooks/1/SecretTok?wait=true&thread_id=9 again'],
    ['id and token pair', 'failed 123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxSecretTok again'],
    ['other scheme', 'failed wss://gateway.invalid/SecretTok again'],
  ])('redacts %s', (_name, text) => {
    const clean = sanitizeLogText(text);
    expect(clean).not.toContain('SecretTok');
    expect(clean).not.toContain('SECRETTOK');
    expect(clean).not.toMatch(/discord/i);
    expect(clean.startsWith('failed ')).toBe(true);
    expect(clean.endsWith(' again')).toBe(true);
  });

  it('keeps ordinary text that merely mentions the word webhook', () => {
    expect(sanitizeLogText('webhook rejected: HTTP 404')).toBe('webhook rejected: HTTP 404');
  });
});
