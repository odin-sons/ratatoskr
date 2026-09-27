// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StoreEmojis } from '../core/types.ts';
import { getMessages, type Language, type Messages } from '../i18n/index.ts';
import { resolveRatatoskrEmoji, resolveStoreEmojis } from './emoji.ts';

/** Presentation settings shared by every render call; none of them changes which mods are shown. */
export interface RenderSettings {
  /** Custom emoji markup per store; entries that are not valid custom emoji are ignored. */
  storeEmojis?: StoreEmojis;
  /** Custom emoji markup for the source button; ignored unless valid. */
  ratatoskrEmoji?: string;
  /** Catalog to render in; unknown values resolve to English. */
  locale?: Language;
  /** `false` leaves out the Download and Website buttons (default `true`); the mod page and source buttons stay. */
  optionalButtons?: boolean;
}

/** Settings after validation. */
export interface Ctx {
  messages: Messages;
  storeEmojis: StoreEmojis;
  ratatoskrEmoji: string | null;
  optionalButtons: boolean;
}

export function makeCtx(settings: RenderSettings): Ctx {
  return {
    messages: getMessages(settings.locale),
    storeEmojis: resolveStoreEmojis(settings.storeEmojis),
    ratatoskrEmoji: resolveRatatoskrEmoji(settings.ratatoskrEmoji),
    optionalButtons: settings.optionalButtons !== false,
  };
}
