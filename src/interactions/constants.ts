// SPDX-License-Identifier: AGPL-3.0-or-later

/** Source: Discord developer docs, "Interactions" (Interaction Type). */
export const INTERACTION_TYPE = {
  ping: 1,
  applicationCommand: 2,
  messageComponent: 3,
  applicationCommandAutocomplete: 4,
  modalSubmit: 5,
} as const;

/** Source: Discord developer docs, "Receiving and Responding" (Interaction Callback Type). */
export const INTERACTION_CALLBACK = {
  pong: 1,
  channelMessage: 4,
  deferredChannelMessage: 5,
  updateMessage: 7,
  autocompleteResult: 8,
} as const;

/** Source: Discord developer docs, "Message" (Message Flags: EPHEMERAL, 1 << 6). */
export const MESSAGE_FLAG_EPHEMERAL = 1 << 6;

/** Source: Discord developer docs, "Channel" (Channel Types). */
export const CHANNEL_TYPE = {
  guildText: 0,
  guildAnnouncement: 5,
  announcementThread: 10,
  publicThread: 11,
  privateThread: 12,
  guildForum: 15,
  guildMedia: 16,
} as const;

/** Source: Discord developer docs, "Permissions" (bit positions of the permission flags). */
export const PERMISSION = {
  administrator: 1n << 3n,
  manageChannels: 1n << 4n,
  viewChannel: 1n << 10n,
  sendMessages: 1n << 11n,
  embedLinks: 1n << 14n,
  createPublicThreads: 1n << 35n,
  sendMessagesInThreads: 1n << 38n,
} as const;

/** Display names of the permissions the bot checks, as the Discord client shows them. */
export const PERMISSION_NAME = {
  viewChannel: 'View Channel',
  sendMessages: 'Send Messages',
  embedLinks: 'Embed Links',
  sendMessagesInThreads: 'Send Messages in Threads',
  createPublicThreads: 'Create Public Threads',
} as const;

export type BotPermission = keyof typeof PERMISSION_NAME;

/** Source: docs/spec.md "Commands" (`/subscribe` refuses when the bot lacks one of these). */
export const SUBSCRIBE_BOT_PERMISSIONS: readonly BotPermission[] = ['viewChannel', 'sendMessages', 'embedLinks', 'sendMessagesInThreads', 'createPublicThreads'];

/** Source: Discord developer docs, "Receiving and Responding" (request security headers). */
export const SIGNATURE_HEADER = 'x-signature-ed25519';
export const TIMESTAMP_HEADER = 'x-signature-timestamp';

/** Ed25519 sizes in bytes. Source: RFC 8032. */
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

/** Upper bound on the timestamp header; Discord sends a Unix time in seconds. */
export const TIMESTAMP_HEADER_MAX_LENGTH = 32;

export const INTERACTIONS_PATH = '/interactions';

/** Interaction token alphabet and length. Observed, not documented: URL-safe base64 characters, well under 512. */
export const INTERACTION_TOKEN = /^[A-Za-z0-9_-]{1,512}$/;

export const SNOWFLAKE = /^\d{17,20}$/;
