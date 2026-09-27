// SPDX-License-Identifier: AGPL-3.0-or-later
import { finalizeExcerpt } from '../changelog/excerpt.ts';
import { FULL_CHANGELOG_LABEL, sanitizeLinks } from '../changelog/links.ts';
import { CHANGELOG_DISPLAY_MAX, DISCORD } from '../core/constants.ts';
import type { DiscordEmbed, ModEvent } from '../core/types.ts';
import { neutralizeMentions, stripHtml, stripUnsafeChars } from '../text/sanitize.ts';
import { linkButtonUrl } from './components.ts';
import type { Ctx } from './context.ts';
import { CAPS, KIND_EMOJI, SECTION_EMOJI } from './layout.ts';
import { STORES } from './stores.ts';
import { formatBytes, formatCount, head, inline, mdLink, safeUrl, wholeCount } from './text.ts';

const FULL_LINK_PREFIX = `[${FULL_CHANGELOG_LABEL}](`;
const INFO_SEP = ' · ';

/** Everything a detailed message shows for one event, as final Markdown; the embed and Components V2 layouts only arrange it. */
export interface DetailedParts {
  /** Title, kind line, info line, also-on line and description: one block of Markdown. */
  header: string;
  /** Changelog excerpt without its label; null when there is none. */
  changelog: string | null;
  /** Comma list without its label; null when empty. */
  categories: string | null;
  /** Thumbnail URL; null unless a usable http(s) URL. */
  icon: string | null;
  color: number;
}

function unixSeconds(ms: number): number | null {
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

function relativeTimestamp(event: ModEvent, now: Date): string | null {
  const seconds = unixSeconds(Date.parse(event.pkg.updatedAt)) ?? unixSeconds(Date.parse(event.createdAt)) ?? unixSeconds(now.getTime());
  return seconds === null ? null : `<t:${seconds}:${DISCORD.timestampStyleRelative}>`;
}

function titleLine(event: ModEvent, storeEmoji: string, unnamed: string): string {
  const text = inline(event.pkg.name, CAPS.name) || unnamed;
  const url = safeUrl(event.pkg.url);
  return `## ${storeEmoji ? `${storeEmoji} ` : ''}${url ? mdLink(text, url) : text}`;
}

function kindLine(event: ModEvent, ctx: Ctx, now: Date): string {
  const { messages } = ctx;
  const owner = inline(event.pkg.owner, CAPS.owner);
  const isNew = event.kind === 'new';
  const label = owner ? (isNew ? messages.newBy(owner) : messages.updatedBy(owner)) : isNew ? messages.newAnonymous : messages.updatedAnonymous;
  const to = inline(event.versionTo, CAPS.version) || '?';
  const from = !isNew && event.versionFrom ? inline(event.versionFrom, CAPS.version) : '';
  const parts = [`${KIND_EMOJI[event.kind]} ${label}`, from ? `${from} → ${to}` : to, relativeTimestamp(event, now)];
  return parts.filter(Boolean).join(INFO_SEP);
}

function infoLine(event: ModEvent, ctx: Ctx): string | null {
  const { messages } = ctx;
  const { pkg } = event;
  const parts: string[] = [];
  const size = formatBytes(pkg.sizeBytes, messages.byteUnits, messages.decimalSeparator);
  if (size !== null) parts.push(size);
  // A newly published package has no download history yet, so the count would always read zero.
  const downloads = event.kind === 'new' ? null : wholeCount(pkg.downloads);
  if (downloads !== null) parts.push(messages.downloaded(downloads, formatCount(downloads, messages.thousandsSeparator)!));
  const likes = wholeCount(pkg.likes);
  if (likes !== null && likes > 0) parts.push(messages.likes(likes, formatCount(likes, messages.thousandsSeparator)!));
  return parts.length === 0 ? null : `${SECTION_EMOJI.info} ${parts.join(INFO_SEP)}`;
}

function alsoOnLine(event: ModEvent, ctx: Ctx): string | null {
  let line = '';
  let entries = 0;
  for (const other of event.alsoOn) {
    const url = safeUrl(other.url);
    const style = STORES[other.store];
    if (!url || !style || entries >= CAPS.alsoOnEntries) continue;
    const piece = mdLink(style.label, url);
    const next = line ? `${line}${INFO_SEP}${piece}` : `${ctx.messages.alsoOn} ${piece}`;
    if (next.length > CAPS.alsoOnLine) break;
    line = next;
    entries += 1;
  }
  return line || null;
}

function header(event: ModEvent, ctx: Ctx, now: Date): string {
  const lines = [titleLine(event, ctx.storeEmojis[event.pkg.store] ?? '', ctx.messages.unnamed), kindLine(event, ctx, now)];
  const info = infoLine(event, ctx);
  if (info) lines.push(info);
  const also = alsoOnLine(event, ctx);
  if (also) lines.push(also);
  const excerpt = event.pkg.description ? inline(stripHtml(head(event.pkg.description, CAPS.excerpt * CAPS.rawFactor)), CAPS.excerpt) : '';
  // The "description" catalog message and SECTION_EMOJI.description stay defined for future template customisation,
  // even though the heading itself is not shown.
  if (excerpt) lines.push('', excerpt);
  return lines.join('\n');
}

/** Splits an excerpt that ends with the changelog module's own full-changelog link into its text and link target. */
function splitFullLink(text: string): { body: string; target: string | null } {
  const at = text.lastIndexOf('\n') + 1;
  if (!text.startsWith(FULL_LINK_PREFIX, at) || !text.endsWith(')')) return { body: text, target: null };
  return { body: text.slice(0, Math.max(0, at - 1)), target: text.slice(at + FULL_LINK_PREFIX.length, -1) };
}

/** One cheap pre-check: only a link labelled like the localised label can be an impostor, and it needs the label text (any case). */
function mentionsLabel(body: string, label: string): boolean {
  return body.includes('](') && body.toLowerCase().includes(label.toLowerCase());
}

/**
 * The excerpt is final Markdown from the changelog module. Here it is stripped of invisible characters, mention-neutralised,
 * cut to `CHANGELOG_DISPLAY_MAX` on a line or word boundary (never inside a link) and closed by one full-changelog link in the
 * catalog language that stays inside the budget. A link in the body that impersonates that label is degraded to text.
 */
function changelogExcerpt(event: ModEvent, ctx: Ctx): string | null {
  if (!ctx.includeChangelog) return null;
  const label = ctx.messages.fullChangelog;
  const cleaned = neutralizeMentions(stripUnsafeChars(head(event.changelog ?? '', CHANGELOG_DISPLAY_MAX * 4)));
  const split = splitFullLink(cleaned.trimEnd());
  const fullUrl = split.target ?? safeUrl(event.changelogUrl);
  let body = split.body;
  if (label !== FULL_CHANGELOG_LABEL && mentionsLabel(body, label)) body = body.split('\n').map((line) => sanitizeLinks(line, label)).join('\n');
  return finalizeExcerpt(body, { maxChars: CHANGELOG_DISPLAY_MAX, fullUrl, label, wordBoundary: true });
}

function categoriesValue(categories: readonly string[]): string | null {
  const shown: string[] = [];
  let length = 0;
  let cut = false;
  for (const raw of categories) {
    const name = inline(raw, CAPS.categoryName);
    if (!name) continue;
    const next = length + (shown.length > 0 ? 2 : 0) + name.length;
    if (shown.length >= CAPS.categoryEntries || next > CAPS.categoriesValue - 1) {
      cut = true;
      break;
    }
    shown.push(name);
    length = next;
  }
  return shown.length === 0 ? null : `${shown.join(', ')}${cut ? '…' : ''}`;
}

export function buildParts(event: ModEvent, now: Date, ctx: Ctx): DetailedParts {
  const categories = Array.isArray(event.pkg.categories) ? categoriesValue(event.pkg.categories) : null;
  return {
    header: header(event, ctx, now),
    changelog: changelogExcerpt(event, ctx),
    categories,
    icon: linkButtonUrl(event.pkg.iconUrl),
    color: STORES[event.pkg.store].color,
  };
}

/** Embed for a digest: the header is the description; fields are Changelog and Categories; no footer (the packer adds paging). */
export function buildDetailed(event: ModEvent, now: Date, ctx: Ctx): DiscordEmbed {
  const parts = buildParts(event, now, ctx);
  const embed: DiscordEmbed = { description: parts.header, color: parts.color };
  if (parts.icon) embed.thumbnail = { url: parts.icon };
  const fields: { name: string; value: string }[] = [];
  if (parts.changelog) fields.push({ name: ctx.messages.changelog, value: parts.changelog });
  if (parts.categories) fields.push({ name: `${SECTION_EMOJI.categories} ${ctx.messages.categories}`, value: parts.categories });
  if (fields.length > 0) embed.fields = fields;
  return embed;
}
