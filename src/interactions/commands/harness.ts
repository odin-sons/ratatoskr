// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store } from '../../core/ports.ts';
import type { SourceConfig, Subscription } from '../../core/types.ts';
import { en } from '../../i18n/en.ts';
import type { Messages } from '../../i18n/index.ts';
import { MemoryStore } from '../../testing/memory-store.ts';
import { APP_ID, CHANNEL_ID, GUILD_ID, INTERACTION_ID, THREAD_ID, TOKEN_SENTINEL } from '../../testing/signing.ts';
import { CHANNEL_TYPE, PERMISSION } from '../constants.ts';
import { createCommandRegistry } from '../commands.ts';
import type { HandlerContext, HandlerRegistry } from '../router.ts';
import { routeInteraction } from '../router.ts';
import type { InteractionResponse } from '../responses.ts';
import { parseInteraction, type Interaction } from '../types.ts';
import type { CommandDeps } from './deps.ts';

export { APP_ID, CHANNEL_ID, GUILD_ID, THREAD_ID };
export const PARENT_ID = '923456789012345678';
export const USER_ID = '323456789012345678';
export const NOW = new Date('2026-09-19T12:00:00.000Z');

export const MANAGE = String(PERMISSION.manageChannels);
export const ALL_BOT_PERMISSIONS = String(
  PERMISSION.viewChannel | PERMISSION.sendMessages | PERMISSION.embedLinks | PERMISSION.sendMessagesInThreads | PERMISSION.createPublicThreads,
);

export const SOURCES: SourceConfig[] = [
  { id: 'thunderstore:valheim', store: 'thunderstore', community: 'valheim', enabled: true },
  { id: 'hexium:valheim', store: 'hexium', community: 'valheim', enabled: true },
];

type Json = Record<string, unknown>;

/** A signed-payload-shaped interaction in a text channel by a member who may manage it; override any part. */
export function interaction(over: Json = {}): Interaction {
  const parsed = parseInteraction({
    id: INTERACTION_ID,
    application_id: APP_ID,
    type: 2,
    token: TOKEN_SENTINEL,
    guild_id: GUILD_ID,
    channel: { id: CHANNEL_ID, type: CHANNEL_TYPE.guildText },
    member: { permissions: MANAGE, user: { id: USER_ID } },
    app_permissions: ALL_BOT_PERMISSIONS,
    ...over,
  });
  if (parsed === null) throw new Error('bad test interaction');
  return parsed;
}

export const inThread = (over: Json = {}): Interaction => interaction({ channel: { id: THREAD_ID, type: CHANNEL_TYPE.publicThread, parent_id: CHANNEL_ID }, ...over });

export const command = (name: string, options: Record<string, string | number | boolean> = {}, over: Json = {}): Interaction =>
  interaction({ data: { name, options: Object.entries(options).map(([key, value]) => ({ name: key, type: 3, value })) }, ...over });

export const autocompleteOf = (name: string, focused: string, value: string, over: Json = {}): Interaction =>
  interaction({ type: 4, data: { name, options: [{ name: focused, type: 3, value, focused: true }] }, ...over });

export const component = (customId: string, over: Json = {}): Interaction => interaction({ type: 3, data: { custom_id: customId }, ...over });

export function subscription(over: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-1',
    guildId: GUILD_ID,
    transport: 'bot',
    channelId: CHANNEL_ID,
    label: 'Valheim news',
    createdBy: USER_ID,
    threadPerMod: false,
    filter: {},
    mode: 'digest',
    digestIntervalMin: 30,
    enabled: true,
    ...over,
  };
}

export interface Harness<S extends Store = MemoryStore> {
  store: S;
  deps: CommandDeps;
  registry: HandlerRegistry;
  /** Bodies PATCHed to the interaction webhook, parsed. */
  finished: Json[];
  /** Routes an interaction and, for a deferral, waits for the follow-up. */
  run(interaction: Interaction): Promise<InteractionResponse>;
  /** The last follow-up message content. */
  followUp(): string;
}

export function harness<S extends Store = MemoryStore>(options: { messages?: Messages; ids?: string[]; sources?: SourceConfig[]; store?: S; now?: () => Date } = {}): Harness<S> {
  const store = options.store ?? (new MemoryStore() as unknown as S);
  const ids = [...(options.ids ?? [])];
  let counter = 0;
  const deps: CommandDeps = { store, sources: options.sources ?? SOURCES, newId: () => ids.shift() ?? `id-${(counter += 1)}`, now: options.now ?? (() => NOW) };
  const registry = createCommandRegistry(deps);
  const finished: Json[] = [];
  const pending: Promise<unknown>[] = [];
  const ctx: HandlerContext = {
    messages: options.messages ?? en,
    waitUntil: (promise) => void pending.push(promise),
    fetch: ((_url: string, init?: RequestInit) => {
      finished.push(JSON.parse(String(init?.body)) as Json);
      return Promise.resolve(new Response('{}'));
    }) as unknown as typeof fetch,
  };
  return {
    store,
    deps,
    registry,
    finished,
    async run(target) {
      const response = await routeInteraction(registry, target, ctx);
      await Promise.all(pending.splice(0));
      return response;
    },
    followUp: () => String(finished.at(-1)?.content),
  };
}
