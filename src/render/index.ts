// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DiscordMessage, ModEvent, StoreEmojis } from '../core/types.ts';
import { buildComponents } from './components.ts';
import { buildDetailed } from './detailed.ts';
import { planDigest, type RenderOptions } from './digest.ts';
import { resolveStoreEmojis } from './emoji.ts';
import { Packer } from './pack.ts';

export type { RenderOptions } from './digest.ts';
export { parseStoreEmojis } from './emoji.ts';
export { assertWithinLimits, measureMessage } from './limits.ts';

export function renderDigest(events: ModEvent[], opts: RenderOptions): DiscordMessage[] {
  return planDigest(events, opts).messages;
}

export function renderImmediate(event: ModEvent, opts: { now: Date; storeEmojis?: StoreEmojis }): DiscordMessage {
  const emoji = resolveStoreEmojis(opts.storeEmojis)[event.pkg.store] ?? '';
  const packer = new Packer();
  packer.addEmbed(buildDetailed(event, opts.now, emoji));
  const message = packer.finish()[0]!;
  const components = buildComponents(event.pkg.url, event.pkg.downloadUrl);
  return components === undefined ? message : { ...message, components };
}
