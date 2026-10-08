// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD } from '../../core/constants.ts';
import type { DiscordActionRow, DiscordContainer, DiscordMessage, DiscordSeparator, ModEvent } from '../../core/types.ts';
import { downloadButton, linkButtonUrl, pageButton, rowOf, websiteButton } from '../components.ts';
import type { Ctx } from '../context.ts';
import { sourceSubtext } from '../layout.ts';
import { assertWithinLimits } from '../limits.ts';
import { STORES } from '../stores.ts';
import { defaultImmediateTemplate } from './defaults.ts';
import { limitValue } from './limit.ts';
import type { Block, Part, ParsedTemplate, RowLine, VarPart } from './parse.ts';
import { MESSAGE_VARIABLES, type FormName, type VarContext } from './vars.ts';

const SEPARATOR: DiscordSeparator = { type: 14, divider: true, spacing: 1 };

type Child = DiscordContainer['components'][number];

/** Detail given up at each degradation step, from nothing to the last one before the default template. */
const STEPS: readonly { cap: FormName; dropOptional: boolean }[] = [
  { cap: 'full', dropOptional: false },
  { cap: 'medium', dropOptional: false },
  { cap: 'short', dropOptional: false },
  { cap: 'short', dropOptional: true },
];

interface Tally {
  vars: number;
  filled: number;
  icon: boolean;
}

function renderVar(part: VarPart, vc: VarContext, tally: Tally): string {
  if (part.name === 'icon') {
    tally.icon = true;
    return '';
  }
  const def = MESSAGE_VARIABLES[part.name];
  if (def === undefined) {
    if (!part.name.endsWith('button') && part.name !== 'buttons') tally.vars += 1;
    return '';
  }
  tally.vars += 1;
  if (def.optional && vc.dropOptional) return '';
  const form = part.forms.find((candidate) => def.forms?.includes(candidate));
  const value = limitValue(def.value(vc, form), part.chars, part.lines);
  if (value !== '') tally.filled += 1;
  return value;
}

function renderParts(parts: readonly Part[], vc: VarContext, tally: Tally): string {
  let out = '';
  for (const part of parts) {
    if (part.t === 'text') {
      out += part.text;
    } else if (part.t === 'var') {
      out += renderVar(part, vc, tally);
    } else {
      const inner: Tally = { vars: 0, filled: 0, icon: false };
      const text = renderParts(part.parts, vc, inner);
      tally.vars += inner.vars;
      tally.filled += inner.filled;
      tally.icon ||= inner.icon;
      if (inner.vars === 0 || inner.filled > 0) out += text;
    }
  }
  return out;
}

function rowFor(line: RowLine, vc: VarContext): DiscordActionRow | null {
  const { event, ctx } = vc;
  const optional = ctx.optionalButtons && !vc.dropOptional;
  const buttons = line.buttons.flatMap((name) => {
    switch (name) {
      case 'buttons':
        return optional ? [pageButton(event, ctx), downloadButton(event, ctx), websiteButton(event, ctx)] : [pageButton(event, ctx)];
      case 'page_button':
        return [pageButton(event, ctx)];
      case 'download_button':
        return optional ? [downloadButton(event, ctx)] : [];
      case 'website_button':
        return optional ? [websiteButton(event, ctx)] : [];
      default:
        return [];
    }
  });
  return rowOf(buttons);
}

interface RenderedLine {
  text: string;
  vars: number;
  filled: number;
}

interface BlockState {
  iconUsed: boolean;
}

function buildBlock(block: Block, vc: VarContext, state: BlockState): Child[] {
  const out: Child[] = [];
  let pending: RenderedLine[] = [];
  let wantsIcon = false;
  let vars = 0;
  let filled = 0;

  const flushText = (): void => {
    const lines = pending.filter((line) => line.vars === 0 || line.filled > 0);
    vars += pending.reduce((sum, line) => sum + line.vars, 0);
    filled += pending.reduce((sum, line) => sum + line.filled, 0);
    pending = [];
    while (lines.length > 0 && lines[0]!.text.trim() === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1]!.text.trim() === '') lines.pop();
    const icon = wantsIcon && !state.iconUsed ? linkButtonUrl(vc.event.pkg.iconUrl) : null;
    wantsIcon = false;
    if (lines.length === 0) return;
    const text = { type: 10 as const, content: lines.map((line) => line.text).join('\n') };
    if (icon === null) {
      out.push(text);
    } else {
      state.iconUsed = true;
      out.push({ type: 9, components: [text], accessory: { type: 11, media: { url: icon } } });
    }
  };

  for (const line of block.lines) {
    if (line.kind === 'row') {
      flushText();
      vars += 1;
      const row = rowFor(line, vc);
      if (row !== null) {
        filled += 1;
        out.push(row);
      }
      continue;
    }
    const tally: Tally = { vars: 0, filled: 0, icon: false };
    const text = renderParts(line.parts, vc, tally);
    if (tally.icon) wantsIcon = true;
    if (tally.icon && tally.vars === 0 && text.trim() === '') continue;
    pending.push({ text, vars: tally.vars, filled: tally.filled });
  }
  flushText();
  return vars > 0 && filled === 0 ? [] : out;
}

/** One message from a parsed template at one degradation step; null when nothing is left to show. */
export function assemble(template: ParsedTemplate, event: ModEvent, now: Date, ctx: Ctx, step: { cap: FormName; dropOptional: boolean }): DiscordMessage | null {
  const vc: VarContext = { event, now, ctx, cap: step.cap, dropOptional: step.dropOptional };
  const state: BlockState = { iconUsed: false };
  const children: Child[] = [];
  for (const block of template.blocks) {
    const built = buildBlock(block, vc, state);
    if (built.length === 0) continue;
    if (children.length > 0) children.push({ ...SEPARATOR });
    children.push(...built);
  }
  if (children.length === 0) return null;
  return {
    flags: DISCORD.componentsV2Flag,
    allowed_mentions: { parse: [] },
    components: [{ type: 17, accent_color: STORES[event.pkg.store].color, components: children }, sourceSubtext(ctx.ratatoskrEmoji)],
  };
}

export interface RenderResult {
  message: DiscordMessage;
  /** Index of the degradation step that fitted; 0 is the template as written. */
  step: number;
  /** True when the template could not be used and the default one rendered the message. */
  fellBack: boolean;
}

/**
 * Renders the message of an event. A custom template goes down the degradation steps until the result fits Discord's
 * limits; if none fits, or it shows nothing, the default template renders the message.
 */
export function renderEvent(template: ParsedTemplate | null, event: ModEvent, now: Date, ctx: Ctx): RenderResult {
  if (template !== null) {
    for (const [step, detail] of STEPS.entries()) {
      const message = assemble(template, event, now, ctx, detail);
      if (message !== null && assertWithinLimits(message).length === 0) return { message, step, fellBack: false };
    }
  }
  const message = assemble(defaultImmediateTemplate(ctx.messages), event, now, ctx, STEPS[0]!);
  if (message === null) throw new Error('render: the default template shows nothing');
  return { message, step: 0, fellBack: template !== null };
}
