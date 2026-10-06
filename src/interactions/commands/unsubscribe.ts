// SPDX-License-Identifier: AGPL-3.0-or-later
import { reply, autocomplete, type InteractionResponse } from '../responses.ts';
import type { InteractionHandler } from '../router.ts';
import { hasManageChannel, requireManageChannel } from '../permissions.ts';
import { parseOptions } from '../options.ts';
import { resolveTarget } from '../target.ts';
import type { Subscription } from '../../core/types.ts';
import type { CommandDeps } from './deps.ts';
import { deferWork } from './defer-work.ts';
import { display, subscriptionName, subscriptionsHere } from './view.ts';

/** The chosen id, or a typed label that names exactly one subscription of the place. */
export function pickSubscription(here: readonly Subscription[], chosen: string): Subscription | undefined {
  const byId = here.find((sub) => sub.id === chosen);
  if (byId) return byId;
  const wanted = chosen.trim().toLowerCase();
  const byLabel = here.filter((sub) => sub.label != null && sub.label.toLowerCase() === wanted);
  return byLabel.length === 1 ? byLabel[0] : undefined;
}

export function createUnsubscribeCommand(deps: CommandDeps): InteractionHandler {
  return (interaction, ctx): InteractionResponse => {
    const { messages } = ctx;
    const denied = requireManageChannel(interaction, messages);
    if (denied) return denied;
    const target = resolveTarget(interaction);
    if (!target.ok) return reply({ content: target.reason === 'dm' ? messages.guildOnly : messages.unsupportedChannel }, { ephemeral: true });
    const chosen = parseOptions(interaction).string('subscription');
    if (chosen === undefined || chosen.trim() === '') return reply({ content: messages.subscriptionNotFound }, { ephemeral: true });
    return deferWork(interaction, ctx, async () => {
      const here = (await subscriptionsHere(deps.store, interaction)) ?? [];
      const sub = pickSubscription(here, chosen);
      if (sub === undefined || !(await deps.store.deleteSubscription(sub.id))) return { content: messages.subscriptionNotFound };
      return { content: messages.unsubscribed(display(subscriptionName(sub))) };
    });
  };
}

export function createUnsubscribeAutocomplete(deps: CommandDeps): InteractionHandler {
  return async (interaction): Promise<InteractionResponse> => {
    if (!hasManageChannel(interaction)) return autocomplete([]);
    const typed = (parseOptions(interaction).focused?.value ?? '').trim().toLowerCase();
    const here = (await subscriptionsHere(deps.store, interaction)) ?? [];
    return autocomplete(
      here
        .filter((sub) => typed === '' || subscriptionName(sub).toLowerCase().includes(typed))
        .map((sub) => ({ name: subscriptionName(sub), value: sub.id })),
    );
  };
}
