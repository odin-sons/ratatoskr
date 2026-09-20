// SPDX-License-Identifier: AGPL-3.0-or-later
import { SUBREQUEST_LIMIT } from './constants.ts';

export class SubrequestBudgetError extends Error {
  constructor() {
    super('subrequest budget exhausted');
    this.name = 'SubrequestBudgetError';
  }
}

/** Subrequests one invocation may still spend; shared by polls, Discord sends and changelog fetches. */
export class SubrequestBudget {
  readonly limit: number;
  private spent = 0;

  constructor(limit: number = SUBREQUEST_LIMIT) {
    this.limit = limit;
  }

  get used(): number {
    return this.spent;
  }

  get remaining(): number {
    return this.limit - this.spent;
  }

  /** Spends `count` when at least `floor` subrequests would remain unspent afterwards. */
  tryConsume(count = 1, floor = 0): boolean {
    if (this.remaining - count < floor) return false;
    this.spent += count;
    return true;
  }

  /** Counts every call and rejects with `SubrequestBudgetError` (no network call) once the budget is spent. */
  wrapFetch(inner: typeof fetch, floor = 0): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (!this.tryConsume(1, floor)) throw new SubrequestBudgetError();
      return inner(input, init);
    }) as typeof fetch;
  }
}
