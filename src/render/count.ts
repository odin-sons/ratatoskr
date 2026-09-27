// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DiscordMessage } from '../core/types.ts';

function countSeparators(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') i += 1;
    else if (ch === '|') n += 1;
  }
  return n;
}

/**
 * Counts mods in rendered output: one per detailed embed (its description opens with an h1 line), one per compact
 * list line after the store heading, plus one per unescaped `|` separator inside a grouped (L3) line.
 */
export function countItems(messages: readonly DiscordMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const embed of msg.embeds ?? []) {
      if (!embed.description) continue;
      if (embed.description.startsWith('# ')) {
        total += 1;
        continue;
      }
      const lines = embed.description.split('\n');
      for (let i = 1; i < lines.length; i++) total += 1 + countSeparators(lines[i]!);
    }
  }
  return total;
}
