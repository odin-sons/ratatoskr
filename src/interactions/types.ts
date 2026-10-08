// SPDX-License-Identifier: AGPL-3.0-or-later
import { INTERACTION_TOKEN, MODAL, SNOWFLAKE } from './constants.ts';

export interface InteractionChannel {
  id: string;
  type: number;
  parent_id?: string;
}

export interface InteractionData {
  name?: string;
  /** Application command type. */
  type?: number;
  custom_id?: string;
  options?: unknown[];
  /** Values of the text inputs of a modal submit, by their `custom_id`. */
  fields?: Record<string, string>;
}

/** The fields of a signed interaction payload the bot reads; everything else is dropped. */
export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel?: InteractionChannel;
  member?: { permissions?: string; user?: { id: string } };
  app_permissions?: string;
  data?: InteractionData;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const snowflake = (value: unknown): string | undefined => (typeof value === 'string' && SNOWFLAKE.test(value) ? value : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function parseChannel(value: unknown): InteractionChannel | undefined {
  if (!isRecord(value)) return undefined;
  const id = snowflake(value.id);
  if (id === undefined || typeof value.type !== 'number') return undefined;
  const parentId = snowflake(value.parent_id);
  return parentId === undefined ? { id, type: value.type } : { id, type: value.type, parent_id: parentId };
}

function parseMember(value: unknown): Interaction['member'] {
  if (!isRecord(value)) return undefined;
  const permissions = text(value.permissions);
  const userId = isRecord(value.user) ? snowflake(value.user.id) : undefined;
  return {
    ...(permissions === undefined ? {} : { permissions }),
    ...(userId === undefined ? {} : { user: { id: userId } }),
  };
}

/** The text inputs of a modal submit: at most five, each a string of at most 4000 characters. */
function parseFields(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const fields: Record<string, string> = {};
  let count = 0;
  for (const row of value) {
    if (!isRecord(row) || !Array.isArray(row.components)) continue;
    for (const input of row.components) {
      if (count >= MODAL.fieldsMax) break;
      if (!isRecord(input) || input.type !== MODAL.textInput) continue;
      const id = text(input.custom_id);
      const content = text(input.value);
      if (id === undefined || id === '' || content === undefined || content.length > MODAL.textInputMax) continue;
      fields[id] = content;
      count += 1;
    }
  }
  return fields;
}

function parseData(value: unknown): InteractionData | undefined {
  if (!isRecord(value)) return undefined;
  const name = text(value.name);
  const customId = text(value.custom_id);
  const fields = parseFields(value.components);
  return {
    ...(name === undefined ? {} : { name }),
    ...(typeof value.type === 'number' && Number.isInteger(value.type) ? { type: value.type } : {}),
    ...(customId === undefined ? {} : { custom_id: customId }),
    ...(Array.isArray(value.options) ? { options: value.options as unknown[] } : {}),
    ...(fields === undefined ? {} : { fields }),
  };
}

/** Narrows a parsed payload to an `Interaction`; null when the identity fields are missing or malformed. */
export function parseInteraction(value: unknown): Interaction | null {
  if (!isRecord(value)) return null;
  const id = snowflake(value.id);
  const applicationId = snowflake(value.application_id);
  if (id === undefined || applicationId === undefined) return null;
  if (typeof value.type !== 'number' || !Number.isInteger(value.type)) return null;
  if (typeof value.token !== 'string' || !INTERACTION_TOKEN.test(value.token)) return null;
  const guildId = snowflake(value.guild_id);
  const channel = parseChannel(value.channel);
  const member = parseMember(value.member);
  const appPermissions = text(value.app_permissions);
  const data = parseData(value.data);
  return {
    id,
    application_id: applicationId,
    type: value.type,
    token: value.token,
    ...(guildId === undefined ? {} : { guild_id: guildId }),
    ...(channel === undefined ? {} : { channel }),
    ...(member === undefined ? {} : { member }),
    ...(appPermissions === undefined ? {} : { app_permissions: appPermissions }),
    ...(data === undefined ? {} : { data }),
  };
}
