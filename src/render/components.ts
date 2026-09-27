// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD } from '../core/constants.ts';
import type { DiscordActionRow, DiscordLinkButton } from '../core/types.ts';
import { safeUrl } from './text.ts';

const PAGE_LABEL = 'Mod page';
const DOWNLOAD_LABEL = 'Download';

/** A normalised http(s) URL without credentials that fits a link button, or null. */
export function linkButtonUrl(raw: string | null | undefined): string | null {
  const safe = safeUrl(raw);
  if (safe === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(safe);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  return parsed.href.length <= DISCORD.buttonUrlMax ? parsed.href : null;
}

function button(label: string, raw: string | null | undefined): DiscordLinkButton | null {
  const url = linkButtonUrl(raw);
  return url === null ? null : { type: 2, style: 5, label, url };
}

/** One action row of link buttons (mod page, download); invalid URLs drop their button; undefined when none remain. */
export function buildComponents(pageUrl: string | null | undefined, downloadUrl: string | null | undefined): DiscordActionRow[] | undefined {
  const buttons: DiscordLinkButton[] = [];
  for (const candidate of [button(PAGE_LABEL, pageUrl), button(DOWNLOAD_LABEL, downloadUrl)]) {
    if (candidate !== null && buttons.length < DISCORD.buttonsPerRow) buttons.push(candidate);
  }
  return buttons.length === 0 ? undefined : [{ type: 1, components: buttons }];
}
