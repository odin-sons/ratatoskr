// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD } from '../core/constants.ts';
import type { DiscordContainer, DiscordMessage, DiscordSeparator, ModEvent } from '../core/types.ts';
import { buildActionRow } from './components.ts';
import type { Ctx } from './context.ts';
import { buildParts } from './detailed.ts';
import { SECTION_EMOJI, sourceSubtext } from './layout.ts';

const SEPARATOR: DiscordSeparator = { type: 14, divider: true, spacing: 1 };

type Block = DiscordContainer['components'][number];

/**
 * One Components V2 message for a single event: a container holding the header (beside the thumbnail when there is one),
 * the changelog and categories displays and the action row of link buttons, with a divider between blocks. It has no
 * `content` and no `embeds`, which Discord rejects together with the V2 flag.
 */
export function buildImmediate(event: ModEvent, now: Date, ctx: Ctx): DiscordMessage {
  const parts = buildParts(event, now, ctx);
  const header = { type: 10 as const, content: parts.header };
  const blocks: Block[] = [parts.icon === null ? header : { type: 9, components: [header], accessory: { type: 11, media: { url: parts.icon } } }];
  const push = (block: Block): void => {
    blocks.push({ ...SEPARATOR }, block);
  };
  if (parts.changelog !== null) push({ type: 10, content: `**${ctx.messages.changelog}**\n${parts.changelog}` });
  if (parts.categories !== null) push({ type: 10, content: `**${SECTION_EMOJI.categories} ${ctx.messages.categories}**\n${parts.categories}` });
  const row = buildActionRow(event, ctx);
  if (row !== null) push(row);
  return {
    flags: DISCORD.componentsV2Flag,
    allowed_mentions: { parse: [] },
    components: [{ type: 17, accent_color: parts.color, components: blocks }, sourceSubtext(ctx.ratatoskrEmoji)],
  };
}
