// SPDX-License-Identifier: AGPL-3.0-or-later
import { ALSO_MATCH_MAX_RULES, DISCORD, EXCLUDE_LIST_MAX, SUBSCRIBE_TEXT_OPTION_MAX } from '../../core/constants.ts';
import { addRule, describeBaseAcceptsEverything, removeRule } from '../../core/filter.ts';
import type { FilterRule, Subscription, SubscriptionFilter } from '../../core/types.ts';
import { validateSubscriptionFilter } from '../../core/validation.ts';
import type { Messages } from '../../i18n/index.ts';
import { stripUnsafeChars, truncate } from '../../text/sanitize.ts';
import { requireManageChannel } from '../permissions.ts';
import { parseOptions, type CommandOptions } from '../options.ts';
import { reply, type InteractionResponse } from '../responses.ts';
import type { HandlerContext, InteractionHandler } from '../router.ts';
import { resolveTarget } from '../target.ts';
import type { Interaction } from '../types.ts';
import type { CommandDeps } from './deps.ts';
import { deferWork } from './defer-work.ts';
import { createSubscribeAutocomplete } from './subscribe.ts';
import { createUnsubscribeAutocomplete, pickSubscription } from './unsubscribe.ts';
import { display, subscriptionName, subscriptionsHere, summarizeFilter } from './view.ts';

function guard(interaction: Interaction, messages: Messages): InteractionResponse | null {
  const denied = requireManageChannel(interaction, messages);
  if (denied) return denied;
  const target = resolveTarget(interaction);
  if (!target.ok) return reply({ content: target.reason === 'dm' ? messages.guildOnly : messages.unsupportedChannel }, { ephemeral: true });
  return null;
}

const clean = (value: string | undefined): string | undefined => {
  const text = value === undefined ? '' : stripUnsafeChars(value).replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text.slice(0, SUBSCRIBE_TEXT_OPTION_MAX);
};

const ephemeral = (content: string): InteractionResponse => reply({ content }, { ephemeral: true });

/** The ids of the configured sources of one store; null when the deployment does not poll it. */
function sourcesOf(deps: CommandDeps, store: string): string[] | null {
  const ids = deps.sources.filter((source) => source.enabled && source.store === store).map((source) => source.id);
  return ids.length === 0 ? null : ids;
}

async function modExists(deps: CommandDeps, mod: string, sources: readonly string[] | undefined): Promise<boolean> {
  return deps.store.packageExists(mod, [...(sources ?? deps.sources.map((source) => source.id))]);
}

/** The subscription of the place the command was run in, by id or exact label. */
async function subscriptionOf(deps: CommandDeps, interaction: Interaction, chosen: string | undefined): Promise<Subscription | undefined> {
  if (chosen === undefined || chosen.trim() === '') return undefined;
  return pickSubscription((await subscriptionsHere(deps.store, interaction)) ?? [], chosen);
}

/** Stores the new filter after validating it; the message to show instead when it is not valid. */
async function save(deps: CommandDeps, sub: Subscription, filter: SubscriptionFilter, messages: Messages): Promise<string | null> {
  const validated = validateSubscriptionFilter(filter);
  if (!validated.ok) return messages.invalidOptions(display(validated.errors.join('; ').slice(0, 300)));
  await deps.store.updateSubscription(sub.id, { filter: validated.filter });
  return null;
}

function view(sub: Subscription, filter: SubscriptionFilter, messages: Messages): string {
  const lines = [`**${messages.filterShowTitle(display(subscriptionName(sub)))}**`, messages.filterShowMatches(summarizeFilter(filter, messages))];
  const rules = filter.alsoMatch ?? [];
  if (rules.length > 0) {
    lines.push(messages.filterShowRulesTitle);
    rules.forEach((rule, i) => lines.push(`${i + 1}. ${summarizeFilter(rule, messages)}`));
  }
  const excluded = [...(filter.excludePackages ?? []), ...(filter.excludeCategories ?? [])];
  if (excluded.length > 0) lines.push(messages.filterShowExcluded(display(truncate(excluded.join(', '), 200))));
  lines.push(messages.filterShowFlags(filter.allowNsfw === true ? messages.yes : messages.no, filter.includeChangelog === false ? messages.no : messages.yes));
  return truncate(lines.join('\n'), DISCORD.contentMax - 100);
}

function ruleOf(options: CommandOptions, deps: CommandDeps, messages: Messages): { ok: true; rule: FilterRule; mod?: string } | { ok: false; message: string } {
  const owner = clean(options.string('owner'));
  const mod = clean(options.string('mod'));
  const category = clean(options.string('category'));
  const store = options.string('source');
  if (owner !== undefined && mod !== undefined) return { ok: false, message: messages.subscribeOwnerAndMod };
  const rule: FilterRule = {};
  const entry = owner ?? mod;
  if (entry !== undefined) rule.packages = [entry];
  if (category !== undefined) rule.includeCategories = [category];
  if (store !== undefined) {
    const sources = sourcesOf(deps, store);
    if (sources === null) return { ok: false, message: messages.sourceNotConfigured(display(store.slice(0, SUBSCRIBE_TEXT_OPTION_MAX))) };
    rule.sources = sources;
  }
  if (rule.packages === undefined && rule.includeCategories === undefined && rule.sources === undefined) return { ok: false, message: messages.includeNeedsOption };
  const validated = validateSubscriptionFilter({ alsoMatch: [rule] });
  if (!validated.ok) return { ok: false, message: messages.invalidOptions(display(validated.errors.join('; ').slice(0, 300))) };
  return { ok: true, rule, ...(mod === undefined ? {} : { mod }) };
}

export function createIncludeCommand(deps: CommandDeps): InteractionHandler {
  return (interaction, ctx): InteractionResponse => {
    const { messages } = ctx;
    const refused = guard(interaction, messages);
    if (refused) return refused;
    const options = parseOptions(interaction);
    const built = ruleOf(options, deps, messages);
    if (!built.ok) return ephemeral(built.message);
    const chosen = options.string('subscription');
    return deferWork(interaction, ctx, async () => {
      const sub = await subscriptionOf(deps, interaction, chosen);
      if (sub === undefined) return { content: messages.subscriptionNotFound };
      const name = display(subscriptionName(sub));
      if (describeBaseAcceptsEverything(sub.filter)) return { content: messages.includeNothingToWiden };
      if (built.mod !== undefined && !(await modExists(deps, built.mod, built.rule.sources))) return { content: messages.modNotFound(display(built.mod)) };
      const widened = addRule(sub.filter, built.rule);
      if (widened === null) return { content: messages.includeLimit(ALSO_MATCH_MAX_RULES) };
      if (widened.alsoMatch?.length === sub.filter.alsoMatch?.length) return { content: messages.includeDuplicate(name) };
      const failed = await save(deps, sub, widened, messages);
      return { content: failed ?? messages.included(name, summarizeFilter(built.rule, messages)) };
    });
  };
}

function appendUnique(list: readonly string[] | undefined, entry: string): { list: string[]; added: boolean } {
  const current = list ?? [];
  if (current.some((existing) => existing.toLowerCase() === entry.toLowerCase())) return { list: [...current], added: false };
  return { list: [...current, entry], added: true };
}

export function createExcludeCommand(deps: CommandDeps): InteractionHandler {
  return (interaction, ctx): InteractionResponse => {
    const { messages } = ctx;
    const refused = guard(interaction, messages);
    if (refused) return refused;
    const options = parseOptions(interaction);
    const owner = clean(options.string('owner'));
    const mod = clean(options.string('mod'));
    const category = clean(options.string('category'));
    if (owner === undefined && mod === undefined && category === undefined) return ephemeral(messages.excludeNeedsOption);
    const chosen = options.string('subscription');
    return deferWork(interaction, ctx, async () => {
      const sub = await subscriptionOf(deps, interaction, chosen);
      if (sub === undefined) return { content: messages.subscriptionNotFound };
      const name = display(subscriptionName(sub));
      if (mod !== undefined && !(await modExists(deps, mod, undefined))) return { content: messages.modNotFound(display(mod)) };
      const filter: SubscriptionFilter = { ...sub.filter };
      const added: string[] = [];
      for (const entry of [owner, mod]) {
        if (entry === undefined) continue;
        const next = appendUnique(filter.excludePackages, entry);
        filter.excludePackages = next.list;
        if (next.added) added.push(entry);
      }
      if (category !== undefined) {
        const next = appendUnique(filter.excludeCategories, category);
        filter.excludeCategories = next.list;
        if (next.added) added.push(category);
      }
      if (added.length === 0) return { content: messages.excludeAlready(name) };
      if ((filter.excludePackages?.length ?? 0) > EXCLUDE_LIST_MAX || (filter.excludeCategories?.length ?? 0) > EXCLUDE_LIST_MAX) return { content: messages.excludeLimit(EXCLUDE_LIST_MAX) };
      const failed = await save(deps, sub, filter, messages);
      return { content: failed ?? messages.excluded(name, display(truncate(added.join(', '), 200))) };
    });
  };
}

const LIST_KEYS = ['packages', 'excludePackages', 'includeCategories', 'excludeCategories'] as const;

/** Removes `entry` (case-insensitive) from every list that holds it; null when no list does. */
function withoutEntry(filter: SubscriptionFilter, entry: string): SubscriptionFilter | null {
  const next: SubscriptionFilter = { ...filter };
  let found = false;
  for (const key of LIST_KEYS) {
    const list = next[key];
    if (list === undefined) continue;
    const kept = list.filter((item) => item.toLowerCase() !== entry.toLowerCase());
    if (kept.length === list.length) continue;
    found = true;
    if (kept.length === 0) delete next[key];
    else next[key] = kept;
  }
  return found ? next : null;
}

interface Change {
  kind?: string;
  source?: string;
  nsfw?: boolean;
  changelog?: boolean;
  removeRule?: number;
  remove?: string;
}

function changeOf(options: CommandOptions): Change {
  const remove = clean(options.string('remove'));
  const change: Change = {};
  const kind = options.string('kind');
  const source = options.string('source');
  const nsfw = options.boolean('nsfw');
  const changelog = options.boolean('changelog');
  const removeRuleNumber = options.integer('remove_rule');
  if (kind !== undefined) change.kind = kind;
  if (source !== undefined) change.source = source;
  if (nsfw !== undefined) change.nsfw = nsfw;
  if (changelog !== undefined) change.changelog = changelog;
  if (removeRuleNumber !== undefined) change.removeRule = removeRuleNumber;
  if (remove !== undefined) change.remove = remove;
  return change;
}

/** The filter with the change applied, or the message that says why it cannot be. */
function applyChange(deps: CommandDeps, filter: SubscriptionFilter, change: Change, messages: Messages): { ok: true; filter: SubscriptionFilter } | { ok: false; message: string } {
  let next: SubscriptionFilter = { ...filter };
  if (change.removeRule !== undefined) {
    const removed = removeRule(next, change.removeRule - 1);
    if (removed === null) return { ok: false, message: messages.filterRuleNotFound(change.removeRule) };
    next = removed;
  }
  if (change.remove !== undefined) {
    const removed = withoutEntry(next, change.remove);
    if (removed === null) return { ok: false, message: messages.filterEntryNotFound(display(change.remove)) };
    next = removed;
  }
  if (change.kind === 'new' || change.kind === 'update') next.kinds = [change.kind];
  else if (change.kind === 'both') delete next.kinds;
  if (change.source === 'all') delete next.sources;
  else if (change.source !== undefined) {
    const sources = sourcesOf(deps, change.source);
    if (sources === null) return { ok: false, message: messages.sourceNotConfigured(display(change.source.slice(0, SUBSCRIBE_TEXT_OPTION_MAX))) };
    next.sources = sources;
  }
  if (change.nsfw === true) next.allowNsfw = true;
  else if (change.nsfw === false) delete next.allowNsfw;
  if (change.changelog === false) next.includeChangelog = false;
  else if (change.changelog === true) delete next.includeChangelog;
  return { ok: true, filter: next };
}

export function createFilterCommand(deps: CommandDeps): InteractionHandler {
  return (interaction, ctx): InteractionResponse => {
    const { messages } = ctx;
    const refused = guard(interaction, messages);
    if (refused) return refused;
    const options = parseOptions(interaction);
    const change = changeOf(options);
    const chosen = options.string('subscription');
    const changing = Object.keys(change).length > 0;
    if (change.source !== undefined && change.source !== 'all' && sourcesOf(deps, change.source) === null) {
      return ephemeral(messages.sourceNotConfigured(display(change.source.slice(0, SUBSCRIBE_TEXT_OPTION_MAX))));
    }
    return deferWork(interaction, ctx, async () => {
      const sub = await subscriptionOf(deps, interaction, chosen);
      if (sub === undefined) return { content: messages.subscriptionNotFound };
      if (!changing) return { content: view(sub, sub.filter, messages) };
      const applied = applyChange(deps, sub.filter, change, messages);
      if (!applied.ok) return { content: applied.message };
      const failed = await save(deps, sub, applied.filter, messages);
      return { content: failed ?? `${messages.filterChanged(display(subscriptionName(sub)))}\n${view(sub, applied.filter, messages)}` };
    });
  };
}

/** Subscription names for the `subscription` option; owners and mods for the others. */
export function createFilterAutocomplete(deps: CommandDeps): InteractionHandler {
  const subscriptions = createUnsubscribeAutocomplete(deps);
  const mods = createSubscribeAutocomplete(deps);
  return (interaction: Interaction, ctx: HandlerContext) => (parseOptions(interaction).focused?.name === 'subscription' ? subscriptions(interaction, ctx) : mods(interaction, ctx));
}
