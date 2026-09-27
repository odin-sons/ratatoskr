// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD, PROJECT } from '../core/constants.ts';

/** AGPL notice text. */
export const PROJECT_LINE = `-# [${PROJECT.name} v${PROJECT.version}](${PROJECT.repoUrl})`;

/** Zero-width space: Discord rejects empty field names. */
export const ZERO_WIDTH_SPACE = '\u200b';

/** AGPL notice as the last, non-inline field of the last embed of every message. */
export const PROJECT_FIELD = { name: ZERO_WIDTH_SPACE, value: PROJECT_LINE } as const;

export const FOOTER_SEP = ' · ';

/** Emoji at the start of the info line, per event kind. */
export const KIND_EMOJI = { new: '🆕', update: '\u2b06\ufe0f' } as const;

const PROJECT_FIELD_LENGTH = PROJECT_FIELD.name.length + PROJECT_FIELD.value.length;
const PAGE_SUFFIX_RESERVE = `${FOOTER_SEP}(9999/9999)`.length;

/** Text budget left for content once the project field and page suffix are added to a message's last embed. */
export const TEXT_BUDGET = DISCORD.embedTotalTextMax - (PROJECT_FIELD_LENGTH + PAGE_SUFFIX_RESERVE);

/** Renderer-internal caps (design choices, not upstream limits). */
export const CAPS = {
  name: 256,
  version: 40,
  owner: 64,
  url: 512,
  excerpt: 300,
  alsoOnLine: 300,
  alsoOnEntries: 4,
  groupLine: 1000,
  categoryEntries: 8,
  categoryName: 32,
  categoriesValue: 200,
  /** Raw characters read per output character of a field. */
  rawFactor: 8,
} as const;
