// SPDX-License-Identifier: AGPL-3.0-or-later
import { CHANNEL_TYPE } from './constants.ts';
import type { Interaction } from './types.ts';

export type TargetResolution =
  | { ok: true; channelId: string; threadId?: string }
  | { ok: false; reason: 'dm' | 'unsupported_channel' };

const UNSUPPORTED = { ok: false, reason: 'unsupported_channel' } as const;

/**
 * Where a command applies, from the signed payload only. A text channel is itself; a thread or forum post is
 * its parent channel plus the thread, or, with `threadPerMod`, the parent alone.
 */
export function resolveTarget(interaction: Interaction, options: { threadPerMod?: boolean } = {}): TargetResolution {
  if (interaction.guild_id === undefined) return { ok: false, reason: 'dm' };
  const channel = interaction.channel;
  if (channel === undefined) return UNSUPPORTED;
  switch (channel.type) {
    case CHANNEL_TYPE.guildText:
    case CHANNEL_TYPE.guildAnnouncement:
      return { ok: true, channelId: channel.id };
    case CHANNEL_TYPE.announcementThread:
    case CHANNEL_TYPE.publicThread:
    case CHANNEL_TYPE.privateThread:
      if (channel.parent_id === undefined) return UNSUPPORTED;
      return options.threadPerMod ? { ok: true, channelId: channel.parent_id } : { ok: true, channelId: channel.parent_id, threadId: channel.id };
    default:
      return UNSUPPORTED;
  }
}
