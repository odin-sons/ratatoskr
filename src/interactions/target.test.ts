// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CHANNEL_ID, GUILD_ID, THREAD_ID, interactionPayload } from '../testing/signing.ts';
import { CHANNEL_TYPE, PERMISSION } from './constants.ts';
import { checkBotPermissions, hasManageChannel, requireManageChannel } from './permissions.ts';
import { resolveTarget } from './target.ts';
import { parseInteraction, type Interaction } from './types.ts';
import { en } from '../i18n/en.ts';

const PARENT = '923456789012345678';

function make(over: Record<string, unknown>): Interaction {
  const parsed = parseInteraction(interactionPayload(over));
  if (parsed === null) throw new Error('bad test interaction');
  return parsed;
}

const inChannel = (type: number, extra: Record<string, unknown> = {}): Interaction => make({ guild_id: GUILD_ID, channel: { id: THREAD_ID, type, ...extra } });

describe('resolveTarget', () => {
  it.each([CHANNEL_TYPE.guildText, CHANNEL_TYPE.guildAnnouncement])('a channel of type %i is the target itself', (type) => {
    expect(resolveTarget(make({ guild_id: GUILD_ID, channel: { id: CHANNEL_ID, type } }))).toEqual({ ok: true, channelId: CHANNEL_ID });
  });

  it.each([CHANNEL_TYPE.announcementThread, CHANNEL_TYPE.publicThread, CHANNEL_TYPE.privateThread])('a thread of type %i targets its parent and itself', (type) => {
    expect(resolveTarget(inChannel(type, { parent_id: PARENT }))).toEqual({ ok: true, channelId: PARENT, threadId: THREAD_ID });
  });

  it.each([CHANNEL_TYPE.announcementThread, CHANNEL_TYPE.publicThread, CHANNEL_TYPE.privateThread])('with threadPerMod a thread of type %i targets the parent channel alone', (type) => {
    expect(resolveTarget(inChannel(type, { parent_id: PARENT }), { threadPerMod: true })).toEqual({ ok: true, channelId: PARENT });
  });

  it('refuses a direct message', () => {
    expect(resolveTarget(make({ channel: { id: CHANNEL_ID, type: 1 } }))).toEqual({ ok: false, reason: 'dm' });
    expect(resolveTarget(make({ guild_id: undefined, channel: { id: CHANNEL_ID, type: CHANNEL_TYPE.guildText } }))).toEqual({ ok: false, reason: 'dm' });
  });

  it.each([
    ['a voice channel', 2],
    ['a category', 4],
    ['the forum itself', CHANNEL_TYPE.guildForum],
    ['an unknown type', 99],
  ])('refuses %s', (_name, type) => {
    expect(resolveTarget(inChannel(type))).toEqual({ ok: false, reason: 'unsupported_channel' });
  });

  it('refuses a thread without a parent and a payload without a channel', () => {
    expect(resolveTarget(inChannel(CHANNEL_TYPE.publicThread))).toEqual({ ok: false, reason: 'unsupported_channel' });
    expect(resolveTarget(make({ guild_id: GUILD_ID }))).toEqual({ ok: false, reason: 'unsupported_channel' });
  });

  it('ignores command options: only the signed channel counts', () => {
    const interaction = make({
      guild_id: GUILD_ID,
      channel: { id: CHANNEL_ID, type: CHANNEL_TYPE.guildText },
      data: { name: 'subscribe', options: [{ name: 'channel', value: PARENT }, { name: 'guild_id', value: PARENT }] },
    });
    expect(resolveTarget(interaction)).toEqual({ ok: true, channelId: CHANNEL_ID });
  });
});

describe('permissions', () => {
  const member = (permissions: string | undefined): Interaction => make({ member: permissions === undefined ? {} : { permissions } });

  it('allows Manage Channel and Administrator, given as bigint strings beyond 2^53', () => {
    expect(hasManageChannel(member(String(PERMISSION.manageChannels)))).toBe(true);
    expect(hasManageChannel(member(String(PERMISSION.administrator)))).toBe(true);
    expect(hasManageChannel(member(String(PERMISSION.manageChannels | PERMISSION.sendMessagesInThreads | PERMISSION.createPublicThreads)))).toBe(true);
    expect(hasManageChannel(member(String(PERMISSION.sendMessagesInThreads | PERMISSION.viewChannel)))).toBe(false);
  });

  it.each([undefined, '', 'abc', '-1', '1.5', '0x10', '9'.repeat(40)])('denies a missing or malformed permissions value (%s)', (value) => {
    expect(hasManageChannel(member(value))).toBe(false);
  });

  it('denies a payload without a member (a direct message)', () => {
    expect(hasManageChannel(make({}))).toBe(false);
  });

  it('requireManageChannel returns null when allowed and an ephemeral denial otherwise', () => {
    expect(requireManageChannel(member(String(PERMISSION.manageChannels)), en)).toBeNull();
    expect(requireManageChannel(member('0'), en)).toEqual({ type: 4, data: { content: en.missingManageChannel, flags: 64, allowed_mentions: { parse: [] } } });
  });

  describe('checkBotPermissions', () => {
    const all = ['viewChannel', 'sendMessages', 'embedLinks', 'sendMessagesInThreads', 'createPublicThreads'] as const;
    const bits = (...names: (keyof typeof PERMISSION)[]): string => String(names.reduce((sum, name) => sum | PERMISSION[name], 0n));

    it('names every permission when app_permissions is absent or malformed', () => {
      expect(checkBotPermissions(make({}), all)).toEqual(['View Channel', 'Send Messages', 'Embed Links', 'Send Messages in Threads', 'Create Public Threads']);
      expect(checkBotPermissions(make({ app_permissions: 'x' }), all)).toHaveLength(5);
    });

    it('names only what is missing, including bits above 2^32', () => {
      expect(checkBotPermissions(make({ app_permissions: bits('viewChannel', 'sendMessages', 'embedLinks') }), all)).toEqual(['Send Messages in Threads', 'Create Public Threads']);
      expect(checkBotPermissions(make({ app_permissions: bits('viewChannel', 'sendMessages', 'embedLinks', 'sendMessagesInThreads') }), all)).toEqual(['Create Public Threads']);
    });

    it('returns nothing when everything is granted, or the bot is an Administrator, or nothing is needed', () => {
      expect(checkBotPermissions(make({ app_permissions: bits(...all) }), all)).toEqual([]);
      expect(checkBotPermissions(make({ app_permissions: bits('administrator') }), all)).toEqual([]);
      expect(checkBotPermissions(make({}), [])).toEqual([]);
    });
  });
});
