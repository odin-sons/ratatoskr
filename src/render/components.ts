// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD } from '../core/constants.ts';
import { hasDeliverableHost } from '../text/url.ts';
import type { DiscordActionRow, DiscordButton, DiscordButtonEmoji, DiscordCustomButton, DiscordLinkButton, ModEvent } from '../core/types.ts';
import { infoButtonId } from '../core/info-button.ts';
import type { Ctx } from './context.ts';
import { buttonEmoji } from './emoji.ts';
import { BUTTON_EMOJI, SECTION_EMOJI } from './layout.ts';
import { STORES } from './stores.ts';
import { safeUrl } from './text.ts';

/** A normalised http(s) URL without credentials, with a host Discord accepts, that fits a link button or a thumbnail, or null. */
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
  if (parsed.username !== '' || parsed.password !== '' || !hasDeliverableHost(parsed.hostname)) return null;
  return parsed.href.length <= DISCORD.buttonUrlMax ? parsed.href : null;
}

function button(label: string, raw: string | null | undefined, emoji: string): DiscordLinkButton | null {
  const url = linkButtonUrl(raw);
  if (url === null || label.length === 0 || label.length > DISCORD.buttonLabelMax) return null;
  const built: DiscordLinkButton = { type: 2, style: 5, label, url };
  const icon: DiscordButtonEmoji | null = buttonEmoji(emoji);
  if (icon !== null) built.emoji = icon;
  return built;
}

/**
 * The action row of a detailed message: mod page, download and website, each only with a valid URL. The AGPL source
 * link lives outside the row, as the message's trailing subtext block (see `sourceSubtext`), so it is not a candidate here.
 * Null when none of the candidates has a usable URL: an empty action row is not a valid component.
 */
export function buildActionRow(event: ModEvent, ctx: Ctx): DiscordActionRow | null {
  const candidates = [pageButton(event, ctx)];
  if (ctx.optionalButtons) candidates.push(downloadButton(event, ctx), websiteButton(event, ctx));
  return rowOf(candidates);
}

export function pageButton(event: ModEvent, ctx: Ctx): DiscordLinkButton | null {
  const { pkg } = event;
  return button(ctx.messages.modPage, pkg.url, ctx.storeEmojis[pkg.store] ?? STORES[pkg.store].buttonEmoji);
}

export function downloadButton(event: ModEvent, ctx: Ctx): DiscordLinkButton | null {
  return button(ctx.messages.download, event.pkg.downloadUrl, BUTTON_EMOJI.download);
}

export function websiteButton(event: ModEvent, ctx: Ctx): DiscordLinkButton | null {
  return button(ctx.messages.website, event.pkg.websiteUrl, BUTTON_EMOJI.website);
}

/** The Info button of a mod; null for a message that is not sent by the bot, or when the mod's id is too long for a `custom_id`. */
export function infoButton(event: ModEvent, ctx: Ctx): DiscordCustomButton | null {
  if (!ctx.infoButton) return null;
  const id = infoButtonId(event.pkg.source, event.pkg.packageId);
  const label = ctx.messages.infoButton;
  if (id === null || label.length === 0 || label.length > DISCORD.buttonLabelMax) return null;
  const built: DiscordCustomButton = { type: 2, style: 2, label, custom_id: id };
  const icon = buttonEmoji(SECTION_EMOJI.info);
  if (icon !== null) built.emoji = icon;
  return built;
}

/** A row of the buttons that exist, at most `DISCORD.buttonsPerRow`; null when none does, since an empty row is invalid. */
export function rowOf(candidates: readonly (DiscordButton | null)[]): DiscordActionRow | null {
  const buttons: DiscordButton[] = [];
  for (const candidate of candidates) {
    if (candidate !== null && buttons.length < DISCORD.buttonsPerRow) buttons.push(candidate);
  }
  return buttons.length === 0 ? null : { type: 1, components: buttons };
}
