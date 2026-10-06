// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store } from '../../core/ports.ts';
import type { ChannelKind, SourceConfig, StoreEmojis } from '../../core/types.ts';

/** What the command handlers need from the outside; tests pass real in-memory implementations. */
export interface CommandDeps {
  store: Store;
  /** Enabled sources of this deployment; `/subscribe source:` maps a store to these. */
  sources: readonly SourceConfig[];
  newId: () => string;
  /** Presentation of `/info` answers, as for delivered messages. */
  storeEmojis?: StoreEmojis;
  ratatoskrEmoji?: string;
  now: () => Date;
  /** Asks Discord what kind of channel `channelId` is; null when it cannot tell. Without it a thread's parent is unknown. */
  channelKind?: (channelId: string) => Promise<ChannelKind | null>;
}

const ID_CHARS = 10;

/** 10 hex characters of a random UUID; enough to keep a few hundred ids apart. */
export const randomSubscriptionId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, ID_CHARS);
