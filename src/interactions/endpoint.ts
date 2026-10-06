// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Messages } from '../i18n/index.ts';
import { INTERACTION_TYPE, INTERACTIONS_PATH } from './constants.ts';
import { routeInteraction, type HandlerRegistry } from './router.ts';
import { pong, type InteractionResponse } from './responses.ts';
import { parseInteraction } from './types.ts';
import { verifyRequest } from './verify.ts';

export interface EndpointDeps {
  publicKey: string | undefined;
  registry: HandlerRegistry;
  messages: Messages;
  fetch: typeof fetch;
  waitUntil(promise: Promise<unknown>): void;
}

const empty = (status: number): Response => new Response(null, { status });

const json = (response: InteractionResponse): Response => new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });

/** `POST /interactions`: verify, parse, route. Every other path and method is a 404; nothing is parsed or read from storage before the signature passes. */
export async function handleInteractionRequest(request: Request, deps: EndpointDeps): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== INTERACTIONS_PATH) return empty(404);
  if (deps.publicKey === undefined || deps.publicKey.trim() === '') return empty(503);
  const verified = await verifyRequest(request, deps.publicKey.trim());
  if (!verified.ok) return empty(verified.status);
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(verified.body));
  } catch {
    return empty(400);
  }
  if (typeof payload === 'object' && payload !== null && (payload as { type?: unknown }).type === INTERACTION_TYPE.ping) return json(pong());
  const interaction = parseInteraction(payload);
  if (interaction === null) return empty(400);
  return json(await routeInteraction(deps.registry, interaction, { messages: deps.messages, fetch: deps.fetch, waitUntil: deps.waitUntil }));
}
