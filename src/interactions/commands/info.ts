// SPDX-License-Identifier: AGPL-3.0-or-later
import { eventId } from '../../core/ids.ts';
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

/** NSFW mods are never shown: the gate is fail-closed because `/info` has no subscription to opt in with. */
async function showMod(deps: CommandDeps, messages: Messages, packageId: string, sources: SourceId[]): Promise<InteractionResponse> {
  const { store } = deps;
  const pkg = (await store.getPackagesById(packageId, sources)).find((candidate) => !candidate.isNsfw);
  if (pkg === undefined) return ephemeral(messages.modNotFound(display(packageId)));
  const event = infoEvent(pkg, await store.getEventById(eventId(pkg.source, pkg.packageId, pkg.version)));
  const rendered = buildImmediate(event, (deps.now ?? (() => new Date()))(), {
    messages,
    storeEmojis: resolveStoreEmojis(deps.storeEmojis),
    ratatoskrEmoji: resolveRatatoskrEmoji(deps.ratatoskrEmoji),
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

export function createModInfoCommand(deps: CommandDeps): InteractionHandler {
  return async (interaction, ctx): Promise<InteractionResponse> => {
    const { messages } = ctx;
    const targetId = interaction.data?.target_id;
    const record = targetId === undefined ? null : await deps.store.getMessage(targetId);
    if (record === null) return ephemeral(messages.infoMessageUnknown);
    return showMod(deps, messages, record.packageId, [record.source]);
  };
}
