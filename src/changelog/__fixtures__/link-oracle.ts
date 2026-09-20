// SPDX-License-Identifier: AGPL-3.0-or-later
import fc from 'fast-check';

/**
 * Independent model of Discord's inline Markdown links, written from the regexes of its simple-markdown fork.
 * It shares no code with the sanitiser: code blocks open anywhere and close at the first following fence, inline code
 * is a backtick run closed by an equal run and spans lines, there are no `~~~` fences, `\` escapes any punctuation.
 */
const ESCAPE = /^\\[^0-9A-Za-z\s]/;
const CODE_BLOCK = /^```(?:([a-z0-9_+\-.#]+?)\n)?\n*([^\n][^]*?)\n*```/i;
const INLINE_CODE = /^(`+)([\s\S]*?[^`])\1(?!`)/;
const LINK = /^\[((?:\[[^\]]*\]|[^[\]]|\](?=[^[]*\]))*)\]\(\s*<?((?:\([^)]*\)|[^\s\\]|\\.)*?)>?(?:\s+['"]([\s\S]*?)['"])?\s*\)/;
const REFERENCE_LINK = /^\[((?:\[[^\]]*\]|[^[\]]|\](?=[^[]*\]))*)\]\s*\[([^\]]*)\]/;
const REFERENCE_DEFINITION = /^ *\[([^\]]+)\]: *<?([^\s>]*)>?(?: +["(]([^\n]+)[")])? *(?:\n|$)/gm;
const AUTOLINK = /^<([^: >]+:\/[^ >]+)>/;
const HTTP = /^https?:\/\//i;

function nonHttp(target: string): boolean {
  const trimmed = target.trim();
  return trimmed !== '' && !HTTP.test(trimmed);
}

function collect(text: string, definitions: Map<string, string>, bad: string[]): void {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const rest = text.slice(i);
    if (c === '\\') {
      i += ESCAPE.test(rest) ? 2 : 1;
    } else if (c === '`') {
      const code = (rest.startsWith('```') ? CODE_BLOCK.exec(rest) : null) ?? INLINE_CODE.exec(rest);
      i += code === null ? 1 : code[0].length;
    } else if (c === '<') {
      const auto = AUTOLINK.exec(rest);
      if (auto === null) i += 1;
      else {
        if (nonHttp(auto[1]!)) bad.push(auto[0].slice(0, 60));
        i += auto[0].length;
      }
    } else if (c === '[') {
      const link = LINK.exec(rest);
      const reference = link === null ? REFERENCE_LINK.exec(rest) : null;
      if (link !== null) {
        if (nonHttp(link[2]!)) bad.push(link[0].slice(0, 60));
        collect(link[1]!, definitions, bad);
        i += link[0].length;
      } else if (reference !== null) {
        const target = definitions.get((reference[2] === '' ? reference[1]! : reference[2]!).toLowerCase());
        if (target !== undefined && nonHttp(target)) bad.push(reference[0].slice(0, 60));
        collect(reference[1]!, definitions, bad);
        i += reference[0].length;
      } else i += 1;
    } else i += 1;
  }
}

/** Every link Discord would render from `markdown` whose destination is not http(s), with a few characters of context. */
export function unsafeLinkTargets(markdown: string): string[] {
  const definitions = new Map<string, string>();
  for (const match of markdown.matchAll(REFERENCE_DEFINITION)) definitions.set(match[1]!.toLowerCase(), match[2]!);
  const bad: string[] = [];
  collect(markdown, definitions, bad);
  return bad;
}

const TARGETS = [
  'javascript:alert(1)',
  'JaVaScRiPt:x',
  'data:text/html,x',
  '//evil.example',
  'https://ok.example/a',
  'http://ok.example',
  '',
  ' javascript:x',
  'vbscript:x',
  'https://ok.example/(x)',
  'file:///etc/passwd',
  'steam://run/1',
  '<javascript:x>',
  '<https://ok.example/a>',
];

export const ATOMS = [
  'a',
  'b c',
  '`',
  '``',
  '```',
  '~~~',
  '````````',
  '\\',
  '\\`',
  '!',
  '[',
  ']',
  '(',
  ')',
  '<',
  '>',
  '](',
  '&#91;',
  '&#93;',
  '&#40;',
  '&#41;',
  '&#96;',
  '&#x60;',
  '&#x5D;',
  '&lt;',
  '&gt;',
  '<b>',
  '</b>',
  '<!--',
  '-->',
  ' ',
  '\n',
  '@everyone',
  '"',
  'javascript:x',
  'steam://run/1',
  '<javascript:x>',
  '<steam://run/1>',
  '&lt;steam://run/1&gt;',
  '[ref]: javascript:x\n',
  '[ref][ref]',
  '[ref]',
];

/** Text built from deeply nested and half-open links, images, escapes, entities, backticks and tildes; may span lines. */
export const nestedLinkText: fc.Arbitrary<string> = fc.letrec<{ node: string; link: string }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small' },
    fc.constantFrom(...ATOMS),
    tie('link'),
    fc.array(tie('node'), { maxLength: 4 }).map((parts) => parts.join('')),
  ),
  link: fc
    .tuple(
      fc.constantFrom('[', '![', '\\[', '&#91;'),
      tie('node'),
      fc.constantFrom(']', '\\]', '&#93;'),
      fc.constantFrom('(', '&#40;', '\\(', '( ', '(<'),
      fc.constantFrom(...TARGETS),
      fc.constantFrom(')', '&#41;', '', '>)'),
    )
    .map((parts) => parts.join('')),
})).node;

/** Multi-line variant: nested-link lines mixed with fences, headings and list markers. */
export const nestedLinkDocument: fc.Arbitrary<string> = fc
  .array(fc.oneof(nestedLinkText, fc.constantFrom('```', '~~~', '````````', '### ', '- ', '<br>')), { minLength: 1, maxLength: 8 })
  .map((parts) => parts.join('\n'));
