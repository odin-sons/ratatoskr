// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StoreEmojis } from '../core/types.ts';
import { getMessages, type Language, type Messages } from '../i18n/index.ts';
import { resolveRatatoskrEmoji, resolveStoreEmojis } from './emoji.ts';
import { parseTemplate, type ParsedTemplate } from './template/parse.ts';

/** Presentation settings shared by every render call; none of them changes which mods are shown. */
export interface RenderSettings {
  /** Custom emoji markup per store; entries that are not valid custom emoji are ignored. */
  storeEmojis?: StoreEmojis;
  /** Custom emoji markup for the source subtext link; ignored unless valid. */
  ratatoskrEmoji?: string;
  /** Catalog to render in; unknown values resolve to English. */
  locale?: Language;
  /** `false` leaves out the Download and Website buttons (default `true`); the mod page button stays. */
  optionalButtons?: boolean;
  /** `false` never shows the Changelog block, however long or short the excerpt (default `true`). */
  includeChangelog?: boolean;
  /** Template of the message of one event; the default one when absent. */
  /** `true` adds the Info button, which only a message sent by the bot itself may carry. */
  infoButton?: boolean;
  immediateTemplate?: ParsedTemplate | string | null;
  /** Template of the line of a mod in a digest, used at level L0; the default one when absent. */
  digestLineTemplate?: ParsedTemplate | string | null;
}

/** Settings after validation. */
export interface Ctx {
  messages: Messages;
  storeEmojis: StoreEmojis;
  ratatoskrEmoji: string | null;
  optionalButtons: boolean;
  includeChangelog: boolean;
  infoButton: boolean;
  immediateTemplate: ParsedTemplate | null;
  digestLineTemplate: ParsedTemplate | null;
}

const PARSED = new Map<string, ParsedTemplate>();
const PARSED_MAX = 200;

/** A template given as text is parsed once and remembered; one that shows nothing counts as no template. */
function resolveTemplate(template: ParsedTemplate | string | null | undefined): ParsedTemplate | null {
  if (template === undefined || template === null) return null;
  let parsed: ParsedTemplate | undefined;
  if (typeof template === 'string') {
    parsed = PARSED.get(template);
    if (parsed === undefined) {
      parsed = parseTemplate(template);
      if (PARSED.size >= PARSED_MAX) PARSED.clear();
      PARSED.set(template, parsed);
    }
  } else {
    parsed = template;
  }
  return parsed.blocks.length === 0 ? null : parsed;
}

export function makeCtx(settings: RenderSettings): Ctx {
  return {
    messages: getMessages(settings.locale),
    storeEmojis: resolveStoreEmojis(settings.storeEmojis),
    ratatoskrEmoji: resolveRatatoskrEmoji(settings.ratatoskrEmoji),
    optionalButtons: settings.optionalButtons !== false,
    includeChangelog: settings.includeChangelog !== false,
    infoButton: settings.infoButton === true,
    immediateTemplate: resolveTemplate(settings.immediateTemplate),
    digestLineTemplate: resolveTemplate(settings.digestLineTemplate),
  };
}
