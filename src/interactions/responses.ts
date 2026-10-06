// SPDX-License-Identifier: AGPL-3.0-or-later
import { AUTOCOMPLETE_MAX_RESULTS, DISCORD_API_BASE, DISCORD_INTERACTION, DISCORD_SEND_TIMEOUT_MS } from '../core/constants.ts';
import type { Messages } from '../i18n/index.ts';
import { INTERACTION_CALLBACK, INTERACTION_TOKEN, MESSAGE_FLAG_EPHEMERAL, SNOWFLAKE } from './constants.ts';
import type { Interaction } from './types.ts';

export interface InteractionMessage {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  flags?: number;
}

export interface AutocompleteChoice {
  name: string;
  value: string | number;
}

export interface InteractionResponse {
  type: number;
  data?: Record<string, unknown>;
}

export interface ReplyOptions {
  ephemeral?: boolean;
}

/** What a handler needs to answer later, from the Worker's `ctx.waitUntil` and `fetch`. */
export interface FinishContext {
  waitUntil(promise: Promise<unknown>): void;
  fetch: typeof fetch;
  messages: Messages;
  /** Pause between follow-up attempts; defaults to `setTimeout`. */
  delay?: (ms: number) => Promise<void>;
}

/** The follow-up can reach Discord before the deferral is registered (404); only the PATCH is retried, never the work. */
const FOLLOW_UP_RETRIES = 2;
const FOLLOW_UP_RETRY_BASE_MS = 300;
const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const NO_MENTIONS = { parse: [] } as const;

function messageData(message: InteractionMessage, { ephemeral = false }: ReplyOptions): Record<string, unknown> {
  const flags = (message.flags ?? 0) | (ephemeral ? MESSAGE_FLAG_EPHEMERAL : 0);
  return { ...message, ...(flags === 0 ? {} : { flags }), allowed_mentions: NO_MENTIONS };
}

export const pong = (): InteractionResponse => ({ type: INTERACTION_CALLBACK.pong });

export const reply = (message: InteractionMessage, options: ReplyOptions = {}): InteractionResponse => ({
  type: INTERACTION_CALLBACK.channelMessage,
  data: messageData(message, options),
});

/** Edits the message a component sits on. */
export const updateMessage = (message: InteractionMessage): InteractionResponse => ({
  type: INTERACTION_CALLBACK.updateMessage,
  data: messageData(message, {}),
});

export const defer = (options: ReplyOptions = {}): InteractionResponse => ({
  type: INTERACTION_CALLBACK.deferredChannelMessage,
  ...(options.ephemeral ? { data: { flags: MESSAGE_FLAG_EPHEMERAL } } : {}),
});

export const autocomplete = (choices: readonly AutocompleteChoice[]): InteractionResponse => ({
  type: INTERACTION_CALLBACK.autocompleteResult,
  data: {
    choices: choices.slice(0, AUTOCOMPLETE_MAX_RESULTS).map(({ name, value }) => ({
      name: name.slice(0, DISCORD_INTERACTION.choiceNameMax),
      value: typeof value === 'string' ? value.slice(0, DISCORD_INTERACTION.choiceValueMax) : value,
    })),
  },
});

/** Edits the deferred response through the interaction webhook inside `waitUntil`; false when the interaction ids are malformed. */
export function finishDeferred(ctx: FinishContext, interaction: Pick<Interaction, 'application_id' | 'token'>, body: InteractionMessage | Promise<InteractionMessage>): boolean {
  if (!SNOWFLAKE.test(interaction.application_id) || !INTERACTION_TOKEN.test(interaction.token)) return false;
  const url = `${DISCORD_API_BASE}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  ctx.waitUntil(patchOriginal(ctx, url, body));
  return true;
}

async function patchOriginal(ctx: FinishContext, url: string, pending: InteractionMessage | Promise<InteractionMessage>): Promise<void> {
  let message: InteractionMessage;
  try {
    message = await pending;
  } catch (err) {
    console.error(`deferred interaction work failed: ${err instanceof Error ? err.name : 'error'}`);
    message = { content: ctx.messages.somethingWrong };
  }
  const body = JSON.stringify({ ...message, allowed_mentions: NO_MENTIONS });
  const wait = ctx.delay ?? defaultDelay;
  for (let attempt = 0; ; attempt++) {
    let failure: string;
    let retryable: boolean;
    try {
      const res = await ctx.fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(DISCORD_SEND_TIMEOUT_MS),
      });
      if (res.ok) return;
      failure = `HTTP ${res.status}`;
      retryable = res.status === 404;
    } catch (err) {
      failure = err instanceof Error ? err.name : 'error';
      retryable = true;
    }
    if (!retryable || attempt >= FOLLOW_UP_RETRIES) {
      console.error(`finishing a deferred interaction failed: ${failure}`);
      return;
    }
    await wait(FOLLOW_UP_RETRY_BASE_MS * 2 ** attempt);
  }
}
