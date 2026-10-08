// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Messages } from '../../i18n/index.ts';
import { SECTION_EMOJI } from '../layout.ts';
import { parseTemplate, type ParsedTemplate } from './parse.ts';

const literal = (text: string): string => text.replaceAll('{', '{{').replaceAll('}', '}}');

/** The message of an event as the bot has always sent it, written in the template language. */
export function defaultImmediateSource(messages: Messages): string {
  return [
    '{icon}{title}',
    '{kind_line}',
    '{info_line}',
    '{also_on}',
    '',
    '{description}',
    '---',
    `**${literal(messages.changelog)}**`,
    '{changelog}',
    '---',
    `**${SECTION_EMOJI.categories} ${literal(messages.categories)}**`,
    '{categories}',
    '---',
    '{buttons} {info_button}',
  ].join('\n');
}

/** The line of a mod in a digest at level L0. */
export const DEFAULT_DIGEST_LINE_SOURCE = '**{name:link}** {versions}(? · {owner}?)(? · {size}?)';

const immediateCache = new WeakMap<Messages, ParsedTemplate>();
let digestLine: ParsedTemplate | null = null;

export function defaultImmediateTemplate(messages: Messages): ParsedTemplate {
  let parsed = immediateCache.get(messages);
  if (parsed === undefined) {
    parsed = parseTemplate(defaultImmediateSource(messages));
    immediateCache.set(messages, parsed);
  }
  return parsed;
}

export function defaultDigestLineTemplate(): ParsedTemplate {
  digestLine ??= parseTemplate(DEFAULT_DIGEST_LINE_SOURCE);
  return digestLine;
}
