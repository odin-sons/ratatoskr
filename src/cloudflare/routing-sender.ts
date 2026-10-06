// SPDX-License-Identifier: AGPL-3.0-or-later
import { BOT_UNCONFIGURED_RETRY_SECONDS } from '../core/constants.ts';
import type { ForumPostResult, OpenThreadResult, SendFailure, SendResult, SendTarget, Sender } from '../core/ports.ts';
import type { DiscordMessage } from '../core/types.ts';
import type { BotSender } from './bot-sender.ts';

const BOT_UNCONFIGURED: SendFailure = { ok: false, retryable: true, retryAfterSeconds: BOT_UNCONFIGURED_RETRY_SECONDS, status: 429 };

/** Sends webhook targets through `webhook` and bot targets through `bot`; without a bot every bot request is deferred. */
export class RoutingSender implements Sender {
  private readonly webhook: Sender;
  private readonly bot: BotSender | null;
  private warned = false;

  constructor(webhook: Sender, bot: BotSender | null) {
    this.webhook = webhook;
    this.bot = bot;
  }

  canSend(target: SendTarget): boolean {
    return target.kind === 'webhook' || this.bot !== null;
  }

  send(target: SendTarget, payload: DiscordMessage): Promise<SendResult> {
    if (target.kind === 'webhook') return this.webhook.send(target, payload);
    return this.bot === null ? this.unconfigured() : this.bot.send(target, payload);
  }

  createForumPost(channelId: string, name: string, payload: DiscordMessage): Promise<ForumPostResult> {
    return this.bot === null ? this.unconfigured() : this.bot.createForumPost(channelId, name, payload);
  }

  openThreadOnMessage(channelId: string, messageId: string, name: string): Promise<OpenThreadResult> {
    return this.bot === null ? this.unconfigured() : this.bot.openThreadOnMessage(channelId, messageId, name);
  }

  // Status 429 with a delay reuses the reschedule path that keeps the row's attempts.
  private unconfigured(): Promise<SendFailure> {
    if (!this.warned) {
      this.warned = true;
      console.warn('bot subscriptions are waiting: DISCORD_BOT_TOKEN is not set');
    }
    return Promise.resolve(BOT_UNCONFIGURED);
  }
}
