// SPDX-License-Identifier: AGPL-3.0-or-later
import { INTERACTION_TYPE } from './constants.ts';
import { autocomplete, pong, reply, type FinishContext, type InteractionResponse } from './responses.ts';
import type { Interaction } from './types.ts';

/** What a handler gets next to the interaction: the localized messages and the means to finish a deferred response. */
export type HandlerContext = FinishContext;

export type InteractionHandler = (interaction: Interaction, ctx: HandlerContext) => InteractionResponse | Promise<InteractionResponse>;

export interface HandlerRegistry {
  /** Application commands, by command name. */
  commands: Map<string, InteractionHandler>;
  /** Autocomplete requests, by command name. */
  autocompletes: Map<string, InteractionHandler>;
  /** Message components, by the part of `custom_id` before the first `:`. */
  components: Map<string, InteractionHandler>;
}

export const createRegistry = (): HandlerRegistry => ({ commands: new Map(), autocompletes: new Map(), components: new Map() });

const componentPrefix = (customId: string): string => {
  const colon = customId.indexOf(':');
  return colon === -1 ? customId : customId.slice(0, colon);
};

function pick(registry: HandlerRegistry, interaction: Interaction): InteractionHandler | undefined {
  const { name, custom_id: customId } = interaction.data ?? {};
  switch (interaction.type) {
    case INTERACTION_TYPE.applicationCommand:
      return name === undefined ? undefined : registry.commands.get(name);
    case INTERACTION_TYPE.applicationCommandAutocomplete:
      return name === undefined ? undefined : registry.autocompletes.get(name);
    case INTERACTION_TYPE.messageComponent:
      return customId === undefined ? undefined : registry.components.get(componentPrefix(customId));
    default:
      return undefined;
  }
}

/** Answers a verified interaction. A missing handler or a failing one gets a short ephemeral message; autocomplete gets no choices. */
export async function routeInteraction(registry: HandlerRegistry, interaction: Interaction, ctx: HandlerContext): Promise<InteractionResponse> {
  if (interaction.type === INTERACTION_TYPE.ping) return pong();
  const isAutocomplete = interaction.type === INTERACTION_TYPE.applicationCommandAutocomplete;
  const handler = pick(registry, interaction);
  if (handler === undefined) return isAutocomplete ? autocomplete([]) : reply({ content: ctx.messages.unknownCommand }, { ephemeral: true });
  try {
    return await handler(interaction, ctx);
  } catch (err) {
    console.error(`interaction handler failed: ${err instanceof Error ? err.name : 'error'}`);
    return isAutocomplete ? autocomplete([]) : reply({ content: ctx.messages.somethingWrong }, { ephemeral: true });
  }
}
