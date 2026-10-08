// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Prepared } from '../compact.ts';
import { STORES } from '../stores.ts';
import { mdLink } from '../text.ts';
import { defaultDigestLineTemplate } from './defaults.ts';
import { limitValue } from './limit.ts';
import type { ParsedTemplate, Part, VarPart } from './parse.ts';

/** Longest line a template may produce for one mod; a longer one is replaced by the default line. */
export const LINE_MAX_CHARS = 600;

export interface LineContext {
  storeEmojis: Readonly<Record<string, string>>;
}

type LineVariable = (p: Prepared, ctx: LineContext, form: string | undefined) => string;

const versions = (p: Prepared): string => (p.from ? `${p.from} → ${p.to}` : p.to);

/** The variables of a digest line; they are the ones that make sense for one mod in a list. */
export const LINE_VARIABLES: Readonly<Record<string, { forms?: readonly string[]; value: LineVariable }>> = {
  name: { forms: ['link', 'plain'], value: (p, _ctx, form) => (form === 'link' && p.url ? mdLink(p.name, p.url) : p.name) },
  owner: { value: (p) => p.owner },
  store: { value: (p) => STORES[p.store].label },
  store_emoji: { value: (p, ctx) => ctx.storeEmojis[p.store] ?? '' },
  version: { value: (p) => p.to },
  version_from: { value: (p) => p.from ?? '' },
  versions: { value: versions },
  size: { value: (p) => p.size ?? '' },
  url: { value: (p) => p.url ?? '' },
};

interface Tally {
  vars: number;
  filled: number;
}

function renderParts(parts: readonly Part[], p: Prepared, ctx: LineContext, tally: Tally): string {
  let out = '';
  for (const part of parts) {
    if (part.t === 'text') {
      out += part.text;
    } else if (part.t === 'var') {
      out += renderVar(part, p, ctx, tally);
    } else {
      const inner: Tally = { vars: 0, filled: 0 };
      const text = renderParts(part.parts, p, ctx, inner);
      tally.vars += inner.vars;
      tally.filled += inner.filled;
      if (inner.vars === 0 || inner.filled > 0) out += text;
    }
  }
  return out;
}

function renderVar(part: VarPart, p: Prepared, ctx: LineContext, tally: Tally): string {
  const def = LINE_VARIABLES[part.name];
  tally.vars += 1;
  if (def === undefined) return '';
  const form = part.forms.find((candidate) => def.forms?.includes(candidate));
  const value = limitValue(def.value(p, ctx, form), part.chars, part.lines).replace(/\s*\n\s*/g, ' ');
  if (value !== '') tally.filled += 1;
  return value;
}

function renderWith(template: ParsedTemplate, p: Prepared, ctx: LineContext): string {
  const lines: string[] = [];
  for (const block of template.blocks) {
    for (const line of block.lines) {
      if (line.kind !== 'text') continue;
      const tally: Tally = { vars: 0, filled: 0 };
      const text = renderParts(line.parts, p, ctx, tally);
      if (tally.vars > 0 && tally.filled === 0) continue;
      if (text.trim() !== '') lines.push(text.trim());
    }
  }
  return lines.join(' ');
}

/** The L0 line of one mod: from the template when it gives a usable line, otherwise from the default template. */
export function renderLine(template: ParsedTemplate | null, p: Prepared, ctx: LineContext): string {
  if (template !== null) {
    const line = renderWith(template, p, ctx);
    if (line !== '' && line.length <= LINE_MAX_CHARS) return line;
  }
  return renderWith(defaultDigestLineTemplate(), p, ctx);
}
