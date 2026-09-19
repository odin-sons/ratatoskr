// SPDX-License-Identifier: AGPL-3.0-or-later

const ZWSP = String.fromCharCode(0x200b);
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

const INVISIBLE = '[\\u00AD\\u180E\\u200B-\\u200F\\u2060-\\u2064\\uFEFF]*';
const AT_SIGNS = '[@\\uFF20\\uFE6B]';

const BROADCAST_MENTION = new RegExp(`${AT_SIGNS}${INVISIBLE}(everyone|here)`, 'gi');
const TAGGED_MENTION = /<(?=[@#][!&]?\d+>|\/[\w -]{1,64}:\d+>)/g;

/** Breaks `@everyone`, `@here`, user/role/channel and slash-command mentions so Discord does not resolve them. */
export function neutralizeMentions(text: string): string {
  return text.replace(BROADCAST_MENTION, `@${ZWSP}$1`).replace(TAGGED_MENTION, `<${ZWSP}`);
}

/** Escapes Markdown control characters so untrusted text renders literally inside a message. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~|`[\]()<>#]/g, '\\$&');
}

const UNSAFE_CHARS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u200B\\u200C\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]' +
    '|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
  'g',
);

/** Removes control characters, bidi overrides, zero-width characters (except ZWJ) and lone surrogates. */
export function stripUnsafeChars(text: string): string {
  return text.replace(UNSAFE_CHARS, '');
}

const NAMED_ENTITIES = new Map<string, string>([
  ['nbsp', ' '],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['amp', '&'],
  ['hellip', '…'],
  ['ndash', '–'],
  ['mdash', '—'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['copy', '©'],
  ['reg', '®'],
  ['trade', '™'],
  ['bull', '•'],
  ['middot', '·'],
  ['times', '×'],
  ['larr', '←'],
  ['rarr', '→'],
]);

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,8}));/g;

function decodeEntity(match: string, dec: string | undefined, hex: string | undefined, name: string | undefined): string {
  if (name !== undefined) return NAMED_ENTITIES.get(name) ?? match;
  const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
  if (code === 0x09 || code === 0x0a || code === 0x0d) return String.fromCharCode(code);
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return '';
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return REPLACEMENT_CHAR;
  return String.fromCodePoint(code);
}

const BLOCK_OPEN = /<(script|style)\b/gi;
const BLOCK_CLOSE = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi };

function dropBlocks(html: string): string {
  let out = '';
  let pos = 0;
  BLOCK_OPEN.lastIndex = 0;
  for (let open = BLOCK_OPEN.exec(html); open !== null; open = BLOCK_OPEN.exec(html)) {
    const closer = open[1]?.toLowerCase() === 'style' ? BLOCK_CLOSE.style : BLOCK_CLOSE.script;
    closer.lastIndex = open.index;
    const close = closer.exec(html);
    out += html.slice(pos, open.index);
    if (close === null) return out;
    pos = close.index + close[0].length;
    BLOCK_OPEN.lastIndex = pos;
  }
  return out + html.slice(pos);
}

function dropComments(html: string): string {
  let out = '';
  let pos = 0;
  for (let open = html.indexOf('<!--', pos); open !== -1; open = html.indexOf('<!--', pos)) {
    out += html.slice(pos, open);
    const close = html.indexOf('-->', open + 4);
    if (close === -1) return out;
    pos = close + 3;
  }
  return out + html.slice(pos);
}

/** Strips HTML tags and decodes entities. Linear-time on adversarial input. */
export function stripHtml(html: string): string {
  return dropComments(dropBlocks(html))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^<>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div|li|ul|ol|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<\/?[a-zA-Z][^<>]*>/g, '')
    .replace(ENTITY, decodeEntity);
}

/** Truncates to at most `max` UTF-16 code units without splitting a surrogate pair; appends `…` when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return max === 1 ? '…' : '';
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Full pipeline for untrusted upstream prose headed for a Discord field. */
export function sanitizeUntrusted(text: string, max: number): string {
  if (typeof text !== 'string') return '';
  return truncate(neutralizeMentions(stripUnsafeChars(stripHtml(text))).trim(), max);
}
