// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DiscordMessage } from './types.ts';
import { DIGEST_FIT_ATTEMPTS, DISCORD } from './constants.ts';
import { fitDigestPrefix } from './digest-fit.ts';

interface Item {
  id: number;
  detailed: boolean;
  /** Space this item takes, in 1/100ths of a message. */
  weight: number;
}

const message: DiscordMessage = { allowed_mentions: { parse: [] } };

/** Packs items greedily into messages of 100 weight units; a single item always fits one message. */
function makeRender(calls: number[][] = []): (prefix: readonly Item[]) => DiscordMessage[] {
  return (prefix) => {
    calls.push(prefix.map((i) => i.id));
    const out: DiscordMessage[] = [];
    let load = 0;
    for (const item of prefix) {
      if (out.length === 0 || load + item.weight > 100) {
        out.push(message);
        load = 0;
      }
      load += item.weight;
    }
    return out;
  };
}

const items = (n: number, weight = 10, detailed = true): Item[] => Array.from({ length: n }, (_, id) => ({ id, detailed, weight }));
const isDetailed = (i: Item): boolean => i.detailed;

describe('fitDigestPrefix', () => {
  it('renders everything once when it already fits', () => {
    const calls: number[][] = [];
    const result = fitDigestPrefix(items(20), 5, isDetailed, makeRender(calls));
    expect(result.count).toBe(20);
    expect(calls).toHaveLength(1);
  });

  it('shrinks to a prefix that fits the allowance', () => {
    const result = fitDigestPrefix(items(100), 3, isDetailed, makeRender());
    expect(result.messages.length).toBeLessThanOrEqual(3);
    expect(result.count).toBeGreaterThan(0);
    expect(result.count).toBeLessThan(100);
  });

  it('never renders more detailed items initially than the allowance can hold at one embed each', () => {
    const calls: number[][] = [];
    fitDigestPrefix(items(400, 1), 2, isDetailed, makeRender(calls));
    expect(calls[0]!.length).toBeLessThanOrEqual(2 * DISCORD.embedsPerMessage);
  });

  it('does not cut compact entries from the first render', () => {
    const calls: number[][] = [];
    const result = fitDigestPrefix(items(400, 0, false), 1, isDetailed, makeRender(calls));
    expect(calls[0]!.length).toBe(400);
    expect(result.count).toBe(400);
  });

  it('always makes progress: at least one item even when the allowance is 1 and items are large', () => {
    const result = fitDigestPrefix(items(10, 100), 1, isDetailed, makeRender());
    expect(result.count).toBe(1);
    expect(result.messages).toHaveLength(1);
  });

  it('takes items in order from the front', () => {
    const calls: number[][] = [];
    const { count } = fitDigestPrefix(items(50), 2, isDetailed, makeRender(calls));
    expect(calls[calls.length - 1]).toEqual(Array.from({ length: count }, (_, i) => i));
  });

  it('property: result fits, is a non-empty prefix, and needs few renders', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ detailed: fc.boolean(), weight: fc.integer({ min: 1, max: 100 }) }), { minLength: 1, maxLength: 400 }),
        fc.integer({ min: 1, max: 24 }),
        (raw, allowance) => {
          const all = raw.map((r, id) => ({ id, ...r }));
          const calls: number[][] = [];
          const result = fitDigestPrefix(all, allowance, isDetailed, makeRender(calls));
          expect(result.count).toBeGreaterThanOrEqual(1);
          expect(result.count).toBeLessThanOrEqual(all.length);
          expect(result.messages.length).toBeLessThanOrEqual(allowance);
          expect(calls[calls.length - 1]).toEqual(all.slice(0, result.count).map((i) => i.id));
          expect(calls.length).toBeLessThanOrEqual(1 + DIGEST_FIT_ATTEMPTS + Math.ceil(Math.log2(all.length)));
          for (let i = 1; i < calls.length; i++) expect(calls[i]!.length).toBeLessThan(calls[i - 1]!.length);
        },
      ),
    );
  });
});
