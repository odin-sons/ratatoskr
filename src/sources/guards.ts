// SPDX-License-Identifier: AGPL-3.0-or-later
import { hasDeliverableHost } from '../text/url.ts';
import { SOURCE_URL_MAX_CHARS } from './budget.ts';

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A non-negative safe integer (a download count), else null. */
export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function safeSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(value);
}

/** Thrown for upstream payloads that do not have the shape we rely on. */
export class UnexpectedShapeError extends Error {
  constructor(what: string) {
    super(`unexpected upstream shape: ${what}`);
    this.name = 'UnexpectedShapeError';
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UnexpectedShapeError('body is not valid JSON');
  }
}

/** An http(s) URL without credentials and with a host Discord accepts on a link button (see `hasDeliverableHost`), at most `SOURCE_URL_MAX_CHARS` long before and after normalisation, as `URL.href`; else null. */
export function websiteUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > SOURCE_URL_MAX_CHARS) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const plain = (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '' && hasDeliverableHost(url.hostname);
  return plain && url.href.length <= SOURCE_URL_MAX_CHARS ? url.href : null;
}
