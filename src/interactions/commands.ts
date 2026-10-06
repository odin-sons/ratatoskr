// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRegistry, type HandlerRegistry } from './router.ts';

/** The handlers the Worker serves; commands are registered here as they are added. */
export function createCommandRegistry(): HandlerRegistry {
  return createRegistry();
}
