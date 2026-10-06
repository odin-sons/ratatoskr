// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD_API_BASE, DISCORD_ERROR_CODE, DISCORD_SEND_TIMEOUT_MS, DISCORD_THREAD_NAME_MAX, PROJECT } from '../core/constants.ts';
import type { Sender, SendResult, SendTarget } from '../core/ports.ts';
import type { DiscordMessage } from '../core/types.ts';
import { isSnowflake } from './guards.ts';

const USER_AGENT = `DiscordBot (${PROJECT.repoUrl}, ${PROJECT.version})`;

// Unbound global fetch throws "Illegal invocation" in Workers.
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

export type BotFailure = Extract<SendResult, { ok: false }>;

export type ForumPostResult = { ok: true; threadId: string; messageId: string } | BotFailure;

export type OpenThreadResult = { ok: true; threadId: string } | BotFailure;

const REJECTED: BotFailure = Object.freeze({ ok: false, retryable: false, status: 0 });

export class BotSender implements Sender {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(token: string, fetchImpl: typeof fetch = defaultFetch, timeoutMs: number = DISCORD_SEND_TIMEOUT_MS) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /** Posts into `threadId` when given, else into `channelId`. */
  async send(target: SendTarget, payload: DiscordMessage): Promise<SendResult> {
    if (target.kind !== 'bot') return reject('not a bot target');
    const channelId = target.threadId ? target.threadId : target.channelId;
    if (!isSnowflake(channelId)) return reject('invalid channel id');
    const reply = await this.post(`/channels/${channelId}/messages`, payload, channelId, Boolean(target.threadId));
    if (!reply.ok) return reply.failure;
    const messageId = snowflakeField(reply.body, 'id');
    return messageId === null ? { ok: true, channelId } : { ok: true, messageId, channelId };
  }

  /** Creates a forum post: one request makes the thread and its starter message. */
  async createForumPost(channelId: string, name: string, message: DiscordMessage): Promise<ForumPostResult> {
    const threadName = threadNameOf(name);
    if (!isSnowflake(channelId) || threadName === null) return reject('invalid forum post arguments');
    const reply = await this.post(`/channels/${channelId}/threads`, { name: threadName, message }, channelId, false);
    if (!reply.ok) return reply.failure;
    const threadId = snowflakeField(reply.body, 'id');
    const starter = (reply.body as { message?: unknown } | null)?.message;
    const messageId = snowflakeField(starter, 'id');
    return threadId === null || messageId === null ? { ok: false, retryable: false, status: reply.status } : { ok: true, threadId, messageId };
  }

  /** Opens a thread on an existing message; post into it with `send` and its `threadId`. */
  async openThreadOnMessage(channelId: string, messageId: string, name: string): Promise<OpenThreadResult> {
    const threadName = threadNameOf(name);
    if (!isSnowflake(channelId) || !isSnowflake(messageId) || threadName === null) return reject('invalid thread arguments');
    const reply = await this.post(`/channels/${channelId}/messages/${messageId}/threads`, { name: threadName }, channelId, false);
    if (!reply.ok) return reply.failure;
    const threadId = snowflakeField(reply.body, 'id');
    return threadId === null ? { ok: false, retryable: false, status: reply.status } : { ok: true, threadId };
  }

  private async post(
    path: string,
    body: unknown,
    channelId: string,
    threadTarget: boolean,
  ): Promise<{ ok: true; status: number; body: unknown } | { ok: false; failure: BotFailure }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${DISCORD_API_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, authorization: `Bot ${this.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch {
      console.warn(`discord bot send network error channel=${channelId}`);
      return { ok: false, failure: { ok: false, retryable: true, retryAfterSeconds: null, status: 0 } };
    }

    if (res.ok) return { ok: true, status: res.status, body: await readJson(res) };

    console.warn(`discord bot send failed status=${res.status} channel=${channelId}`);
    const payload = await readJson(res);
    if (res.status === 429) {
      return { ok: false, failure: { ok: false, retryable: true, retryAfterSeconds: retryAfterOf(payload, res), status: 429 } };
    }
    if (res.status >= 500) return { ok: false, failure: { ok: false, retryable: true, retryAfterSeconds: null, status: res.status } };
    const code = (payload as { code?: unknown } | null)?.code;
    const gone = res.status === 404 || code === DISCORD_ERROR_CODE.unknownChannel || (threadTarget && code === DISCORD_ERROR_CODE.threadArchived);
    return { ok: false, failure: gone ? { ok: false, retryable: false, status: res.status, gone: true } : { ok: false, retryable: false, status: res.status } };
  }
}

function reject(reason: string): BotFailure {
  console.warn(`discord bot send rejected: ${reason}`);
  return REJECTED;
}

function threadNameOf(name: string): string | null {
  const truncated = Array.from(name.trim()).slice(0, DISCORD_THREAD_NAME_MAX).join('');
  return truncated === '' ? null : truncated;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function snowflakeField(value: unknown, key: string): string | null {
  const field = (value as Record<string, unknown> | null | undefined)?.[key];
  return typeof field === 'string' && isSnowflake(field) ? field : null;
}

function retryAfterOf(payload: unknown, res: Response): number | null {
  const seconds = toSeconds((payload as { retry_after?: unknown } | null)?.retry_after) ?? toSeconds(res.headers.get('retry-after'));
  return seconds === null ? null : Math.ceil(seconds);
}

function toSeconds(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}
