// SPDX-License-Identifier: AGPL-3.0-or-later
import { CHANGELOG_DISPLAY_MAX, CHANGELOG_EXCERPT_MAX } from '../../core/constants.ts';
import type { ModEvent } from '../../core/types.ts';
import { safeUrl, formatBytes, formatCount, wholeCount } from '../text.ts';
import type { Ctx } from '../context.ts';
import {
  alsoOnLine,
  categoriesValue,
  changelogExcerpt,
  descriptionExcerpt,
  infoLine,
  kindLabel,
  kindLine,
  relativeTimestamp,
  titleLine,
  versionFrom,
  versionsText,
  versionTo,
} from '../detailed.ts';
import { CAPS, KIND_EMOJI } from '../layout.ts';
import { STORES } from '../stores.ts';
import { inline, inlineTitle, mdLink } from '../text.ts';

/** How much of a long value a form shows; `cap` lowers every form to at most this one. */
export type FormName = 'short' | 'medium' | 'full';

export const FORM_RANK: Record<FormName, number> = { short: 0, medium: 1, full: 2 };

/** Renderer-internal caps of the sized forms (design choices, not upstream limits). */
const CHANGELOG_FORM_MAX: Record<FormName, number> = { short: 150, medium: CHANGELOG_DISPLAY_MAX, full: CHANGELOG_EXCERPT_MAX };
const DESCRIPTION_FORM_MAX: Record<FormName, number> = { short: 120, medium: CAPS.excerpt, full: 1000 };

export interface VarContext {
  event: ModEvent;
  now: Date;
  ctx: Ctx;
  /** Largest form a sized variable may use at the current degradation step. */
  cap: FormName;
  /** Optional variables render empty at the last degradation step. */
  dropOptional: boolean;
}

export interface VarDef {
  /** Forms the variable understands; any other word is ignored. */
  forms?: readonly string[];
  defaultForm?: string;
  /** Dropped when the message has to give up detail. */
  optional?: boolean;
  value(c: VarContext, form: string | undefined): string;
}

const isFormName = (form: string | undefined): form is FormName => form === 'short' || form === 'medium' || form === 'full';

/** The sized form to use: the requested one, never larger than the cap of the degradation step. */
export function effectiveForm(form: string | undefined, fallback: FormName, cap: FormName): FormName {
  const wanted = isFormName(form) ? form : fallback;
  return FORM_RANK[wanted] > FORM_RANK[cap] ? cap : wanted;
}

const url = (raw: string | null | undefined): string => safeUrl(raw) ?? '';

function nameValue(event: ModEvent, ctx: Ctx, form: string | undefined): string {
  const text = inlineTitle(event.pkg.name, CAPS.name) || ctx.messages.unnamed;
  const link = safeUrl(event.pkg.url);
  return form === 'link' && link ? mdLink(text, link) : text;
}

function downloadsValue({ event, ctx }: VarContext): string {
  const count = event.kind === 'new' ? null : wholeCount(event.pkg.downloads);
  return count === null ? '' : ctx.messages.downloaded(count, formatCount(count, ctx.messages.thousandsSeparator)!);
}

function likesValue({ event, ctx }: VarContext): string {
  const count = wholeCount(event.pkg.likes);
  return count === null || count <= 0 ? '' : ctx.messages.likes(count, formatCount(count, ctx.messages.thousandsSeparator)!);
}

/** Every variable of a message template; `icon` and the buttons are handled by the builder, not here. */
export const MESSAGE_VARIABLES: Readonly<Record<string, VarDef>> = {
  name: { forms: ['link', 'plain'], value: ({ event, ctx }, form) => nameValue(event, ctx, form) },
  title: { value: ({ event, ctx }) => titleLine(event, ctx.storeEmojis[event.pkg.store] ?? '', ctx.messages.unnamed) },
  owner: { value: ({ event }) => inline(event.pkg.owner, CAPS.owner) },
  store: { value: ({ event }) => STORES[event.pkg.store].label },
  store_emoji: { value: ({ event, ctx }) => ctx.storeEmojis[event.pkg.store] ?? '' },
  kind_emoji: { value: ({ event }) => KIND_EMOJI[event.kind] },
  version: { value: ({ event }) => versionTo(event) },
  version_from: { value: ({ event }) => versionFrom(event) },
  versions: { value: ({ event }) => versionsText(event) },
  kind: { value: ({ event, ctx }) => kindLabel(event, ctx) },
  kind_line: { value: ({ event, ctx, now }) => kindLine(event, ctx, now) },
  time: { value: ({ event, now }) => relativeTimestamp(event, now) ?? '' },
  size: { value: ({ event, ctx }) => formatBytes(event.pkg.sizeBytes, ctx.messages.byteUnits, ctx.messages.decimalSeparator) ?? '' },
  downloads: { value: downloadsValue },
  likes: { value: likesValue },
  info_line: { value: ({ event, ctx }) => infoLine(event, ctx) ?? '' },
  also_on: { optional: true, value: ({ event, ctx }) => alsoOnLine(event, ctx) ?? '' },
  description: {
    forms: ['short', 'medium', 'full'],
    defaultForm: 'medium',
    optional: true,
    value: (c, form) => descriptionExcerpt(c.event, DESCRIPTION_FORM_MAX[effectiveForm(form, 'medium', c.cap)]),
  },
  changelog: {
    forms: ['short', 'medium', 'full'],
    defaultForm: 'medium',
    optional: true,
    value: (c, form) => changelogExcerpt(c.event, c.ctx, CHANGELOG_FORM_MAX[effectiveForm(form, 'medium', c.cap)]) ?? '',
  },
  changelog_url: { value: ({ event }) => url(event.changelogUrl) },
  url: { value: ({ event }) => url(event.pkg.url) },
  download_url: { value: ({ event }) => url(event.pkg.downloadUrl) },
  website_url: { value: ({ event }) => url(event.pkg.websiteUrl) },
  categories: { optional: true, value: ({ event }) => (Array.isArray(event.pkg.categories) ? categoriesValue(event.pkg.categories) : null) ?? '' },
};

/** Variables that are not text: the thumbnail marker and the buttons. */
export const DIRECTIVE_VARIABLES: readonly string[] = ['icon', 'buttons', 'page_button', 'download_button', 'website_button', 'info_button'];
