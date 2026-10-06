// SPDX-License-Identifier: AGPL-3.0-or-later
import { INTERACTION_BODY_MAX_BYTES } from '../core/constants.ts';
import { ED25519_PUBLIC_KEY_BYTES, ED25519_SIGNATURE_BYTES, SIGNATURE_HEADER, TIMESTAMP_HEADER, TIMESTAMP_HEADER_MAX_LENGTH } from './constants.ts';

export type VerifyResult = { ok: true; body: Uint8Array<ArrayBuffer> } | { ok: false; status: 401 };

const HEX = /^(?:[0-9a-fA-F]{2})*$/;
const encoder = new TextEncoder();

function fromHex(hex: string, length: number): Uint8Array<ArrayBuffer> | null {
  if (hex.length !== length * 2 || !HEX.test(hex)) return null;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Reads at most `max` bytes; null when the body is larger. */
async function readBounded(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > max) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Ed25519 check of `signature` over `timestamp` followed by `body`; false for any malformed input, never throws. */
export async function verifySignature(publicKeyHex: string, signatureHex: string, timestamp: string, body: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const publicKey = fromHex(publicKeyHex, ED25519_PUBLIC_KEY_BYTES);
  const signature = fromHex(signatureHex, ED25519_SIGNATURE_BYTES);
  if (publicKey === null || signature === null) return false;
  try {
    const key = await crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']);
    const prefix = encoder.encode(timestamp);
    const message = new Uint8Array(prefix.byteLength + body.byteLength);
    message.set(prefix, 0);
    message.set(body, prefix.byteLength);
    return await crypto.subtle.verify('Ed25519', key, signature, message);
  } catch {
    return false;
  }
}

/** Checks the signature headers and body of an interaction request; nothing is parsed before it passes. */
export async function verifyRequest(request: Request, publicKeyHex: string): Promise<VerifyResult> {
  const signature = request.headers.get(SIGNATURE_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  if (signature === null || timestamp === null || timestamp.length === 0 || timestamp.length > TIMESTAMP_HEADER_MAX_LENGTH) return { ok: false, status: 401 };
  if (fromHex(signature, ED25519_SIGNATURE_BYTES) === null || fromHex(publicKeyHex, ED25519_PUBLIC_KEY_BYTES) === null) return { ok: false, status: 401 };
  const body = await readBounded(request, INTERACTION_BODY_MAX_BYTES);
  if (body === null) return { ok: false, status: 401 };
  return (await verifySignature(publicKeyHex, signature, timestamp, body)) ? { ok: true, body } : { ok: false, status: 401 };
}
