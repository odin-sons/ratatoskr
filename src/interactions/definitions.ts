// SPDX-License-Identifier: AGPL-3.0-or-later
import { ALSO_MATCH_MAX_RULES, DISCORD_INTERACTION, SUBSCRIBE_TEXT_OPTION_MAX, SUBSCRIPTION_LABEL_MAX } from '../core/constants.ts';
import { PAUSE_DURATION_OPTION_MAX } from '../core/pause.ts';
import { DIGEST_INTERVAL_MAX_BOUND, DIGEST_INTERVAL_MIN_BOUND } from '../core/validation.ts';

/** Source: Discord developer docs, "Application Commands" (Application Command Option Type, Application Command Type). */
export const OPTION_TYPE = { string: 3, integer: 4, boolean: 5 } as const;
const CHAT_INPUT = 1;

export interface CommandChoice {
  name: string;
  value: string;
}

export interface CommandOptionDefinition {
  type: (typeof OPTION_TYPE)[keyof typeof OPTION_TYPE];
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
  choices?: CommandChoice[];
  min_value?: number;
  max_value?: number;
  max_length?: number;
}

export interface ChatCommandDefinition {
  name: string;
  description: string;
  type: typeof CHAT_INPUT;
  /** Absent: everyone may use the command. */
  default_member_permissions?: string;
  dm_permission: false;
  options?: CommandOptionDefinition[];
}

export type CommandDefinition = ChatCommandDefinition;

export const INFO_COMMAND_NAME = 'info';

const command = (name: string, description: string, options?: CommandOptionDefinition[]): ChatCommandDefinition => ({
  name,
  description,
  type: CHAT_INPUT,
  default_member_permissions: DISCORD_INTERACTION.manageChannelPermissions,
  dm_permission: false,
  ...(options ? { options } : {}),
});

export const SUBSCRIBE_SOURCE_CHOICES: readonly CommandChoice[] = [
  { name: 'Thunderstore', value: 'thunderstore' },
  { name: 'Hexium', value: 'hexium' },
  { name: 'Nexus Mods', value: 'nexus' },
];

/** Reading mod info is harmless, so `/info` and "Mod info" are open to every member, unlike the commands that change subscriptions. */
const readOnly = (definition: ChatCommandDefinition): ChatCommandDefinition => {
  const { default_member_permissions: _restricted, ...open } = definition;
  return open;
};

export const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  command('subscribe', 'Get mod updates in this channel, thread or forum post', [
    { type: OPTION_TYPE.string, name: 'owner', description: 'Every mod of this author', autocomplete: true, max_length: SUBSCRIBE_TEXT_OPTION_MAX },
    { type: OPTION_TYPE.string, name: 'mod', description: 'One mod', autocomplete: true, max_length: SUBSCRIBE_TEXT_OPTION_MAX },
    { type: OPTION_TYPE.string, name: 'category', description: 'Only mods in this category', max_length: SUBSCRIBE_TEXT_OPTION_MAX },
    { type: OPTION_TYPE.string, name: 'source', description: 'Only this store', choices: [...SUBSCRIBE_SOURCE_CHOICES] },
    {
      type: OPTION_TYPE.string,
      name: 'kind',
      description: 'New mods, updates or both (default: both)',
      choices: [
        { name: 'New mods', value: 'new' },
        { name: 'Updates', value: 'update' },
        { name: 'Both', value: 'both' },
      ],
    },
    {
      type: OPTION_TYPE.string,
      name: 'mode',
      description: 'One message per update, or a periodic digest (default: digest)',
      choices: [
        { name: 'Immediate', value: 'immediate' },
        { name: 'Digest', value: 'digest' },
      ],
    },
    {
      type: OPTION_TYPE.integer,
      name: 'interval',
      description: 'Minutes between digests (digest mode only)',
      min_value: DIGEST_INTERVAL_MIN_BOUND,
      max_value: DIGEST_INTERVAL_MAX_BOUND,
    },
    { type: OPTION_TYPE.string, name: 'label', description: 'Name for this subscription', max_length: SUBSCRIPTION_LABEL_MAX },
    { type: OPTION_TYPE.boolean, name: 'thread_per_mod', description: 'Write each mod into its own thread (immediate mode only)' },
  ]),
  command('unsubscribe', 'Remove a subscription', [
    { type: OPTION_TYPE.string, name: 'subscription', description: 'The subscription to remove', required: true, autocomplete: true },
  ]),
  command('pause', 'Pause the updates of a subscription, or of all subscriptions here', [
    { type: OPTION_TYPE.string, name: 'subscription', description: 'The subscription to pause (default: all here)', autocomplete: true },
    { type: OPTION_TYPE.string, name: 'for', description: 'How long, such as 30m, 2h or 3d (default: until /continue)', max_length: PAUSE_DURATION_OPTION_MAX },
  ]),
  command('continue', 'Resume the updates of a paused subscription, or of all subscriptions here', [
    { type: OPTION_TYPE.string, name: 'subscription', description: 'The subscription to resume (default: all here)', autocomplete: true },
  ]),
  command('filter', 'Show or change what a subscription matches', [
    { type: OPTION_TYPE.string, name: 'subscription', description: 'The subscription', required: true, autocomplete: true },
    {
      type: OPTION_TYPE.string,
      name: 'kind',
      description: 'Which events to deliver',
      choices: [
        { name: 'New mods', value: 'new' },
        { name: 'Updates', value: 'update' },
        { name: 'Both', value: 'both' },
      ],
    },
    { type: OPTION_TYPE.string, name: 'source', description: 'Restrict to one store, or all', choices: [...SUBSCRIBE_SOURCE_CHOICES, { name: 'All stores', value: 'all' }] },
    { type: OPTION_TYPE.boolean, name: 'nsfw', description: 'Deliver adult content too' },
    { type: OPTION_TYPE.boolean, name: 'changelog', description: 'Show the changelog excerpt' },
    { type: OPTION_TYPE.integer, name: 'remove_rule', description: 'Number of an extra rule to remove', min_value: 1, max_value: ALSO_MATCH_MAX_RULES },
    { type: OPTION_TYPE.string, name: 'remove', description: 'An owner, mod or category to remove from the filter', max_length: SUBSCRIBE_TEXT_OPTION_MAX },
  ]),
  command('include', 'Also deliver a mod, an author or a category', [
    { type: OPTION_TYPE.string, name: 'subscription', description: 'The subscription', required: true, autocomplete: true },
    { type: OPTION_TYPE.string, name: 'owner', description: 'Every mod of this author', autocomplete: true, max_length: SUBSCRIBE_TEXT_OPTION_MAX },
    { type: OPTION_TYPE.string, name: 'mod', description: 'One mod', autocomplete: true, max_length: SUBSCRIBE_TEXT_OPTION_MAX },
    { type: OPTION_TYPE.string, name: 'category', description: 'Mods in this category', max_length: SUBSCRIBE_TEXT_OPTION_MAX },
    { type: OPTION_TYPE.string, name: 'source', description: 'Only this store', choices: [...SUBSCRIBE_SOURCE_CHOICES] },
  ]),
  command('exclude', 'Never deliver a mod, an author or a category', [
    { type: OPTION_TYPE.string, name: 'subscription', description: 'The subscription', required: true, autocomplete: true },
    { type: OPTION_TYPE.string, name: 'owner', description: 'Every mod of this author', autocomplete: true, max_length: SUBSCRIBE_TEXT_OPTION_MAX },
    { type: OPTION_TYPE.string, name: 'mod', description: 'One mod', autocomplete: true, max_length: SUBSCRIBE_TEXT_OPTION_MAX },
    { type: OPTION_TYPE.string, name: 'category', description: 'Mods in this category', max_length: SUBSCRIBE_TEXT_OPTION_MAX },
  ]),
  command('list', 'List the subscriptions here', [{ type: OPTION_TYPE.boolean, name: 'all', description: 'The whole server instead of this channel' }]),
  readOnly(
    command(INFO_COMMAND_NAME, 'Show details of a mod', [
      { type: OPTION_TYPE.string, name: 'mod', description: 'The mod (optional inside a mod thread)', autocomplete: true, max_length: SUBSCRIBE_TEXT_OPTION_MAX },
    ]),
  ),
];
