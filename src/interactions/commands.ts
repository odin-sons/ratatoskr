// SPDX-License-Identifier: AGPL-3.0-or-later
import { createExcludeCommand, createFilterAutocomplete, createFilterCommand, createIncludeCommand } from './commands/filter-edit.ts';
import { INFO_BUTTON_PREFIX } from '../core/info-button.ts';
import { createInfoAutocomplete, createInfoButton, createInfoCommand } from './commands/info.ts';
import { createListCommand, createListPager, LIST_COMPONENT_PREFIX } from './commands/list.ts';
import { createContinueCommand, createPauseCommand } from './commands/pause.ts';
import { createSubscribeAutocomplete, createSubscribeCommand } from './commands/subscribe.ts';
import { createUnsubscribeAutocomplete, createUnsubscribeCommand } from './commands/unsubscribe.ts';
import type { CommandDeps } from './commands/deps.ts';
import { INFO_COMMAND_NAME } from './definitions.ts';
import { createRegistry, type HandlerRegistry } from './router.ts';

export { randomSubscriptionId, type CommandDeps } from './commands/deps.ts';

/** The handlers the Worker serves; commands are registered here as they are added. */
export function createCommandRegistry(deps: CommandDeps): HandlerRegistry {
  const registry = createRegistry();
  registry.commands.set('subscribe', createSubscribeCommand(deps));
  registry.autocompletes.set('subscribe', createSubscribeAutocomplete(deps));
  registry.commands.set('unsubscribe', createUnsubscribeCommand(deps));
  registry.autocompletes.set('unsubscribe', createUnsubscribeAutocomplete(deps));
  registry.commands.set('pause', createPauseCommand(deps));
  registry.autocompletes.set('pause', createUnsubscribeAutocomplete(deps));
  registry.commands.set('continue', createContinueCommand(deps));
  registry.autocompletes.set('continue', createUnsubscribeAutocomplete(deps));
  registry.commands.set('filter', createFilterCommand(deps));
  registry.autocompletes.set('filter', createFilterAutocomplete(deps));
  registry.commands.set('include', createIncludeCommand(deps));
  registry.autocompletes.set('include', createFilterAutocomplete(deps));
  registry.commands.set('exclude', createExcludeCommand(deps));
  registry.autocompletes.set('exclude', createFilterAutocomplete(deps));
  registry.commands.set('list', createListCommand(deps));
  registry.components.set(LIST_COMPONENT_PREFIX, createListPager(deps));
  registry.commands.set(INFO_COMMAND_NAME, createInfoCommand(deps));
  registry.autocompletes.set(INFO_COMMAND_NAME, createInfoAutocomplete(deps));
  registry.components.set(INFO_BUTTON_PREFIX, createInfoButton(deps));
  return registry;
}
