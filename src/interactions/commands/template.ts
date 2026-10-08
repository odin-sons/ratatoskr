// SPDX-License-Identifier: AGPL-3.0-or-later
import { TEMPLATE_MAX_CHARS } from '../../core/constants.ts';
import type { ModEvent, SourceId, TemplateKind } from '../../core/types.ts';
import { SUBSCRIPTION_ID_RE } from '../../core/validation.ts';
import type { Messages } from '../../i18n/index.ts';
import { prepare } from '../../render/compact.ts';
import { makeCtx, type Ctx } from '../../render/context.ts';
import { resolveRatatoskrEmoji, resolveStoreEmojis } from '../../render/emoji.ts';
import { analyzeTemplate, type TemplateWarning } from '../../render/template/analyze.ts';
import { renderEvent } from '../../render/template/build.ts';
import { DEFAULT_DIGEST_LINE_SOURCE, defaultImmediateSource } from '../../render/template/defaults.ts';
import { renderLine } from '../../render/template/line.ts';
import { parseTemplate, type ParsedTemplate } from '../../render/template/parse.ts';
import { sampleEvent } from '../../render/template/sample.ts';
import { truncate } from '../../text/sanitize.ts';
import { MESSAGE_FLAG_V2 } from '../constants.ts';
import { parseOptions } from '../options.ts';
import { modal, reply, type InteractionMessage, type InteractionResponse } from '../responses.ts';
import type { HandlerContext, InteractionHandler } from '../router.ts';
import type { Interaction } from '../types.ts';
import type { CommandDeps } from './deps.ts';
import { guard, subscriptionOf } from './filter-edit.ts';
import { modEventFor } from './info.ts';
import { display, subscriptionName } from './view.ts';

export const TEMPLATE_MODAL_PREFIX = 'template';
const BODY_FIELD = 'body';
const NOTES_MAX = 1200;
const SHOW_MAX = 1700;

const ephemeral = (content: string): InteractionResponse => reply({ content }, { ephemeral: true });

const kindOf = (target: string | undefined): TemplateKind => (target === 'digest_line' ? 'digest_line' : 'immediate');
const kindName = (kind: TemplateKind, messages: Messages): string => (kind === 'digest_line' ? messages.templateKindDigestLine : messages.templateKindMessage);
const defaultSource = (kind: TemplateKind, messages: Messages): string => (kind === 'digest_line' ? DEFAULT_DIGEST_LINE_SOURCE : defaultImmediateSource(messages));
const enabledSources = (deps: CommandDeps): SourceId[] => deps.sources.filter((source) => source.enabled).map((source) => source.id);

function warningText(warning: TemplateWarning, messages: Messages): string {
  switch (warning.code) {
    case 'unknown_variable':
      return messages.warnUnknownVariable(display(warning.name));
    case 'unavailable_in_line':
      return messages.warnUnavailableInLine(display(warning.name));
    case 'ignored_form':
      return messages.warnIgnoredForm(display(warning.name), display(warning.form));
    case 'no_mod_link':
      return messages.warnNoModLink;
    case 'too_many_variables':
      return messages.warnTooManyVariables;
  }
}

function ctxFor(deps: CommandDeps, messages: Messages, template: ParsedTemplate | null): Ctx {
  return {
    ...makeCtx({}),
    messages,
    storeEmojis: resolveStoreEmojis(deps.storeEmojis),
    ratatoskrEmoji: resolveRatatoskrEmoji(deps.ratatoskrEmoji),
    infoButton: true,
    immediateTemplate: template,
  };
}

/** The ephemeral preview: the notes about the template, then the message or the line as it would be sent. */
async function previewMessage(deps: CommandDeps, messages: Messages, name: string, kind: TemplateKind, body: string | null, modId?: string): Promise<InteractionMessage> {
  const parsed = body === null ? null : parseTemplate(body);
  const notes = parsed === null ? [] : analyzeTemplate(parsed, kind).map((warning) => warningText(warning, messages));
  const event: ModEvent = (modId === undefined ? null : await modEventFor(deps, modId, enabledSources(deps))) ?? sampleEvent(deps.now());
  const kindLabel = kindName(kind, messages);
  let shown: unknown[];
  if (kind === 'immediate') {
    const ctx = ctxFor(deps, messages, parsed);
    const result = renderEvent(ctx.immediateTemplate, event, deps.now(), ctx);
    if (result.step > 0) notes.push(messages.warnShortened(result.step));
    if (result.fellBack) notes.push(messages.warnFellBack);
    shown = result.message.components ?? [];
  } else {
    const line = renderLine(parsed, prepare(event, messages), { storeEmojis: resolveStoreEmojis(deps.storeEmojis) });
    shown = [{ type: 10, content: truncate(line, 1900) }];
  }
  const status = `**${messages.templatePreviewOf(display(name), kindLabel)}**\n${notes.length === 0 ? messages.templateNoNotes : `${messages.templateNotes}\n${truncate(notes.map((note) => `- ${note}`).join('\n'), NOTES_MAX)}`}`;
  return { flags: MESSAGE_FLAG_V2, components: [{ type: 10, content: status }, ...shown] };
}

/** The template text as a code block that its own backticks cannot close. */
const codeBlock = (text: string): string => `\`\`\`\n${truncate(text, SHOW_MAX).replaceAll('```', '`​``')}\n\`\`\``;

export function createTemplateCommand(deps: CommandDeps): InteractionHandler {
  return async (interaction: Interaction, ctx: HandlerContext): Promise<InteractionResponse> => {
    const { messages } = ctx;
    const refused = guard(interaction, messages);
    if (refused) return refused;
    const options = parseOptions(interaction);
    const sub = await subscriptionOf(deps, interaction, options.string('subscription'));
    if (sub === undefined) return ephemeral(messages.subscriptionNotFound);
    const kind = kindOf(options.string('target'));
    const name = display(subscriptionName(sub));
    const kindLabel = kindName(kind, messages);
    const current = (await deps.store.getTemplates([sub.id])).find((template) => template.kind === kind);

    switch (options.string('action')) {
      case 'edit':
        return modal(`${TEMPLATE_MODAL_PREFIX}:${sub.id}:${kind}`, messages.templateModalTitle(kindLabel), [
          { customId: BODY_FIELD, label: messages.templateModalLabel, value: current?.body ?? defaultSource(kind, messages), minLength: 1, maxLength: TEMPLATE_MAX_CHARS, required: true },
        ]);
      case 'show':
        return ephemeral(
          `${current === undefined ? messages.templateShowDefault(name, kindLabel) : messages.templateShowCurrent(name, kindLabel)}\n${codeBlock(current?.body ?? defaultSource(kind, messages))}`,
        );
      case 'reset':
        return ephemeral(
          (await deps.store.deleteTemplate(sub.id, kind)) ? messages.templateReset(name, kindLabel) : messages.templateNothingToReset(name, kindLabel),
        );
      case 'preview':
        return reply(await previewMessage(deps, messages, subscriptionName(sub), kind, current?.body ?? null, options.string('mod')), { ephemeral: true });
      default:
        return ephemeral(messages.unknownCommand);
    }
  };
}

/** The submit of the edit modal: saves the template whatever the notes say, and shows how it looks. */
export function createTemplateModal(deps: CommandDeps): InteractionHandler {
  return async (interaction: Interaction, ctx: HandlerContext): Promise<InteractionResponse> => {
    const { messages } = ctx;
    const refused = guard(interaction, messages);
    if (refused) return refused;
    const [, id, kindText] = (interaction.data?.custom_id ?? '').split(':');
    if (id === undefined || !SUBSCRIPTION_ID_RE.test(id) || (kindText !== 'immediate' && kindText !== 'digest_line')) return ephemeral(messages.unknownCommand);
    const kind: TemplateKind = kindText;
    const sub = await subscriptionOf(deps, interaction, id);
    if (sub === undefined || sub.id !== id) return ephemeral(messages.subscriptionNotFound);
    const body = interaction.data?.fields?.[BODY_FIELD];
    if (body === undefined || parseTemplate(body).blocks.length === 0) return ephemeral(messages.templateEmptyBody);
    if (body.length > TEMPLATE_MAX_CHARS) return ephemeral(messages.templateTooLong(TEMPLATE_MAX_CHARS));
    await deps.store.setTemplate({ subscriptionId: sub.id, kind, body, updatedAt: deps.now().toISOString() });
    const preview = await previewMessage(deps, messages, subscriptionName(sub), kind, body);
    const saved = { type: 10, content: messages.templateSaved(display(subscriptionName(sub)), kindName(kind, messages)) };
    return reply({ ...preview, components: [saved, ...(preview.components ?? [])] }, { ephemeral: true });
  };
}
