// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD_API_BASE, DISCORD_SEND_TIMEOUT_MS, PROJECT } from '../core/constants.ts';
import type { ChannelKind } from '../core/types.ts';
import { CHANNEL_TYPE } from '../interactions/constants.ts';
import { isSnowflake } from './guards.ts';

const USER_AGENT = `DiscordBot (${PROJECT.repoUrl}, ${PROJECT.version})`;

/** Looks a channel up with `GET /channels/{id}`: forum and media channels are `forum`, text and announcement channels `text`, anything else or any failure null. */
export function createChannelKindResolver(token: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): (channelId: string) => Promise<ChannelKind | null> {
  return async (channelId) => {
    if (!isSnowflake(channelId)) return null;
    try {
      const res = await fetchImpl(`${DISCORD_API_BASE}/channels/${channelId}`, {
        headers: { 'user-agent': USER_AGENT, authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(DISCORD_SEND_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!res.ok) return null;
      const type = ((await res.json()) as { type?: unknown } | null)?.type;
      if (type === CHANNEL_TYPE.guildForum || type === CHANNEL_TYPE.guildMedia) return 'forum';
      if (type === CHANNEL_TYPE.guildText || type === CHANNEL_TYPE.guildAnnouncement) return 'text';
      return null;
    } catch {
      return null;
    }
  };
}
