// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CHANNEL_TYPE } from '../interactions/constants.ts';
import { createChannelKindResolver } from './channel-kind.ts';

const TOKEN = 'BotTokenSecret_abc-123.xyz';
const CHANNEL = '123456789012345678';

function resolverFor(respond: () => Response | Promise<Response>) {
  const requests: { url: string; authorization: string | undefined }[] = [];
  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    requests.push({ url: String(input), authorization: (init.headers as Record<string, string>)['authorization'] });
    return respond();
  };
  return { resolve: createChannelKindResolver(TOKEN, impl as typeof fetch), requests };
}

const typed = (type: unknown, status = 200): Response => new Response(JSON.stringify({ id: CHANNEL, type }), { status });

describe('createChannelKindResolver', () => {
  it.each([
    [CHANNEL_TYPE.guildForum, 'forum'],
    [CHANNEL_TYPE.guildMedia, 'forum'],
    [CHANNEL_TYPE.guildText, 'text'],
    [CHANNEL_TYPE.guildAnnouncement, 'text'],
  ])('maps channel type %i to %s', async (type, kind) => {
    const { resolve, requests } = resolverFor(() => typed(type));
    expect(await resolve(CHANNEL)).toBe(kind);
    expect(requests).toEqual([{ url: `https://discord.com/api/v10/channels/${CHANNEL}`, authorization: `Bot ${TOKEN}` }]);
  });

  it('answers null for a channel type it cannot route, an error status, a bad body, a network error and a malformed id', async () => {
    expect(await resolverFor(() => typed(CHANNEL_TYPE.publicThread)).resolve(CHANNEL)).toBeNull();
    expect(await resolverFor(() => typed(CHANNEL_TYPE.guildForum, 403)).resolve(CHANNEL)).toBeNull();
    expect(await resolverFor(() => new Response('not json')).resolve(CHANNEL)).toBeNull();
    expect(await resolverFor(() => Promise.reject(new Error('offline'))).resolve(CHANNEL)).toBeNull();
    const never = resolverFor(() => typed(CHANNEL_TYPE.guildForum));
    expect(await never.resolve('../users/@me')).toBeNull();
    expect(never.requests).toEqual([]);
  });
});
