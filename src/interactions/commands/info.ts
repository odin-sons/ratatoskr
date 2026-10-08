// SPDX-License-Identifier: AGPL-3.0-or-later
import { eventId } from '../../core/ids.ts';
import { parseInfoButtonId } from '../../core/info-button.ts';
import type { ModEvent, PackageSnapshot, SourceId } from '../../core/types.ts';
import type { Messages } from '../../i18n/index.ts';
import { buildImmediate } from '../../render/immediate.ts';
import { resolveRatatoskrEmoji, resolveStoreEmojis } from '../../render/emoji.ts';
import { stripUnsafeChars } from '../../text/sanitize.ts';
import { CHANNEL_TYPE } from '../constants.ts';
import { parseOptions } from '../options.ts';
import { autocomplete, reply, type InteractionMessage, type InteractionResponse } from '../responses.ts';
import type { InteractionHandler } from '../router.ts';
import type { Interaction } from '../types.ts';
import type { CommandDeps } from './deps.ts';
import { modChoices } from './mod-choices.ts';
import { display } from './view.ts';

const ephemeral = (content: string): InteractionResponse => reply({ content }, { ephemeral: true });

const THREAD_TYPES: readonly number[] = [CHANNEL_TYPE.announcementThread, CHANNEL_TYPE.publicThread, CHANNEL_TYPE.privateThread];

/** The thread or forum post the command runs in and its parent channel, from the signed payload; undefined in a channel. */
function threadOf(interaction: Interaction): { threadId: string; channelId: string } | undefined {
  const channel = interaction.channel;
  if (channel === undefined || channel.parent_id === undefined || !THREAD_TYPES.includes(channel.type)) return undefined;
  return { threadId: channel.id, channelId: channel.parent_id };
}

/** The event of the stored version as the renderer's input, standing in for the package as it is now; `/info` shows downloads even right after a first release. */
function infoEvent(pkg: PackageSnapshot, current: ModEvent | null): ModEvent {
  return {
    id: `info|${pkg.source}|${pkg.packageId}`,
    kind: 'update',
    versionFrom: current?.versionFrom ?? null,
    versionTo: pkg.version,
    changelog: current?.changelog ?? null,
    changelogUrl: current?.changelogUrl ?? null,
    createdAt: current?.createdAt ?? pkg.updatedAt,
    pkg,
    alsoOn: [],
  };
}

/** The event of a mod's stored version, standing in for the mod as it is now; null for an unknown mod. NSFW mods are never returned. */
export async function modEventFor(deps: CommandDeps, packageId: string, sources: SourceId[]): Promise<ModEvent | null> {
  const { store } = deps;
  const pkg = (await store.getPackagesById(packageId, sources)).find((candidate) => !candidate.isNsfw);
  if (pkg === undefined) return null;
  return infoEvent(pkg, await store.getEventById(eventId(pkg.source, pkg.packageId, pkg.version)));
}

/** NSFW mods are never shown: the gate is fail-closed because `/info` has no subscription to opt in with. */
async function showMod(deps: CommandDeps, messages: Messages, packageId: string, sources: SourceId[]): Promise<InteractionResponse> {
  const event = await modEventFor(deps, packageId, sources);
  if (event === null) return ephemeral(messages.modNotFound(display(packageId)));
  const rendered = buildImmediate(event, (deps.now ?? (() => new Date()))(), {
    messages,
    storeEmojis: resolveStoreEmojis(deps.storeEmojis),
    ratatoskrEmoji: resolveRatatoskrEmoji(deps.ratatoskrEmoji),
    infoButton: false,
    immediateTemplate: null,
    digestLineTemplate: null,
    optionalButtons: true,
    includeChangelog: true,
  });
  return reply({ flags: rendered.flags, components: rendered.components } satisfies InteractionMessage, { ephemeral: true });
}

const enabledSources = (deps: CommandDeps): SourceId[] => deps.sources.filter((source) => source.enabled).map((source) => source.id);

export function createInfoCommand(deps: CommandDeps): InteractionHandler {
  return async (interaction, ctx): Promise<InteractionResponse> => {
    const { messages } = ctx;
    const typed = stripUnsafeChars(parseOptions(interaction).string('mod') ?? '').trim();
    if (typed !== '') return showMod(deps, messages, typed, enabledSources(deps));
    const here = threadOf(interaction);
    const thread = here === undefined ? null : await deps.store.getModThreadByThreadId(here.channelId, here.threadId);
    if (thread === null) return ephemeral(messages.infoNeedsMod);
    return showMod(deps, messages, thread.packageId, [thread.source]);
  };
}

export function createInfoAutocomplete(deps: CommandDeps): InteractionHandler {
  return async (interaction): Promise<InteractionResponse> => {
    const focused = parseOptions(interaction).focused;
    return autocomplete(focused?.name === 'mod' ? await modChoices(deps.store, focused.value.trim(), { sfwOnly: true }) : []);
  };
}

/** The Info button under a message the bot sent: the same answer as `/info` for the mod named in the button. */
export function createInfoButton(deps: CommandDeps): InteractionHandler {
  return async (interaction, ctx): Promise<InteractionResponse> => {
    const { messages } = ctx;
    const mod = parseInfoButtonId(interaction.data?.custom_id ?? '', enabledSources(deps));
    if (mod === null) return ephemeral(messages.unknownCommand);
    return showMod(deps, messages, mod.packageId, [mod.source]);
  };
}
