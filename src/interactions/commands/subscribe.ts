// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DEFAULT_DIGEST_INTERVAL_MIN,
  MAX_SUBSCRIPTIONS_PER_CHANNEL,
  MAX_SUBSCRIPTIONS_PER_GUILD,
  MAX_SUBSCRIPTIONS_TOTAL,
  SUBSCRIBE_TEXT_OPTION_MAX,
  SUBSCRIPTION_LABEL_MAX,
} from '../../core/constants.ts';
import type { DeliveryMode, Subscription, SubscriptionFilter } from '../../core/types.ts';
import {
  DELIVERY_MODES,
  DIGEST_INTERVAL_MAX_BOUND,
  DIGEST_INTERVAL_MIN_BOUND,
  isDigestInterval,
  SUBSCRIPTION_ID_RE,
  validateSubscriptionFilter,
} from '../../core/validation.ts';
import type { Messages } from '../../i18n/index.ts';
import { stripUnsafeChars } from '../../text/sanitize.ts';
import { SUBSCRIBE_BOT_PERMISSIONS } from '../constants.ts';
import { checkBotPermissions, hasManageChannel, requireManageChannel } from '../permissions.ts';
import { parseOptions, type CommandOptions } from '../options.ts';
import { autocomplete, reply, type InteractionResponse } from '../responses.ts';
import type { InteractionHandler } from '../router.ts';
import { resolveTarget } from '../target.ts';
import type { CommandDeps } from './deps.ts';
import { deferWork } from './defer-work.ts';
import { modChoices } from './mod-choices.ts';
import { describeDestination, describeMode, display, summarizeFilter } from './view.ts';

interface Plan {
  filter: SubscriptionFilter;
  mode: DeliveryMode;
  digestIntervalMin: number;
  label: string;
  threadPerMod: boolean;
  /** The package the `mod` option names, to be found in the store. */
  mod?: string;
}

const clean = (value: string | undefined): string | undefined => {
  const text = value === undefined ? '' : stripUnsafeChars(value).replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text;
};

/** Order-independent form of a filter, for telling identical subscriptions apart. */
export function canonicalFilter(filter: SubscriptionFilter): string {
  const entries = Object.entries(filter)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

function buildPlan(options: CommandOptions, deps: CommandDeps, messages: Messages): { ok: true; plan: Plan } | { ok: false; message: string } {
  const owner = clean(options.string('owner'));
  const mod = clean(options.string('mod'));
  const category = clean(options.string('category'));
  const store = options.string('source');
  const kind = options.string('kind');
  const problems: string[] = [];
  if (owner !== undefined && mod !== undefined) return { ok: false, message: messages.subscribeOwnerAndMod };

  for (const [name, text] of [['owner', owner], ['mod', mod], ['category', category]] as const) {
    if (text !== undefined && text.length > SUBSCRIBE_TEXT_OPTION_MAX) problems.push(`${name}: at most ${SUBSCRIBE_TEXT_OPTION_MAX} characters`);
  }

  const rawFilter: Record<string, unknown> = {};
  const packages = [owner, mod].filter((entry): entry is string => entry !== undefined);
  if (packages.length > 0) rawFilter.packages = packages;
  if (category !== undefined) rawFilter.includeCategories = [category];
  if (store !== undefined) {
    const sources = deps.sources.filter((source) => source.enabled && source.store === store).map((source) => source.id);
    if (sources.length === 0) return { ok: false, message: messages.sourceNotConfigured(display(store.slice(0, SUBSCRIBE_TEXT_OPTION_MAX))) };
    rawFilter.sources = sources;
  }
  if (kind === 'new' || kind === 'update') rawFilter.kinds = [kind];
  else if (kind !== undefined && kind !== 'both') problems.push('kind: must be new, update or both');

  if (packages.length === 0 && category === undefined && store === undefined) return { ok: false, message: messages.subscribeNeedsFilter };

  const modeText = options.string('mode') ?? 'digest';
  if (!(DELIVERY_MODES as readonly string[]).includes(modeText)) problems.push(`mode: must be one of ${DELIVERY_MODES.join(', ')}`);
  const mode = modeText as DeliveryMode;
  const threadPerMod = options.boolean('thread_per_mod') ?? false;
  const interval = options.integer('interval');
  if (problems.length === 0) {
    if (threadPerMod && mode === 'digest') return { ok: false, message: messages.subscribeThreadPerModDigest };
    if (interval !== undefined && mode === 'immediate') return { ok: false, message: messages.subscribeIntervalImmediate };
    if (interval !== undefined && !isDigestInterval(interval)) {
      problems.push(`interval: must be an integer between ${DIGEST_INTERVAL_MIN_BOUND} and ${DIGEST_INTERVAL_MAX_BOUND}`);
    }
  }

  const validated = validateSubscriptionFilter(rawFilter);
  if (!validated.ok) problems.push(...validated.errors);
  if (problems.length > 0 || !validated.ok) return { ok: false, message: messages.invalidOptions(display(problems.join('; ').slice(0, 300))) };

  const generated = [owner, mod, category, store].filter((part): part is string => part !== undefined).join(', ');
  const label = (clean(options.string('label')) ?? generated).slice(0, SUBSCRIPTION_LABEL_MAX);
  return { ok: true, plan: { filter: validated.filter, mode, digestIntervalMin: interval ?? DEFAULT_DIGEST_INTERVAL_MIN, label, threadPerMod, ...(mod === undefined ? {} : { mod }) } };
}

export function createSubscribeCommand(deps: CommandDeps): InteractionHandler {
  return (interaction, ctx): InteractionResponse => {
    const { messages } = ctx;
    const denied = requireManageChannel(interaction, messages);
    if (denied) return denied;
    const options = parseOptions(interaction);
    const plan = buildPlan(options, deps, messages);
    const target = resolveTarget(interaction, { threadPerMod: options.boolean('thread_per_mod') ?? false });
    if (!target.ok) return reply({ content: target.reason === 'dm' ? messages.guildOnly : messages.unsupportedChannel }, { ephemeral: true });
    const missing = checkBotPermissions(interaction, SUBSCRIBE_BOT_PERMISSIONS);
    if (missing.length > 0) return reply({ content: messages.botPermissionsMissing(missing.join(', ')) }, { ephemeral: true });
    if (!plan.ok) return reply({ content: plan.message }, { ephemeral: true });
    const guildId = interaction.guild_id;
    const userId = interaction.member?.user?.id;
    if (guildId === undefined || userId === undefined) return reply({ content: messages.somethingWrong }, { ephemeral: true });

    const subscription: Subscription = {
      id: deps.newId(),
      guildId,
      transport: 'bot',
      channelId: target.channelId,
      threadId: target.threadId ?? null,
      label: plan.plan.label,
      createdBy: userId,
      threadPerMod: plan.plan.threadPerMod,
      filter: plan.plan.filter,
      mode: plan.plan.mode,
      digestIntervalMin: plan.plan.digestIntervalMin,
      enabled: true,
    };
    return deferWork(interaction, ctx, async () => ({ content: await create(deps, subscription, messages, plan.plan.mod) }));
  };
}

async function create(deps: CommandDeps, subscription: Subscription, messages: Messages, mod: string | undefined): Promise<string> {
  if (!SUBSCRIPTION_ID_RE.test(subscription.id)) throw new Error('generated subscription id is malformed');
  const { store } = deps;
  if (mod !== undefined) {
    const sources = subscription.filter.sources ?? deps.sources.map((source) => source.id);
    if (!(await store.packageExists(mod, sources))) return messages.modNotFound(display(mod));
  }
  const [inChannel, inGuild, total] = await Promise.all([
    store.listSubscriptionsByChannel(subscription.channelId as string),
    store.listSubscriptionsByGuild(subscription.guildId),
    store.countSubscriptions(),
  ]);
  const wanted = canonicalFilter(subscription.filter);
  const duplicate = inChannel.some(
    (other) =>
      (other.threadId ?? null) === (subscription.threadId ?? null) &&
      (other.threadPerMod ?? false) === subscription.threadPerMod &&
      other.mode === subscription.mode &&
      canonicalFilter(other.filter) === wanted,
  );
  if (duplicate) return messages.subscribeDuplicate;
  if (inChannel.length >= MAX_SUBSCRIPTIONS_PER_CHANNEL) return messages.subscribeLimitChannel(MAX_SUBSCRIPTIONS_PER_CHANNEL);
  if (inGuild.length >= MAX_SUBSCRIPTIONS_PER_GUILD) return messages.subscribeLimitGuild(MAX_SUBSCRIPTIONS_PER_GUILD);
  if (total >= MAX_SUBSCRIPTIONS_TOTAL) return messages.subscribeLimitTotal(MAX_SUBSCRIPTIONS_TOTAL);
  await store.createSubscription(subscription);
  const mode = [describeMode(subscription, messages), ...(subscription.threadPerMod ? [messages.threadPerMod] : [])].join(', ');
  const details = `${mode} · ${summarizeFilter(subscription.filter, messages)}`;
  return `${messages.subscribed(display(subscription.label ?? subscription.id), describeDestination(subscription, messages), details)}
${messages.subscriptionId(`\`${subscription.id}\``)}`;
}

export function createSubscribeAutocomplete(deps: CommandDeps): InteractionHandler {
  return async (interaction): Promise<InteractionResponse> => {
    if (!hasManageChannel(interaction)) return autocomplete([]);
    const focused = parseOptions(interaction).focused;
    const prefix = focused?.value.trim() ?? '';
    if (focused?.name === 'owner') {
      return autocomplete((await deps.store.searchOwners(prefix)).map((owner) => ({ name: owner, value: owner })));
    }
    if (focused?.name === 'mod') {
      return autocomplete(await modChoices(deps.store, prefix));
    }
    return autocomplete([]);
  };
}
