// SPDX-License-Identifier: AGPL-3.0-or-later
import { FULL_CHANGELOG_LABEL } from '../changelog/links.ts';
import { DISCORD, CHANGELOG_EXCERPT_MAX } from '../core/constants.ts';
import type { DiscordEmbed, ModEvent } from '../core/types.ts';
import { neutralizeMentions, stripHtml, stripUnsafeChars, truncate } from '../text/sanitize.ts';
import { CAPS } from './layout.ts';
import { STORES } from './stores.ts';
import { formatBytes, head, inline, mdLink, safeUrl } from './text.ts';

const MIN_NAME_ROOM = 16;
const FULL_LINK_PREFIX = `[${FULL_CHANGELOG_LABEL}](`;

function timestamp(createdAt: string, now: Date): string | undefined {
  const parsed = Date.parse(createdAt);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return Number.isFinite(now.getTime()) ? now.toISOString() : undefined;
}

function title(event: ModEvent): string {
  const to = inline(event.versionTo, CAPS.version) || '?';
  const from = event.kind === 'update' && event.versionFrom ? inline(event.versionFrom, CAPS.version) : '';
  const versions = from ? ` ${from} → ${to}` : ` ${to}`;
  const room = Math.max(MIN_NAME_ROOM, DISCORD.embedTitleMax - versions.length);
  const name = inline(event.pkg.name, room) || 'unnamed';
  return `${name}${versions}`;
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

function description(event: ModEvent): string | undefined {
  const lines: string[] = [];
  const owner = inline(event.pkg.owner, CAPS.owner);
  const meta = [owner ? `by ${owner}` : '', formatBytes(event.pkg.sizeBytes) ?? ''].filter(Boolean).join(' · ');
  if (meta) lines.push(meta);
  const also = alsoOnLine(event);
  if (also) lines.push(also);
  const excerpt = event.pkg.description ? inline(stripHtml(head(event.pkg.description, CAPS.excerpt * CAPS.rawFactor)), CAPS.excerpt) : '';
  if (excerpt) lines.push(excerpt);
  return lines.length > 0 ? lines.join('\n') : undefined;
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
  const value = [excerpt, link].filter(Boolean).join('\n');
  return value ? { name: 'Changelog', value } : null;
}

/** Full embed for one event. Store marker goes in the footer; the source footer is appended at packing time. */
export function buildDetailed(event: ModEvent, now: Date): DiscordEmbed {
  const style = STORES[event.pkg.store];
  const embed: DiscordEmbed = { title: title(event), color: style.color };
  const url = safeUrl(event.pkg.url);
  if (url) embed.url = url;
  const icon = safeUrl(event.pkg.iconUrl);
  if (icon) embed.thumbnail = { url: icon };
  const desc = description(event);
  if (desc) embed.description = desc;
  const field = changelogField(event);
  if (field) embed.fields = [field];
  embed.footer = { text: `${style.label} · ${event.kind === 'new' ? 'new package' : 'update'}` };
  const ts = timestamp(event.createdAt, now);
  if (ts) embed.timestamp = ts;
  return embed;
}
