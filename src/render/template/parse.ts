// SPDX-License-Identifier: AGPL-3.0-or-later
import { TEMPLATE_MAX_CHARS, TEMPLATE_MAX_VARIABLES } from '../../core/constants.ts';
import { stripUnsafeChars } from '../../text/sanitize.ts';

/** A variable with its arguments: words are candidate forms, the registry decides which ones exist. */
export interface VarPart {
  t: 'var';
  name: string;
  forms: string[];
  chars?: number;
  lines?: number;
}

export type Part = { t: 'text'; text: string } | VarPart | { t: 'opt'; parts: Part[] };

export interface TextLine {
  kind: 'text';
  parts: Part[];
}

/** A line made only of button variables. */
export interface RowLine {
  kind: 'row';
  buttons: string[];
}

export type Line = TextLine | RowLine;

export interface Block {
  lines: Line[];
}

export type ParseWarning = { code: 'too_many_variables' };

export interface ParsedTemplate {
  blocks: Block[];
  warnings: ParseWarning[];
}

export const BUTTON_VARIABLES: readonly string[] = ['buttons', 'page_button', 'download_button', 'website_button', 'info_button'];

const VARIABLE = /^\s*([A-Za-z][A-Za-z0-9_]*)((?:\s*:\s*[^:{}\s]*)*)\s*$/;
const CHARS = /^\d{1,5}$/;
const LINES = /^l(\d{1,3})$/;
/** Variation selector 16 makes a symbol an emoji, so literal text keeps it although the sanitizer strips variation selectors. */
const EMOJI_PRESENTATION = '\uFE0F';
const OPTIONAL_OPEN = '(?';
const OPTIONAL_CLOSE = '?)';

interface Budget {
  variables: number;
  exceeded: boolean;
}

function variableOf(inner: string, budget: Budget): VarPart | 'over' | null {
  const match = VARIABLE.exec(inner);
  if (match === null) return null;
  if (budget.variables >= TEMPLATE_MAX_VARIABLES) {
    budget.exceeded = true;
    return 'over';
  }
  budget.variables += 1;
  const part: VarPart = { t: 'var', name: match[1]!.toLowerCase(), forms: [] };
  for (const raw of (match[2] ?? '').split(':').slice(1)) {
    const arg = raw.trim().toLowerCase();
    const lines = LINES.exec(arg);
    if (arg === '') continue;
    if (CHARS.test(arg)) part.chars = Number(arg);
    else if (lines !== null) part.lines = Number(lines[1]);
    else part.forms.push(arg);
  }
  return part;
}

function pushText(parts: Part[], text: string): void {
  if (text === '') return;
  const last = parts[parts.length - 1];
  if (last?.t === 'text') last.text += text;
  else parts.push({ t: 'text', text });
}

/** Parses one line of a template into parts; text that is not a valid construct stays text. */
function parseParts(source: string, budget: Budget, allowOptional: boolean): Part[] {
  const parts: Part[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    if (rest.startsWith('{{')) {
      pushText(parts, '{');
      i += 2;
    } else if (rest.startsWith('}}')) {
      pushText(parts, '}');
      i += 2;
    } else if (source[i] === '{') {
      const end = source.indexOf('}', i + 1);
      const variable = end === -1 ? null : variableOf(source.slice(i + 1, end), budget);
      if (end === -1 || variable === null) {
        pushText(parts, '{');
        i += 1;
      } else {
        if (variable !== 'over') parts.push(variable);
        i = end + 1;
      }
    } else if (allowOptional && rest.startsWith(OPTIONAL_OPEN)) {
      const close = source.indexOf(OPTIONAL_CLOSE, i + OPTIONAL_OPEN.length);
      if (close === -1) {
        pushText(parts, OPTIONAL_OPEN);
        i += OPTIONAL_OPEN.length;
      } else {
        parts.push({ t: 'opt', parts: parseParts(source.slice(i + OPTIONAL_OPEN.length, close), budget, false) });
        i = close + OPTIONAL_CLOSE.length;
      }
    } else {
      pushText(parts, source[i]!);
      i += 1;
    }
  }
  return parts;
}

function asRow(parts: readonly Part[]): RowLine | null {
  const buttons: string[] = [];
  for (const part of parts) {
    if (part.t === 'var' && BUTTON_VARIABLES.includes(part.name)) buttons.push(part.name);
    else if (part.t === 'text' && part.text.trim() === '') continue;
    else return null;
  }
  return buttons.length === 0 ? null : { kind: 'row', buttons };
}

/** Parses a template. It never throws: anything that is not a construct of the language is literal text. */
export function parseTemplate(source: string): ParsedTemplate {
  const cleaned = source
    .slice(0, TEMPLATE_MAX_CHARS)
    .split(EMOJI_PRESENTATION)
    .map(stripUnsafeChars)
    .join(EMOJI_PRESENTATION)
    .replace(/\r\n?/g, '\n');
  const budget: Budget = { variables: 0, exceeded: false };
  const blocks: Block[] = [];
  let current: Line[] = [];
  const blank = (line: Line): boolean => line.kind === 'text' && line.parts.every((part) => part.t === 'text' && part.text.trim() === '');
  const flush = (): void => {
    while (current.length > 0 && blank(current[0]!)) current.shift();
    while (current.length > 0 && blank(current[current.length - 1]!)) current.pop();
    if (current.length > 0) blocks.push({ lines: current });
    current = [];
  };
  for (const text of cleaned.split('\n')) {
    if (text.trim() === '---') {
      flush();
      continue;
    }
    const parts = parseParts(text, budget, true);
    current.push(asRow(parts) ?? { kind: 'text', parts });
  }
  flush();
  return { blocks, warnings: budget.exceeded ? [{ code: 'too_many_variables' }] : [] };
}
