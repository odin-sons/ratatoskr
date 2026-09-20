// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLOUDFLARE, SUBREQUEST_LIMIT, SUBREQUEST_SAFETY_MARGIN } from './constants.ts';
import { SubrequestBudget, SubrequestBudgetError } from './budget.ts';

const okFetch = (() => Promise.resolve(new Response('ok'))) as typeof fetch;

describe('SubrequestBudget', () => {
  it('defaults to the platform limit minus the safety margin', () => {
    expect(SUBREQUEST_SAFETY_MARGIN).toBeGreaterThan(0);
    expect(SUBREQUEST_LIMIT).toBe(CLOUDFLARE.subrequestsPerInvocation - SUBREQUEST_SAFETY_MARGIN);
    const budget = new SubrequestBudget();
    expect(budget.limit).toBe(SUBREQUEST_LIMIT);
    expect(budget.remaining).toBe(SUBREQUEST_LIMIT);
    expect(budget.used).toBe(0);
  });

  it('consumes all-or-nothing', () => {
    const budget = new SubrequestBudget(5);
    expect(budget.tryConsume(3)).toBe(true);
    expect(budget.tryConsume(3)).toBe(false);
    expect(budget.remaining).toBe(2);
    expect(budget.tryConsume(2)).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.used).toBe(5);
  });

  it('refuses a spend that would leave less than the floor', () => {
    const budget = new SubrequestBudget(5);
    expect(budget.tryConsume(1, 4)).toBe(true);
    expect(budget.tryConsume(1, 4)).toBe(false);
    expect(budget.remaining).toBe(4);
    expect(budget.tryConsume(1, 0)).toBe(true);
  });

  it('counts each fetch and rejects with a dedicated error once spent, without calling the network', async () => {
    let network = 0;
    const budget = new SubrequestBudget(2);
    const counted = budget.wrapFetch((async () => {
      network += 1;
      return new Response('ok');
    }) as typeof fetch);
    await counted('https://a.invalid/x');
    await counted('https://a.invalid/y');
    const refused = counted('https://secret.invalid/path?token=abc');
    await expect(refused).rejects.toBeInstanceOf(SubrequestBudgetError);
    await expect(counted('https://a.invalid/z')).rejects.toThrow(/subrequest budget/i);
    expect(network).toBe(2);
    expect(budget.used).toBe(2);
    await refused.catch((err: Error) => {
      expect(err.message).not.toContain('secret.invalid');
      expect(err.message).not.toContain('token');
    });
  });

  it('counts a fetch that fails or throws synchronously', async () => {
    const budget = new SubrequestBudget(3);
    const boom = budget.wrapFetch((() => {
      throw new Error('sync boom');
    }) as unknown as typeof fetch);
    await expect(boom('https://a.invalid/')).rejects.toThrow('sync boom');
    expect(budget.used).toBe(1);
  });

  it('a wrapper with a floor stops earlier than the plain one but shares the same pool', async () => {
    const budget = new SubrequestBudget(4);
    const plain = budget.wrapFetch(okFetch);
    const reserved = budget.wrapFetch(okFetch, 3);
    await reserved('https://a.invalid/1');
    await expect(reserved('https://a.invalid/2')).rejects.toBeInstanceOf(SubrequestBudgetError);
    await plain('https://a.invalid/3');
    expect(budget.remaining).toBe(2);
  });

  it('never lets total spend exceed the limit, however calls are interleaved', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.array(fc.tuple(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 20 })), { maxLength: 80 }),
        (limit, spends) => {
          const budget = new SubrequestBudget(limit);
          let granted = 0;
          for (const [n, floor] of spends) if (budget.tryConsume(n, floor)) granted += n;
          expect(granted).toBe(budget.used);
          expect(budget.used).toBeLessThanOrEqual(limit);
          expect(budget.remaining).toBe(limit - budget.used);
        },
      ),
    );
  });
});
