// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD_CUSTOM_EMOJI } from '../core/constants.ts';
import type { DiscordButtonEmoji, StoreEmojis, StoreKind } from '../core/types.ts';
import { STORE_ORDER } from './stores.ts';

const MAX_CONFIG_CHARS = 2000;
const MAX_NAMED_KEYS = 8;
const SAFE_KEY = /^[A-Za-z0-9_-]{1,32}$/;

function isEmoji(value: unknown): value is string {
  return typeof value === 'string' && DISCORD_CUSTOM_EMOJI.test(value);
}

function isStore(key: string): key is StoreKind {
  return (STORE_ORDER as readonly string[]).includes(key);
}

/** Keeps the entries that are a known store with valid custom emoji markup; silent. */
export function resolveStoreEmojis(raw: StoreEmojis | undefined): StoreEmojis {
  const out: StoreEmojis = {};
  if (raw === undefined) return out;
  for (const store of STORE_ORDER) {
    const value = raw[store];
    if (isEmoji(value)) out[store] = value;
  }
  return out;
}

function decode(raw: unknown, warn: (message: string) => void): Record<string, unknown> | null {
  let value = raw;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    if (value.length > MAX_CONFIG_CHARS) {
      warn('STORE_EMOJIS ignored: value is too long');
      return null;
    }
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      warn('STORE_EMOJIS ignored: not valid JSON');
      return null;
    }
  }
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    warn('STORE_EMOJIS ignored: expected an object keyed by store');
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Validates the `STORE_EMOJIS` Worker setting (an object or a JSON string). Invalid or unknown entries are dropped
 * with one warning that names only their keys; it never throws.
 */
export function parseStoreEmojis(raw: unknown, warn: (message: string) => void = console.warn): StoreEmojis {
  const config = decode(raw, warn);
  if (config === null) return {};
  const out: StoreEmojis = {};
  const rejected: string[] = [];
  for (const key of Object.keys(config)) {
    const value = config[key];
    if (isStore(key) && isEmoji(value)) out[key] = value;
    else rejected.push(SAFE_KEY.test(key) ? key : '?');
  }
  if (rejected.length > 0) {
    const shown = rejected.slice(0, MAX_NAMED_KEYS).join(', ');
    warn(`STORE_EMOJIS ignored entries: ${shown}${rejected.length > MAX_NAMED_KEYS ? ', ...' : ''}`);
  }
  return out;
}

const MAX_UNICODE_EMOJI_CHARS = 16;
/** One pictographic base, then variation selectors, skin tones and joined pictographs (a ZWJ sequence). */
const UNICODE_EMOJI = /^\p{Extended_Pictographic}(?:[\u{fe0f}\p{Emoji_Modifier}]|\u{200d}\p{Extended_Pictographic})*$/u;

/** Validates the `RATATOSKR_EMOJI` Worker setting: valid custom emoji markup, or unset. Anything else is ignored with one warning naming only the key. */
export function parseRatatoskrEmoji(raw: unknown, warn: (message: string) => void = console.warn): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    const value = raw.trim();
    if (value === '') return undefined;
    if (isEmoji(value)) return value;
  }
  warn('RATATOSKR_EMOJI ignored: expected full custom emoji markup like <:name:123456789012345678>');
  return undefined;
}

/** The emoji if it is valid custom emoji markup, else null. */
export function resolveRatatoskrEmoji(raw: string | undefined): string | null {
  return isEmoji(raw) ? raw : null;
}

/** Button emoji object for custom emoji markup or a short unicode emoji; null for anything that looks like neither. */
export function buttonEmoji(emoji: string): DiscordButtonEmoji | null {
  if (DISCORD_CUSTOM_EMOJI.test(emoji)) {
    const animated = emoji.startsWith('<a:');
    const [name, id] = emoji.slice(animated ? 3 : 2, -1).split(':') as [string, string];
    return { id, name, animated };
  }
  if (emoji.length > MAX_UNICODE_EMOJI_CHARS || !UNICODE_EMOJI.test(emoji)) return null;
  return { name: emoji };
}
