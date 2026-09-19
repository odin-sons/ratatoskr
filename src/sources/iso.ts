// SPDX-License-Identifier: AGPL-3.0-or-later

const ISO_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Canonical `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC, 6-digit fraction) so timestamps
 * compare correctly as plain strings. Returns null when unparseable.
 */
export function normalizeIso(value: string): string | null {
  const m = ISO_RE.exec(value.trim());
  if (!m) return null;
  const [, date, time, frac = '', zone = 'Z'] = m;
  const isUtc = zone.toUpperCase() === 'Z' || /^[+-]00:?00$/.test(zone);
  if (isUtc) {
    if (Number.isNaN(Date.parse(`${date}T${time}Z`))) return null;
    return `${date}T${time}.${frac.padEnd(6, '0').slice(0, 6)}Z`;
  }
  const ms = Date.parse(`${date}T${time}${zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`);
  if (Number.isNaN(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 19)}.${String(ms % 1000).padStart(3, '0')}000Z`;
}

export function epochSecondsToIso(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.000000Z`;
}

export function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}
