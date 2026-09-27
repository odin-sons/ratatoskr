// SPDX-License-Identifier: AGPL-3.0-or-later
import { FULL_CHANGELOG_LABEL } from '../changelog/links.ts';
import { CHANGELOG_EXCERPT_MAX, DISCORD } from '../core/constants.ts';
import type { DiscordEmbed, ModEvent } from '../core/types.ts';
import { neutralizeMentions, stripHtml, stripUnsafeChars, truncate } from '../text/sanitize.ts';
import { CAPS, KIND_EMOJI } from './layout.ts';
import { STORES } from './stores.ts';
import { formatBytes, formatCount, head, inline, mdLink, safeUrl } from './text.ts';

const MIN_NAME_ROOM = 16;
const FULL_LINK_PREFIX = `[${FULL_CHANGELOG_LABEL}](`;

function unixSeconds(ms: number): number | null {
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

function relativeTimestamp(event: ModEvent, now: Date): string | null {
  const seconds = unixSeconds(Date.parse(event.pkg.updatedAt)) ?? unixSeconds(Date.parse(event.createdAt)) ?? unixSeconds(now.getTime());
  return seconds === null ? null : `<t:${seconds}:${DISCORD.timestampStyleRelative}>`;
}

function heading(event: ModEvent): string {
  const to = inline(event.versionTo, CAPS.version) || '?';
  const from = event.kind === 'update' && event.versionFrom ? inline(event.versionFrom, CAPS.version) : '';
  const versions = from ? ` ${from} → ${to}` : ` ${to}`;
  const room = Math.max(MIN_NAME_ROOM, CAPS.name - versions.length);
  const text = `${inline(event.pkg.name, room) || 'unnamed'}${versions}`;
  const url = safeUrl(event.pkg.url);
  return `# ${url ? mdLink(text, url) : text}`;
}

function infoLine(event: ModEvent, emoji: string, now: Date): string {
  const owner = inline(event.pkg.owner, CAPS.owner);
  const label = event.kind === 'new' ? `${KIND_EMOJI.new} New` : `${KIND_EMOJI.update} Updated`;
  const kind = `${label} mod${owner ? ` by ${owner}` : ''}`;
  const parts = [`${emoji ? `${emoji} ` : ''}${kind}`, formatBytes(event.pkg.sizeBytes), relativeTimestamp(event, now)];
  return parts.filter(Boolean).join(' · ');
}

function alsoOnLine(event: ModEvent): string | null {
  let line = '';
  let entries = 0;
  for (const other of event.alsoOn) {
    const url = safeUrl(other.url);
    const style = STORES[other.store];
    if (!url || !style || entries >= CAPS.alsoOnEntries) continue;
    const piece = mdLink(style.label, url);
    const next = line ? `${line} · ${piece}` : `Also on ${piece}`;
    if (next.length > CAPS.alsoOnLine) break;
    line = next;
    entries += 1;
  }
  return line || null;
}

function description(event: ModEvent, emoji: string, now: Date): string {
  const lines = [heading(event), infoLine(event, emoji, now)];
  const also = alsoOnLine(event);
  if (also) lines.push(also);
  const excerpt = event.pkg.description ? inline(stripHtml(head(event.pkg.description, CAPS.excerpt * CAPS.rawFactor)), CAPS.excerpt) : '';
  if (excerpt) lines.push('', excerpt);
  return lines.join('\n');
}

function endsWithFullLink(text: string): boolean {
  return text.startsWith(FULL_LINK_PREFIX, text.lastIndexOf('\n') + 1) && text.endsWith(')');
}

/** The excerpt is final Markdown from the changelog module; only invisible-character stripping, mention neutralising and a length cap are applied. */
function changelogField(event: ModEvent): { name: string; value: string } | null {
  const raw = event.changelog ?? '';
  const url = safeUrl(event.changelogUrl);
  const link = url && !endsWithFullLink(raw) ? mdLink(FULL_CHANGELOG_LABEL, url) : '';
  const room = Math.min(CHANGELOG_EXCERPT_MAX, DISCORD.embedFieldValueMax - (link ? link.length + 1 : 0));
  const excerpt = truncate(neutralizeMentions(stripUnsafeChars(head(raw, room * 2))).trim(), room);
  if (!excerpt) return null;
  return { name: 'Changelog', value: [excerpt, link].filter(Boolean).join('\n') };
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

function extraFields(event: ModEvent): { name: string; value: string; inline: true }[] {
  const out: { name: string; value: string; inline: true }[] = [];
  const downloads = formatCount(event.pkg.downloads);
  if (downloads !== null) out.push({ name: 'Total downloads', value: downloads, inline: true });
  const categories = Array.isArray(event.pkg.categories) ? categoriesValue(event.pkg.categories) : null;
  if (categories !== null) out.push({ name: 'Categories', value: categories, inline: true });
  return out;
}

/** Full embed for one event: h1 link, info line and excerpt in the description; fields are Changelog, Total downloads, Categories. */
export function buildDetailed(event: ModEvent, now: Date, emoji = ''): DiscordEmbed {
  const style = STORES[event.pkg.store];
  const embed: DiscordEmbed = { description: description(event, emoji, now), color: style.color };
  const icon = safeUrl(event.pkg.iconUrl);
  if (icon) embed.thumbnail = { url: icon };
  const field = changelogField(event);
  const fields = [...(field ? [field] : []), ...extraFields(event)];
  if (fields.length > 0) embed.fields = fields;
  embed.footer = { text: style.label };
  return embed;
}
