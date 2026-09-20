// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD, PROJECT } from '../core/constants.ts';

export const SOURCE_FOOTER = `${PROJECT.name} v${PROJECT.version} · source: ${PROJECT.repoUrl.replace(/^https?:\/\//, '')}`;

export const FOOTER_SEP = ' · ';

const PAGE_SUFFIX_RESERVE = `${FOOTER_SEP}(9999/9999)`.length;

/** Text budget left for content once the source footer and page suffix are appended to a message's last embed. */
export const TEXT_BUDGET = DISCORD.embedTotalTextMax - (FOOTER_SEP.length + SOURCE_FOOTER.length + PAGE_SUFFIX_RESERVE);

/** Renderer-internal caps (design choices, not upstream limits). */
export const CAPS = {
  name: DISCORD.embedTitleMax,
  version: 40,
  owner: 64,
  url: 512,
  excerpt: 300,
  alsoOnLine: 300,
  alsoOnEntries: 4,
  groupLine: 1000,
  /** Raw characters read per output character of a field. */
  rawFactor: 8,
} as const;
