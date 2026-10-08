// SPDX-License-Identifier: AGPL-3.0-or-later
import { finalizeExcerpt } from '../../changelog/excerpt.ts';

const ELLIPSIS = '…';

/** The first `max` lines of `value`, an ellipsis ending the last one when lines were left out. */
export function limitLines(value: string, max: number): string {
  if (max < 1) return '';
  const lines = value.split('\n');
  if (lines.length <= max) return value;
  return `${lines.slice(0, max).join('\n').trimEnd()}${ELLIPSIS}`;
}

/** Applies the limits a template asks for to a value that is already safe Markdown; cuts avoid links and escape pairs. */
export function limitValue(value: string, chars: number | undefined, lines: number | undefined): string {
  let out = value;
  if (lines !== undefined) out = limitLines(out, lines);
  if (chars !== undefined && out.length > chars) out = finalizeExcerpt(out, { maxChars: chars, wordBoundary: true }) ?? '';
  return out;
}
