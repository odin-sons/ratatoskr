// SPDX-License-Identifier: AGPL-3.0-or-later
import { truncate, escapeMarkdown, neutralizeMentions } from '../../text/sanitize.ts';
import type { Store } from '../../core/ports.ts';
import type { Subscription, SubscriptionFilter } from '../../core/types.ts';
import type { Messages } from '../../i18n/index.ts';
import { resolveTarget } from '../target.ts';
import type { Interaction } from '../types.ts';

const SUMMARY_LIST_MAX = 120;

/** Untrusted text made safe to show in a message. */
export const display = (text: string): string => escapeMarkdown(neutralizeMentions(text));

const listOf = (items: readonly string[]): string => display(truncate(items.join(', '), SUMMARY_LIST_MAX));

export function summarizeFilter(filter: SubscriptionFilter, messages: Messages): string {
  const parts: string[] = [];
  if (filter.packages && filter.packages.length > 0) parts.push(messages.filterPackages(listOf(filter.packages)));
  if (filter.includeCategories && filter.includeCategories.length > 0) parts.push(messages.filterCategories(listOf(filter.includeCategories)));
  if (filter.sources && filter.sources.length > 0) parts.push(messages.filterSources(listOf(filter.sources)));
  const kinds = new Set(filter.kinds ?? []);
  if (kinds.size === 1) parts.push(kinds.has('new') ? messages.filterOnlyNew : messages.filterOnlyUpdates);
  return parts.length === 0 ? messages.filterEverything : parts.join(', ');
}

export function describeMode(sub: Pick<Subscription, 'mode' | 'digestIntervalMin'>, messages: Messages): string {
  return sub.mode === 'immediate' ? messages.modeImmediate : messages.modeDigest(sub.digestIntervalMin);
}

/** Channel mention of where a subscription delivers; a thread or forum post when it targets one. */
export function describeDestination(sub: Subscription, messages: Messages): string {
  const target = sub.threadId ?? sub.channelId;
  return target ? `<#${target}>` : messages.listWebhook;
}

export const subscriptionName = (sub: Subscription): string => sub.label ?? sub.id;

/**
 * The subscriptions the command's place owns: in a text channel those of the channel, in a thread or forum post
 * the thread's own and its parent channel's. Null where the command cannot apply.
 */
export async function subscriptionsHere(store: Store, interaction: Interaction): Promise<Subscription[] | null> {
  const target = resolveTarget(interaction);
  if (!target.ok || interaction.guild_id === undefined) return null;
  const guildId = interaction.guild_id;
  const inChannel = await store.listSubscriptionsByChannel(target.channelId);
  return inChannel.filter((sub) => sub.guildId === guildId && (target.threadId === undefined || sub.threadId == null || sub.threadId === target.threadId));
}
