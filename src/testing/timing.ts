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

/** Fastest of `runs` for two functions each, sampled in alternation so a load spike lands on both equally; for comparing a ratio between them. */
export function bestOfPaired(runs: number, a: () => void, b: () => void): [number, number] {
  a();
  b();
  let bestA = Number.POSITIVE_INFINITY;
  let bestB = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    a();
    const t1 = performance.now();
    b();
    const t2 = performance.now();
    bestA = Math.min(bestA, t1 - t0);
    bestB = Math.min(bestB, t2 - t1);
  }
  return [bestA, bestB];
}
