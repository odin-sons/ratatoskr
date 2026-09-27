// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DiscordEmbed, DiscordMessage, ModEvent, StoreEmojis } from '../core/types.ts';
import { MAX_LEVEL, prepare, renderBlocks, type Level, type Prepared } from './compact.ts';
import { buildDetailed } from './detailed.ts';
import { resolveStoreEmojis } from './emoji.ts';
import { Packer } from './pack.ts';

export interface RenderOptions {
  /** true => render this event as a full embed with changelog excerpt (new packages are always detailed regardless) */
  detailed: (event: ModEvent) => boolean;
  now: Date;
  /** Custom emoji markup per store; entries that are not valid custom emoji are ignored. */
  storeEmojis?: StoreEmojis;
}

export interface DigestPlan {
  messages: DiscordMessage[];
  /** Ladder level applied to the compact-updates section; 0 when there is none. */
  level: Level;
}

/** Highest level worth trading link loss for keeping compact updates in the same message as full embeds. */
const MAX_MERGE_LEVEL_WITH_DETAILED: Level = 2;

const LEVELS: readonly Level[] = [0, 1, 2, 3, 4];

function pack(detailed: readonly DiscordEmbed[], compact: readonly Prepared[], level: Level, separate: boolean, emojis: StoreEmojis): DiscordMessage[] {
  const packer = new Packer(emojis);
  for (const embed of detailed) packer.addEmbed(embed);
  if (separate) packer.startMessage();
  for (const block of renderBlocks(compact, level)) packer.addBlock(block);
  return packer.finish();
}

export function planDigest(events: readonly ModEvent[], opts: RenderOptions): DigestPlan {
  const emojis = resolveStoreEmojis(opts.storeEmojis);
  const detailed: DiscordEmbed[] = [];
  const compact: Prepared[] = [];
  for (const event of events) {
    if (event.kind === 'new' || opts.detailed(event)) detailed.push(buildDetailed(event, opts.now, emojis[event.pkg.store] ?? ''));
    else compact.push(prepare(event));
  }
  if (detailed.length === 0 && compact.length === 0) return { messages: [], level: 0 };

  const detailedOnly = pack(detailed, [], 0, false, emojis);
  if (compact.length === 0) return { messages: detailedOnly, level: 0 };

  const baseline = Math.max(1, detailedOnly.length);
  const mergeLevels = detailed.length > 0 ? LEVELS.filter((l) => l <= MAX_MERGE_LEVEL_WITH_DETAILED) : LEVELS;
  for (const level of mergeLevels) {
    const messages = pack(detailed, compact, level, false, emojis);
    if (messages.length <= baseline) return { messages, level };
  }

  const separateLevels = detailed.length > 0 ? LEVELS : [MAX_LEVEL];
  for (const level of separateLevels) {
    const messages = pack(detailed, compact, level, true, emojis);
    if (level === MAX_LEVEL || messages.length - detailedOnly.length <= 1) return { messages, level };
  }
  throw new Error('render: unreachable');
}
