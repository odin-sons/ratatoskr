// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DiscordMessage, ModEvent } from '../core/types.ts';
import { buildDetailed } from './detailed.ts';
import { planDigest, type RenderOptions } from './digest.ts';
import { Packer } from './pack.ts';

export type { RenderOptions } from './digest.ts';
export { assertWithinLimits, measureMessage } from './limits.ts';

export function renderDigest(events: ModEvent[], opts: RenderOptions): DiscordMessage[] {
  return planDigest(events, opts).messages;
}

export function renderImmediate(event: ModEvent, opts: { now: Date }): DiscordMessage {
  const packer = new Packer();
  packer.addEmbed(buildDetailed(event, opts.now));
  return packer.finish()[0]!;
}
