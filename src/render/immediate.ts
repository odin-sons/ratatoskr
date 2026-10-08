// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DiscordMessage, ModEvent } from '../core/types.ts';
import type { Ctx } from './context.ts';
import { renderEvent } from './template/build.ts';

/**
 * One Components V2 message for a single event, made from the subscription's template or, without one, the default
 * template, which lays out a container with the header (beside the thumbnail when there is one), the changelog and
 * categories displays and the action row of link buttons, with a divider between blocks. It has no `content` and no
 * `embeds`, which Discord rejects together with the V2 flag.
 */
export function buildImmediate(event: ModEvent, now: Date, ctx: Ctx): DiscordMessage {
  return renderEvent(ctx.immediateTemplate, event, now, ctx).message;
}
