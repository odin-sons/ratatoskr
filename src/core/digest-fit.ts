// SPDX-License-Identifier: AGPL-3.0-or-later
import { DIGEST_FIT_ATTEMPTS, DISCORD } from './constants.ts';
import type { DiscordMessage } from './types.ts';

export interface DigestFit {
  /** Leading entries rendered into `messages`. */
  count: number;
  messages: DiscordMessage[];
}

/** Longest leading run holding at most `allowance` messages' worth of detailed embeds; compact entries are free. */
function initialPrefixLength<T>(entries: readonly T[], allowance: number, isDetailed: (entry: T) => boolean): number {
  const maxDetailed = allowance * DISCORD.embedsPerMessage;
  let detailed = 0;
  for (let i = 0; i < entries.length; i++) {
    if (isDetailed(entries[i]!) && ++detailed > maxDetailed) return i;
  }
  return entries.length;
}

/**
 * Finds the longest leading run of `entries` (oldest first) whose digest needs at most `allowance` messages.
 * Requires `entries.length >= 1` and `allowance >= 1`; always returns at least one entry.
 *
 * Cost: at most `1 + DIGEST_FIT_ATTEMPTS + log2(n)` renders, each strictly smaller than the last. The first render
 * covers at most `allowance * embedsPerMessage` detailed entries plus the compact ones; the next
 * `DIGEST_FIT_ATTEMPTS` scale the prefix by allowance / messages, then it halves.
 */
export function fitDigestPrefix<T>(
  entries: readonly T[],
  allowance: number,
  isDetailed: (entry: T) => boolean,
  render: (prefix: readonly T[]) => DiscordMessage[],
): DigestFit {
  let count = Math.max(1, initialPrefixLength(entries, allowance, isDetailed));
  for (let attempt = 0; ; attempt++) {
    const messages = render(entries.slice(0, count));
    if (messages.length <= allowance || count === 1) return { count, messages };
    const scaled = attempt < DIGEST_FIT_ATTEMPTS ? Math.floor((count * allowance) / messages.length) : Math.floor(count / 2);
    count = Math.max(1, Math.min(count - 1, scaled));
  }
}
