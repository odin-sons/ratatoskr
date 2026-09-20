// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DELIVERED_RETENTION_DAYS, MS_PER_DAY } from '../core/constants.ts';
import { runReconcile, runTick, type TickDeps } from '../core/tick.ts';
import type { PackageSnapshot } from '../core/types.ts';
import { FakeAdapter, FakeClock, FakeRenderer, FakeSender, FIXED_NOW_ISO, makeConfig, makeSnapshot, makeSubscription, okPoll } from './fakes.ts';
import type { StoreContractEnv } from './store-contract.ts';

const SOURCE = 'thunderstore:valheim';
const TICK_MS = 300_000;

const snap = (version: string): PackageSnapshot => makeSnapshot({ packageId: 'Owner-Mod', owner: 'Owner', name: 'Mod', version });

/** Full diff, fan-out, commit and drain path over a real `Store`: a release delivered once is never sent again. */
export function runRedeliveryScenario(name: string, create: () => Promise<StoreContractEnv> | StoreContractEnv): void {
  describe(`No re-delivery: ${name}`, () => {
    async function setup() {
      const env = await create();
      await env.addSubscription(makeSubscription({ id: 'sub-1', mode: 'immediate' }));
      const adapter = new FakeAdapter({ id: SOURCE }, { reconcilable: true });
      const sender = new FakeSender();
      const clock = new FakeClock(FIXED_NOW_ISO);
      const deps: TickDeps = {
        store: env.store,
        sender,
        renderer: new FakeRenderer(),
        clock,
        adapters: [adapter],
        config: makeConfig([adapter.config]),
        secrets: {},
        fetch: (() => {
          throw new Error('unexpected fetch');
        }) as unknown as typeof fetch,
      };
      let tick = 0;
      const poll = async (version: string) => {
        adapter.enqueue(okPoll([snap(version)]));
        clock.advance(TICK_MS);
        return runTick(deps, Date.parse(FIXED_NOW_ISO) + TICK_MS * ++tick);
      };
      const reconcileAfterRetention = async () => {
        clock.advance((DELIVERED_RETENTION_DAYS + 1) * MS_PER_DAY);
        adapter.reconcileResult = [];
        return runReconcile(deps, clock.now().getTime(), 0);
      };
      adapter.enqueue(okPoll([snap('1.0.0')]));
      await runTick(deps, Date.parse(FIXED_NOW_ISO));
      return { env, sender, poll, reconcileAfterRetention };
    }

    it('does not resend a rolled-back release within the retention window', async () => {
      const { sender, poll } = await setup();
      await poll('1.1.0');
      await poll('1.2.0');
      expect(sender.calls).toHaveLength(2);
      await poll('1.1.0');
      await poll('1.2.0');
      expect(sender.calls).toHaveLength(2);
    });

    it('does not resend a rolled-back release after the delivered outbox rows were purged', async () => {
      const { sender, poll, reconcileAfterRetention } = await setup();
      await poll('1.1.0');
      await poll('1.2.0');
      expect(sender.calls).toHaveLength(2);

      const purged = await reconcileAfterRetention();
      expect(purged.purged).toBe(2);

      const back = await poll('1.1.0');
      expect(back.sources[SOURCE]).toMatchObject({ status: 'ok', events: 0 });
      await poll('1.2.0');
      await poll('1.1.0');
      expect(sender.calls).toHaveLength(2);
    });

    it('does not send an old release to a subscription created after its delivery', async () => {
      const { env, sender, poll, reconcileAfterRetention } = await setup();
      await poll('1.1.0');
      await poll('1.2.0');
      await reconcileAfterRetention();
      await env.addSubscription(makeSubscription({ id: 'sub-2', webhookUrl: 'https://discord.invalid/api/webhooks/2/token', mode: 'immediate' }));

      await poll('1.1.0');
      await poll('1.2.0');
      expect(sender.calls).toHaveLength(2);
      expect(sender.callsTo('https://discord.invalid/api/webhooks/2/token')).toHaveLength(0);
    });

    it('still announces a genuinely new version after a roll-back', async () => {
      const { sender, poll, reconcileAfterRetention } = await setup();
      await poll('1.1.0');
      await reconcileAfterRetention();
      const next = await poll('1.3.0');
      expect(next.sources[SOURCE]).toMatchObject({ events: 1 });
      expect(sender.calls).toHaveLength(2);
    });
  });
}
