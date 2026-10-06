// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD_SEND_TIMEOUT_MS, PROJECT } from '../core/constants.ts';
import type { Sender, SendResult, SendTarget } from '../core/ports.ts';
import type { DiscordMessage } from '../core/types.ts';
import { parseDiscordWebhookUrl } from './guards.ts';

const USER_AGENT = `DiscordBot (${PROJECT.repoUrl}, ${PROJECT.version})`;

// Unbound global fetch throws "Illegal invocation" in Workers.
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

export class DiscordSender implements Sender {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(fetchImpl: typeof fetch = defaultFetch, timeoutMs: number = DISCORD_SEND_TIMEOUT_MS) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async send(target: SendTarget, payload: DiscordMessage): Promise<SendResult> {
    if (target.kind !== 'webhook') {
      console.warn('discord send rejected: not a webhook target');
      return { ok: false, retryable: false, status: 0 };
    }
    const { url: webhookUrl, threadId } = target;
    const hook = parseDiscordWebhookUrl(webhookUrl);
    if (hook === null) {
      console.warn('discord send rejected: not a discord webhook url');
      return { ok: false, retryable: false, status: 0 };
    }

    const url = new URL(webhookUrl);
    if (threadId) url.searchParams.set('thread_id', threadId);
    url.searchParams.set('wait', 'false');
    if (payload.components !== undefined && payload.components.length > 0) url.searchParams.set('with_components', 'true');

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      console.warn(`discord send network error webhook=${hook.id}`);
      return { ok: false, retryable: true, retryAfterSeconds: null, status: 0 };
    }

    if (res.ok) {
      await res.body?.cancel();
      return { ok: true };
    }

    console.warn(`discord send failed status=${res.status} webhook=${hook.id}`);

    if (res.status === 429) {
      return { ok: false, retryable: true, retryAfterSeconds: await readRetryAfter(res), status: 429 };
    }
    await res.body?.cancel();
    if (res.status >= 500) {
      return { ok: false, retryable: true, retryAfterSeconds: null, status: res.status };
    }
    return { ok: false, retryable: false, status: res.status };
  }
}

async function readRetryAfter(res: Response): Promise<number | null> {
  let fromBody: unknown;
  try {
    const body = (await res.json()) as { retry_after?: unknown } | null;
    fromBody = body?.retry_after;
  } catch {
    fromBody = undefined;
  }
  const seconds = toSeconds(fromBody) ?? toSeconds(res.headers.get('retry-after'));
  return seconds === null ? null : Math.ceil(seconds);
}

function toSeconds(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}
