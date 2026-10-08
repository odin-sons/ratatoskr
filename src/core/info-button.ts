// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD } from './constants.ts';

/** The part of a button's `custom_id` before the first colon; the interactions router dispatches on it. */
export const INFO_BUTTON_PREFIX = 'info';

/** `custom_id` of the Info button of a mod: `info:<source>:<packageId>`; null when it does not fit in 100 characters. */
export function infoButtonId(source: string, packageId: string): string | null {
  const id = `${INFO_BUTTON_PREFIX}:${source}:${packageId}`;
  return id.length <= DISCORD.customIdMax ? id : null;
}

/** The mod behind an Info button; a source id holds a colon itself, so it is matched against the configured ones. */
export function parseInfoButtonId(customId: string, sources: readonly string[]): { source: string; packageId: string } | null {
  if (!customId.startsWith(`${INFO_BUTTON_PREFIX}:`)) return null;
  const rest = customId.slice(INFO_BUTTON_PREFIX.length + 1);
  for (const source of sources) {
    if (rest.startsWith(`${source}:`) && rest.length > source.length + 1) return { source, packageId: rest.slice(source.length + 1) };
  }
  return null;
}
