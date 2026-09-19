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
 * Counts mods in rendered output: one per titled (detailed) embed, one per compact list line,
 * plus one per unescaped `|` separator inside a grouped (L3) line.
 */
export function countItems(messages: readonly DiscordMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const embed of msg.embeds ?? []) {
      if (embed.title !== undefined) {
        total += 1;
      } else if (embed.description) {
        for (const line of embed.description.split('\n')) total += 1 + countSeparators(line);
      }
    }
  }
  return total;
}
