// SPDX-License-Identifier: AGPL-3.0-or-later
import { defer, finishDeferred, reply, type InteractionMessage, type InteractionResponse } from '../responses.ts';
import type { HandlerContext } from '../router.ts';
import type { Interaction } from '../types.ts';

/** Answers with an ephemeral deferral and runs `work` afterwards, so nothing runs when the follow-up cannot be sent. */
export function deferWork(interaction: Interaction, ctx: HandlerContext, work: () => Promise<InteractionMessage>): InteractionResponse {
  let start!: () => void;
  const gate = new Promise<void>((resolve) => {
    start = resolve;
  });
  if (!finishDeferred(ctx, interaction, gate.then(work))) return reply({ content: ctx.messages.somethingWrong }, { ephemeral: true });
  start();
  return defer({ ephemeral: true });
}
