// SPDX-License-Identifier: AGPL-3.0-or-later
import { LINE_VARIABLES } from './line.ts';
import type { ParsedTemplate, Part, VarPart } from './parse.ts';
import { DIRECTIVE_VARIABLES, MESSAGE_VARIABLES } from './vars.ts';

export type TemplateKind = 'immediate' | 'digest_line';

/** What is probably unintended in a template. None of it stops a template from being saved or used. */
export type TemplateWarning =
  | { code: 'unknown_variable'; name: string }
  | { code: 'unavailable_in_line'; name: string }
  | { code: 'ignored_form'; name: string; form: string }
  | { code: 'no_mod_link' }
  | { code: 'too_many_variables' };

const LINK_VARIABLES = new Set(['url', 'title', 'page_button', 'buttons']);

function variablesOf(parts: readonly Part[], out: VarPart[]): void {
  for (const part of parts) {
    if (part.t === 'var') out.push(part);
    else if (part.t === 'opt') variablesOf(part.parts, out);
  }
}

function hasLink(variable: VarPart): boolean {
  return LINK_VARIABLES.has(variable.name) || (variable.name === 'name' && variable.forms.includes('link'));
}

/** Lists what is likely a mistake in a parsed template, each finding once. */
export function analyzeTemplate(template: ParsedTemplate, kind: TemplateKind): TemplateWarning[] {
  const variables: VarPart[] = [];
  for (const block of template.blocks) {
    for (const line of block.lines) {
      if (line.kind === 'text') variablesOf(line.parts, variables);
      else for (const name of line.buttons) variables.push({ t: 'var', name, forms: [] });
    }
  }
  const warnings: TemplateWarning[] = [];
  const seen = new Set<string>();
  const add = (warning: TemplateWarning): void => {
    const key = JSON.stringify(warning);
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push(warning);
  };
  for (const warning of template.warnings) add(warning);
  let linked = false;
  for (const variable of variables) {
    const inMessage = variable.name in MESSAGE_VARIABLES || DIRECTIVE_VARIABLES.includes(variable.name);
    const inLine = variable.name in LINE_VARIABLES;
    if (kind === 'digest_line' ? !inLine : !inMessage) {
      add(kind === 'digest_line' && inMessage ? { code: 'unavailable_in_line', name: variable.name } : { code: 'unknown_variable', name: variable.name });
      continue;
    }
    const known = (kind === 'digest_line' ? LINE_VARIABLES[variable.name]?.forms : MESSAGE_VARIABLES[variable.name]?.forms) ?? [];
    for (const form of variable.forms) if (!known.includes(form)) add({ code: 'ignored_form', name: variable.name, form });
    if (hasLink(variable)) linked = true;
  }
  if (!linked && variables.length > 0) add({ code: 'no_mod_link' });
  return warnings;
}
