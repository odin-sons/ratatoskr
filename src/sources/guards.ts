// SPDX-License-Identifier: AGPL-3.0-or-later

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
