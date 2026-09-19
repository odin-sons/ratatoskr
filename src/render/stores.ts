// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StoreKind } from '../core/types.ts';

export interface StoreStyle {
  label: string;
  color: number;
}

export const STORES: Record<StoreKind, StoreStyle> = {
  thunderstore: { label: 'Thunderstore', color: 0x3b82f6 },
  hexium: { label: 'Hexium', color: 0x8b5cf6 },
  nexus: { label: 'Nexus Mods', color: 0xf59e0b },
};

export const STORE_ORDER: readonly StoreKind[] = ['thunderstore', 'hexium', 'nexus'];
