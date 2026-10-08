// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DiscordMessage, ModEvent } from '../core/types.ts';
import { makeCtx, type RenderSettings } from './context.ts';
import { planDigest, type RenderOptions } from './digest.ts';
import { renderEvent } from './template/build.ts';

export type { RenderOptions } from './digest.ts';
export type { RenderSettings } from './context.ts';
export { parseRatatoskrEmoji, parseStoreEmojis } from './emoji.ts';
export { assertWithinLimits, measureMessage } from './limits.ts';

export function renderDigest(events: ModEvent[], opts: RenderOptions): DiscordMessage[] {
  return planDigest(events, opts).messages;
}

export function renderImmediate(event: ModEvent, opts: RenderSettings & { now: Date; onTemplateFallback?: () => void }): DiscordMessage {
  const ctx = makeCtx(opts);
  const result = renderEvent(ctx.immediateTemplate, event, opts.now, ctx);
  if (result.fellBack) opts.onTemplateFallback?.();
  return result.message;
}
