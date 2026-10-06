// SPDX-License-Identifier: AGPL-3.0-or-later

/** `paused_until` of a pause without an end. */
export const PAUSE_OPEN_ENDED = Number.MAX_SAFE_INTEGER;

export const PAUSE_MIN_SECONDS = 60;
export const PAUSE_MAX_SECONDS = 90 * 86_400;

/** Longest `for` text the command definition accepts; a six-digit number plus a unit fits. */
export const PAUSE_DURATION_OPTION_MAX = 10;

const UNIT_SECONDS = { m: 60, h: 3_600, d: 86_400 } as const;
const DURATION = /^(\d{1,6})([mhd])$/;

/** Seconds of a duration such as `30m`, `2h` or `3d`; null when it is not one or lies outside the allowed range. */
export function parsePauseDuration(text: string): number | null {
  const match = DURATION.exec(text.trim().toLowerCase());
  if (match === null) return null;
  const seconds = Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
  return seconds >= PAUSE_MIN_SECONDS && seconds <= PAUSE_MAX_SECONDS ? seconds : null;
}
