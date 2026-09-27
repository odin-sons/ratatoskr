// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StoreKind } from '../core/types.ts';

export interface StoreStyle {
  label: string;
  color: number;
  /** Unicode emoji on the store button when no custom store emoji is configured. */
  buttonEmoji: string;
}

export const STORES: Record<StoreKind, StoreStyle> = {
  thunderstore: { label: 'Thunderstore', color: 0x3b82f6, buttonEmoji: '⚡' },
  hexium: { label: 'Hexium', color: 0x8b5cf6, buttonEmoji: '🟣' },
  nexus: { label: 'Nexus Mods', color: 0xf59e0b, buttonEmoji: '🌀' },
};

export const STORE_ORDER: readonly StoreKind[] = ['thunderstore', 'hexium', 'nexus'];
