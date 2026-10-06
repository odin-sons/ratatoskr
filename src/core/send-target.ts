// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SendTarget } from './ports.ts';

/** Rate-limit and failure grouping key: the webhook URL, or the channel id of a bot target; never the thread. */
export function targetKey(target: SendTarget): string {
  return target.kind === 'webhook' ? target.url : `channel:${target.channelId}`;
}
