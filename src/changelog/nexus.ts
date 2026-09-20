// SPDX-License-Identifier: AGPL-3.0-or-later
import { CHANGELOG_EXCERPT_MAX } from '../core/constants.ts';
import { escapeMarkdown, stripHtml, stripUnsafeChars } from '../text/sanitize.ts';
import { finalizeExcerpt } from './excerpt.ts';
import type { ExtractOptions } from './extract.ts';

const MAX_LINES = 100;
const RAW_CHARS_PER_OUTPUT_CHAR = 4;

function normalizeVersion(version: string): string {
  const trimmed = version.trim().toLowerCase();
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

function findLines(changelogs: Record<string, unknown>, version: string): unknown {
  const wanted = normalizeVersion(version);
  if (wanted === '') return undefined;
  for (const [key, lines] of Object.entries(changelogs)) {
    if (normalizeVersion(key) === wanted) return lines;
  }
  return undefined;
}

/** Excerpt of a Nexus `changelogs.json` entry, rendered as a bullet list. */
export function extractNexusChangelog(changelogs: Record<string, unknown>, version: string, opts: ExtractOptions = {}): string | null {
  if (typeof changelogs !== 'object' || changelogs === null || typeof version !== 'string') return null;
  const maxChars = opts.maxChars ?? CHANGELOG_EXCERPT_MAX;
  if (!Number.isFinite(maxChars) || maxChars < 1) return null;

  const lines = findLines(changelogs, version);
  if (!Array.isArray(lines)) return null;

  const rawLimit = maxChars * RAW_CHARS_PER_OUTPUT_CHAR;
  let cut = lines.length > MAX_LINES;
  const bullets: string[] = [];
  for (const line of lines.slice(0, MAX_LINES)) {
    if (typeof line !== 'string') continue;
    let raw = line;
    if (raw.length > rawLimit) {
      raw = raw.slice(0, rawLimit);
      cut = true;
    }
    const text = stripHtml(stripUnsafeChars(raw))
      .replace(/\s+/g, ' ')
      .replace(/^[-*•]\s+/, '')
      .trim();
    if (text !== '') bullets.push(`- ${escapeMarkdown(text)}`);
  }
  if (bullets.length === 0) return null;
  return finalizeExcerpt(bullets.join('\n'), { maxChars, fullUrl: opts.fullUrl ?? null, cut });
}
