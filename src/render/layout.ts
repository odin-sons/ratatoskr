// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD, PROJECT } from '../core/constants.ts';
import type { DiscordTextDisplay } from '../core/types.ts';

/** AGPL notice text. */
export const PROJECT_LINE = `-# [${PROJECT.name} v${PROJECT.version}](${PROJECT.repoUrl})`;

/** Zero-width space: Discord rejects empty field names. */
export const ZERO_WIDTH_SPACE = '\u200b';

/** AGPL notice as the last, non-inline field of the last embed of every digest message. */
export const PROJECT_FIELD = { name: ZERO_WIDTH_SPACE, value: PROJECT_LINE } as const;

export const FOOTER_SEP = ' · ';

/** Emoji at the start of the info line, per event kind. */
export const KIND_EMOJI = { new: '🆕', update: '\u2b06\ufe0f' } as const;

/** Emoji in front of the section labels and info line of a detailed message. */
export const SECTION_EMOJI = { description: '📜', categories: '🗂️', info: 'ℹ️' } as const;

/** Button emoji that are not configurable. */
export const BUTTON_EMOJI = { download: '\u2b07\ufe0f', website: '🌐', source: '\u{1f43f}\ufe0f' } as const;

/** AGPL notice as a trailing subtext block, outside the coloured container: small grey text, with a link and an emoji. */
export function sourceSubtext(ratatoskrEmoji: string | null): DiscordTextDisplay {
  return { type: 10, content: `-# ${ratatoskrEmoji ?? BUTTON_EMOJI.source} [${PROJECT.name} v${PROJECT.version}](${PROJECT.repoUrl})` };
}

const PROJECT_FIELD_LENGTH = PROJECT_FIELD.name.length + PROJECT_FIELD.value.length;

/** Characters set aside for the paging footer of the last embed of a message (`Messages.page` at its widest). */
export const PAGE_SUFFIX_RESERVE = 24;

/** Text budget left for content once the project field and page footer are added to a message's last embed. */
export const TEXT_BUDGET = DISCORD.embedTotalTextMax - (PROJECT_FIELD_LENGTH + PAGE_SUFFIX_RESERVE);

/** Renderer-internal caps (design choices, not upstream limits). */
export const CAPS = {
  name: 256,
  version: 40,
  owner: 64,
  url: 512,
  excerpt: 350,
  alsoOnLine: 300,
  alsoOnEntries: 4,
  groupLine: 1000,
  categoryEntries: 8,
  categoryName: 32,
  categoriesValue: 200,
  /** Raw characters read per output character of a field. */
  rawFactor: 8,
} as const;
