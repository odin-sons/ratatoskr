// SPDX-License-Identifier: AGPL-3.0-or-later
import { PAUSE_OPEN_ENDED, parsePauseDuration } from '../../core/pause.ts';
import { isPaused, type Subscription } from '../../core/types.ts';
import type { Messages } from '../../i18n/index.ts';
import { truncate } from '../../text/sanitize.ts';
import { requireManageChannel } from '../permissions.ts';
import { parseOptions } from '../options.ts';
import { reply, type InteractionResponse } from '../responses.ts';
import type { InteractionHandler } from '../router.ts';
import { resolveTarget } from '../target.ts';
import type { Interaction } from '../types.ts';
import type { CommandDeps } from './deps.ts';
import { deferWork } from './defer-work.ts';
import { pickSubscription } from './unsubscribe.ts';
import { display, subscriptionName, subscriptionsHere } from './view.ts';

const NAMES_MAX = 600;

const relative = (epochSeconds: number): string => `<t:${epochSeconds}:R>`;

/** How a pause shows in `/list`; null while the subscription is not paused. */
export function describePause(sub: Subscription, now: Date, messages: Messages): string | null {
  if (!isPaused(sub, now)) return null;
  const until = sub.pausedUntil ?? 0;
  return until === PAUSE_OPEN_ENDED ? messages.listPausedOpen : messages.listPausedUntil(relative(until));
}

const namesOf = (subs: readonly Subscription[]): string => display(truncate(subs.map(subscriptionName).join(', '), NAMES_MAX));

/** The subscriptions a command applies to: the chosen one, or every one of the place; null when the chosen one is not here. */
async function targetsOf(deps: CommandDeps, interaction: Interaction, chosen: string | undefined): Promise<Subscription[] | null> {
  const here = (await subscriptionsHere(deps.store, interaction)) ?? [];
  if (chosen === undefined || chosen.trim() === '') return here;
  const sub = pickSubscription(here, chosen);
  return sub === undefined ? null : [sub];
}

function guard(interaction: Interaction, messages: Messages): InteractionResponse | null {
  const denied = requireManageChannel(interaction, messages);
  if (denied) return denied;
  const target = resolveTarget(interaction);
  if (!target.ok) return reply({ content: target.reason === 'dm' ? messages.guildOnly : messages.unsupportedChannel }, { ephemeral: true });
  return null;
}

export function createPauseCommand(deps: CommandDeps): InteractionHandler {
  return (interaction, ctx): InteractionResponse => {
    const { messages } = ctx;
    const refused = guard(interaction, messages);
    if (refused) return refused;
    const options = parseOptions(interaction);
    const text = options.string('for');
    let seconds: number | null = null;
    if (text !== undefined && text.trim() !== '') {
      seconds = parsePauseDuration(text);
      if (seconds === null) return reply({ content: messages.pauseInvalidDuration }, { ephemeral: true });
    }
    const chosen = options.string('subscription');
    return deferWork(interaction, ctx, async () => {
      const targets = await targetsOf(deps, interaction, chosen);
      if (targets === null) return { content: messages.subscriptionNotFound };
      if (targets.length === 0) return { content: messages.listEmpty };
      const now = deps.now();
      const fresh = targets.filter((sub) => !isPaused(sub, now));
      const already = targets.filter((sub) => isPaused(sub, now));
      const lines: string[] = [];
      if (fresh.length > 0) {
        const until = seconds === null ? PAUSE_OPEN_ENDED : Math.floor(now.getTime() / 1000) + seconds;
        await deps.store.setPausedUntil(fresh.map((sub) => sub.id), until);
        await deps.store.clearUndelivered(fresh.map((sub) => sub.id));
        lines.push(until === PAUSE_OPEN_ENDED ? messages.pausedOpen(namesOf(fresh)) : messages.pausedFor(namesOf(fresh), relative(until)));
      }
      if (already.length > 0) lines.push(messages.alreadyPaused(namesOf(already)));
      return { content: lines.join('\n') };
    });
  };
}

export function createContinueCommand(deps: CommandDeps): InteractionHandler {
  return (interaction, ctx): InteractionResponse => {
    const { messages } = ctx;
    const refused = guard(interaction, messages);
    if (refused) return refused;
    const chosen = parseOptions(interaction).string('subscription');
    return deferWork(interaction, ctx, async () => {
      const targets = await targetsOf(deps, interaction, chosen);
      if (targets === null) return { content: messages.subscriptionNotFound };
      if (targets.length === 0) return { content: messages.listEmpty };
      const now = deps.now();
      const paused = targets.filter((sub) => isPaused(sub, now));
      const idle = targets.filter((sub) => !isPaused(sub, now));
      const lines: string[] = [];
      if (paused.length > 0) {
        await deps.store.setPausedUntil(paused.map((sub) => sub.id), 0);
        lines.push(messages.resumed(namesOf(paused)));
      }
      if (idle.length > 0) lines.push(messages.notPaused(namesOf(idle)));
      return { content: lines.join('\n') };
    });
  };
}
