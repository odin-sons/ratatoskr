// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TickDeps } from '../core/tick.ts';
import type { Subscription } from '../core/types.ts';
import { FakeAdapter, FakeClock, FakeRenderer, FakeSender, FIXED_NOW_ISO, makeConfig } from './fakes.ts';
import { MemoryStore } from './memory-store.ts';

export interface Harness {
  store: MemoryStore;
  sender: FakeSender;
  renderer: FakeRenderer;
  clock: FakeClock;
  adapters: FakeAdapter[];
  deps: TickDeps;
}

/** Wires a full set of fakes into `TickDeps`. */
export function makeHarness(
  opts: { adapters?: FakeAdapter[]; subscriptions?: Subscription[]; nowIso?: string } = {},
): Harness {
  const adapters = opts.adapters ?? [];
  const store = new MemoryStore();
  for (const sub of opts.subscriptions ?? []) store.addSubscription(sub);
  const sender = new FakeSender();
  const renderer = new FakeRenderer();
  const clock = new FakeClock(opts.nowIso ?? FIXED_NOW_ISO);
  const deps: TickDeps = {
    store,
    sender,
    renderer,
    clock,
    adapters,
    config: makeConfig(adapters.map((a) => a.config)),
    secrets: {},
    fetch: (() => {
      throw new Error('unexpected fetch');
    }) as unknown as typeof fetch,
  };
  return { store, sender, renderer, clock, adapters, deps };
}
