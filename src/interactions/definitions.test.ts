// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DISCORD_INTERACTION } from '../core/constants.ts';
import { COMMAND_DEFINITIONS, OPTION_TYPE, type ChatCommandDefinition, type CommandOptionDefinition } from './definitions.ts';
import { createCommandRegistry } from './commands.ts';
import { MemoryStore } from '../testing/memory-store.ts';

const CHAT_COMMANDS = COMMAND_DEFINITIONS.filter((c): c is ChatCommandDefinition => c.type === 1);
const NAME = /^[\p{Ll}\p{Lo}\p{N}_-]{1,32}$/u;

describe('command definitions', () => {
  it('describe subscribe, unsubscribe, pause, continue, filter, include, exclude, list, info and the Mod info message command', () => {
    expect(COMMAND_DEFINITIONS.map((c) => c.name)).toEqual(['subscribe', 'unsubscribe', 'pause', 'continue', 'filter', 'include', 'exclude', 'list', 'info', 'Mod info']);
  });

  it('are served by the registry: every command, and every autocomplete option, has a handler', () => {
    const registry = createCommandRegistry({ store: new MemoryStore(), sources: [], newId: () => 'x', now: () => new Date() });
    for (const definition of COMMAND_DEFINITIONS) {
      expect(registry.commands.has(definition.name), definition.name).toBe(true);
      if (definition.options?.some((o) => o.autocomplete)) expect(registry.autocompletes.has(definition.name), definition.name).toBe(true);
    }
    expect(registry.components.has('list')).toBe(true);
  });

  it.each(CHAT_COMMANDS.map((c) => [c.name, c] as const))('%s keeps to the Discord limits', (_name, command) => {
    expect(command.name).toMatch(NAME);
    expect(command.name).toBe(command.name.toLowerCase());
    expect(command.description.length).toBeGreaterThanOrEqual(1);
    expect(command.description.length).toBeLessThanOrEqual(DISCORD_INTERACTION.descriptionMax);
    const options = command.options ?? [];
    expect(options.length).toBeLessThanOrEqual(DISCORD_INTERACTION.optionsPerCommandMax);
    const seen = new Set<string>();
    let optionalSeen = false;
    for (const option of options) {
      expect(option.name).toMatch(NAME);
      expect(seen.has(option.name), `duplicate ${option.name}`).toBe(false);
      seen.add(option.name);
      expect(option.description.length).toBeGreaterThanOrEqual(1);
      expect(option.description.length).toBeLessThanOrEqual(DISCORD_INTERACTION.descriptionMax);
      if (option.required) expect(optionalSeen, `${option.name}: required after optional`).toBe(false);
      else optionalSeen = true;
      checkChoices(option);
    }
  });

  it('restrict the commands that change subscriptions to Manage Channel and leave the read-only ones open', () => {
    const open = ['info', 'Mod info'];
    for (const command of COMMAND_DEFINITIONS) {
      expect(command.default_member_permissions, command.name).toBe(open.includes(command.name) ? undefined : '16');
      expect(Object.hasOwn(command, 'default_member_permissions'), command.name).toBe(!open.includes(command.name));
    }
  });

  it('are never offered in direct messages', () => {
    for (const command of COMMAND_DEFINITIONS) expect(command.dm_permission).toBe(false);
  });

  it('give info an optional autocompleting mod and register Mod info as a nameable message command', () => {
    const info = CHAT_COMMANDS.find((c) => c.name === 'info')!;
    expect(info.options).toEqual([expect.objectContaining({ name: 'mod', autocomplete: true, type: OPTION_TYPE.string })]);
    expect(info.options![0]!.required).toBeUndefined();
    const modInfo = COMMAND_DEFINITIONS.find((c) => c.name === 'Mod info')!;
    expect(modInfo).toEqual({ name: 'Mod info', description: '', type: 3, dm_permission: false });
    expect(modInfo.name.length).toBeLessThanOrEqual(DISCORD_INTERACTION.commandNameMax);
  });

  it('give subscribe the documented options, with autocomplete on owner and mod and fixed choices on source, kind and mode', () => {
    const subscribe = COMMAND_DEFINITIONS.find((c) => c.name === 'subscribe')!;
    expect(subscribe.options!.map((o) => o.name)).toEqual(['owner', 'mod', 'category', 'source', 'kind', 'mode', 'interval', 'label', 'thread_per_mod']);
    const byName = Object.fromEntries(subscribe.options!.map((o) => [o.name, o]));
    expect(byName.owner).toMatchObject({ autocomplete: true, type: OPTION_TYPE.string });
    expect(byName.mod).toMatchObject({ autocomplete: true });
    expect(byName.source!.choices!.map((c) => c.value)).toEqual(['thunderstore', 'hexium', 'nexus']);
    expect(byName.kind!.choices!.map((c) => c.value)).toEqual(['new', 'update', 'both']);
    expect(byName.mode!.choices!.map((c) => c.value)).toEqual(['immediate', 'digest']);
    expect(byName.interval).toMatchObject({ type: OPTION_TYPE.integer, min_value: 5, max_value: 1440 });
    expect(byName.label).toMatchObject({ max_length: 100 });
    expect(byName.thread_per_mod).toMatchObject({ type: OPTION_TYPE.boolean });
  });

  it('require the subscription of unsubscribe and autocomplete it', () => {
    const unsubscribe = COMMAND_DEFINITIONS.find((c) => c.name === 'unsubscribe')!;
    expect(unsubscribe.options).toEqual([expect.objectContaining({ name: 'subscription', required: true, autocomplete: true })]);
  });

  it('give pause an optional autocompleted subscription and a short optional duration, and continue the subscription alone', () => {
    const named = (name: string) => COMMAND_DEFINITIONS.find((c) => c.name === name)!;
    expect(named('pause').options).toEqual([
      expect.objectContaining({ name: 'subscription', autocomplete: true }),
      expect.objectContaining({ name: 'for', type: OPTION_TYPE.string, max_length: 10 }),
    ]);
    expect(named('continue').options).toEqual([expect.objectContaining({ name: 'subscription', autocomplete: true })]);
    for (const option of [...named('pause').options!, ...named('continue').options!]) expect(option.required).toBeFalsy();
  });

  it('never combine autocomplete with fixed choices, which Discord rejects', () => {
    for (const command of CHAT_COMMANDS) for (const option of command.options ?? []) expect(option.autocomplete && option.choices, option.name).toBeFalsy();
  });
});

function checkChoices(option: CommandOptionDefinition): void {
  const choices = option.choices ?? [];
  expect(choices.length).toBeLessThanOrEqual(DISCORD_INTERACTION.choicesPerOptionMax);
  for (const choice of choices) {
    expect(choice.name.length).toBeGreaterThanOrEqual(1);
    expect(choice.name.length).toBeLessThanOrEqual(DISCORD_INTERACTION.choiceNameMax);
    expect(choice.value.length).toBeGreaterThanOrEqual(1);
    expect(choice.value.length).toBeLessThanOrEqual(DISCORD_INTERACTION.choiceValueMax);
  }
}
