// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Messages } from '../i18n/index.ts';
import { PERMISSION, PERMISSION_NAME, type BotPermission } from './constants.ts';
import { reply, type InteractionResponse } from './responses.ts';
import type { Interaction } from './types.ts';

const BITFIELD = /^\d{1,20}$/;

function parseBitfield(value: string | undefined): bigint {
  return value !== undefined && BITFIELD.test(value) ? BigInt(value) : 0n;
}

/** True with Manage Channel or Administrator in the invoking member's permissions in this channel. */
export function hasManageChannel(interaction: Interaction): boolean {
  return (parseBitfield(interaction.member?.permissions) & (PERMISSION.manageChannels | PERMISSION.administrator)) !== 0n;
}

/** Null when allowed; otherwise the ephemeral denial to return. */
export function requireManageChannel(interaction: Interaction, messages: Messages): InteractionResponse | null {
  return hasManageChannel(interaction) ? null : reply({ content: messages.missingManageChannel }, { ephemeral: true });
}

/** Display names of the `needed` permissions the bot lacks in the channel; all of them when `app_permissions` is absent. */
export function checkBotPermissions(interaction: Interaction, needed: readonly BotPermission[]): string[] {
  const granted = parseBitfield(interaction.app_permissions);
  if ((granted & PERMISSION.administrator) !== 0n) return [];
  return needed.filter((name) => (granted & PERMISSION[name]) === 0n).map((name) => PERMISSION_NAME[name]);
}
