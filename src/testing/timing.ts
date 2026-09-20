// SPDX-License-Identifier: AGPL-3.0-or-later

/** Fastest of `runs` timed executions in milliseconds, after one warm-up run; robust to load spikes from parallel tests. */
export function bestOf(runs: number, fn: () => void): number {
  fn();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}
