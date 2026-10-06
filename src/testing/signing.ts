// SPDX-License-Identifier: AGPL-3.0-or-later

const toHex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

export interface TestKeyPair {
  publicKeyHex: string;
  privateKey: CryptoKey;
}

/** A real Ed25519 key pair, as Discord holds for an application. */
export async function generateKeyPair(): Promise<TestKeyPair> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  return { publicKeyHex: toHex((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer), privateKey: pair.privateKey };
}

export async function sign(privateKey: CryptoKey, timestamp: string, body: string): Promise<string> {
  return toHex(await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(timestamp + body)));
}

export const NOW_TIMESTAMP = '1790000000';

/** A request to `url` signed the way Discord signs interactions. */
export async function signedRequest(
  keys: TestKeyPair,
  payload: unknown,
  { url = 'https://worker.example/interactions', timestamp = NOW_TIMESTAMP }: { url?: string; timestamp?: string } = {},
): Promise<Request> {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Request(url, {
    method: 'POST',
    headers: { 'x-signature-ed25519': await sign(keys.privateKey, timestamp, body), 'x-signature-timestamp': timestamp, 'content-type': 'application/json' },
    body,
  });
}

export const APP_ID = '423456789012345678';
export const INTERACTION_ID = '523456789012345678';
export const GUILD_ID = '623456789012345678';
export const CHANNEL_ID = '723456789012345678';
export const THREAD_ID = '823456789012345678';
export const TOKEN_SENTINEL = 'SENTINEL-INTERACTION-TOKEN-a1b2c3d4e5f6';

export function interactionPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: INTERACTION_ID, application_id: APP_ID, type: 2, token: TOKEN_SENTINEL, version: 1, ...over };
}
