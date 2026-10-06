// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD } from '../../core/constants.ts';
import type { Subscription } from '../../core/types.ts';
import type { Messages } from '../../i18n/index.ts';
import { truncate } from '../../text/sanitize.ts';
import { requireManageChannel } from '../permissions.ts';
import { parseOptions } from '../options.ts';
import { reply, updateMessage, type InteractionMessage, type InteractionResponse } from '../responses.ts';
import type { InteractionHandler } from '../router.ts';
import { resolveTarget } from '../target.ts';
import type { Interaction } from '../types.ts';
import type { CommandDeps } from './deps.ts';
import { describePause } from './pause.ts';
import { describeDestination, describeMode, display, subscriptionName, subscriptionsHere, summarizeFilter } from './view.ts';

export const LIST_COMPONENT_PREFIX = 'list';

type Scope = 'c' | 'g';

const CUSTOM_ID = /^list:([cg]):(\d{1,4})$/;
const BUTTON = { type: 2, style: 2 } as const;
const ACTION_ROW = 1;

/** Room kept in a page for the title and the page counter. */
const PAGE_RESERVE = 120;

function line(sub: Subscription, now: Date, messages: Messages): string {
  const parts = [`**${display(subscriptionName(sub))}** \`${sub.id}\``, describeMode(sub, messages)];
  if (sub.threadPerMod) parts.push(messages.threadPerMod);
  parts.push(describeDestination(sub, messages), summarizeFilter(sub.filter, messages));
  const pause = describePause(sub, now, messages);
  if (pause !== null) parts.push(pause);
  return parts.join(' · ');
}

/** Greedy split into pages whose text stays within `limit`; a line longer than that is cut. */
export function paginate(lines: readonly string[], limit: number): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const raw of lines) {
    const entry = truncate(raw, limit);
    if (current.length > 0 && size + entry.length + 1 > limit) {
      pages.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += entry.length + 1;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

const buttons = (scope: Scope, page: number, pages: number, messages: Messages): unknown[] => [
  {
    type: ACTION_ROW,
    components: [
      { ...BUTTON, label: messages.listPrevious, custom_id: `${LIST_COMPONENT_PREFIX}:${scope}:${page - 1}`, disabled: page === 0 },
      { ...BUTTON, label: messages.listNext, custom_id: `${LIST_COMPONENT_PREFIX}:${scope}:${page + 1}`, disabled: page >= pages - 1 },
    ],
  },
];

/** The message of one page of the listing; null where the command cannot apply. */
async function render(deps: CommandDeps, interaction: Interaction, scope: Scope, requested: number, messages: Messages): Promise<InteractionMessage | null> {
  let subscriptions: Subscription[] | null;
  if (scope === 'g') subscriptions = interaction.guild_id === undefined ? null : await deps.store.listSubscriptionsByGuild(interaction.guild_id);
  else subscriptions = await subscriptionsHere(deps.store, interaction);
  if (subscriptions === null) return null;
  const title = scope === 'g' ? messages.listGuildTitle : messages.listChannelTitle;
  if (subscriptions.length === 0) return { content: `${title}\n${messages.listEmpty}` };

  const sorted = [...subscriptions].sort((a, b) => {
    const [x, y] = [subscriptionName(a).toLowerCase(), subscriptionName(b).toLowerCase()];
    return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const pages = paginate(sorted.map((sub) => line(sub, deps.now(), messages)), DISCORD.contentMax - PAGE_RESERVE);
  const page = Math.min(Math.max(requested, 0), pages.length - 1);
  const footer = pages.length > 1 ? `\n${messages.page(page + 1, pages.length)}` : '';
  return {
    content: `${title}\n${pages[page]!.join('\n')}${footer}`,
    ...(pages.length > 1 ? { components: buttons(scope, page, pages.length, messages) } : {}),
  };
}

export function createListCommand(deps: CommandDeps): InteractionHandler {
  return async (interaction, { messages }): Promise<InteractionResponse> => {
    const denied = requireManageChannel(interaction, messages);
    if (denied) return denied;
    const scope: Scope = parseOptions(interaction).boolean('all') === true ? 'g' : 'c';
    const target = resolveTarget(interaction);
    if (!target.ok) return reply({ content: target.reason === 'dm' ? messages.guildOnly : messages.unsupportedChannel }, { ephemeral: true });
    const message = await render(deps, interaction, scope, 0, messages);
    return reply(message ?? { content: messages.unsupportedChannel }, { ephemeral: true });
  };
}

export function createListPager(deps: CommandDeps): InteractionHandler {
  return async (interaction, { messages }): Promise<InteractionResponse> => {
    const denied = requireManageChannel(interaction, messages);
    if (denied) return denied;
    const match = CUSTOM_ID.exec(interaction.data?.custom_id ?? '');
    if (match === null) return reply({ content: messages.unknownCommand }, { ephemeral: true });
    const target = resolveTarget(interaction);
    if (!target.ok) return reply({ content: target.reason === 'dm' ? messages.guildOnly : messages.unsupportedChannel }, { ephemeral: true });
    const message = await render(deps, interaction, match[1] as Scope, Number(match[2]), messages);
    return message === null ? reply({ content: messages.unsupportedChannel }, { ephemeral: true }) : updateMessage({ components: [], ...message });
  };
}
