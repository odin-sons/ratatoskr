// SPDX-License-Identifier: AGPL-3.0-or-later

/** `'<store>:<community>'`, e.g. `'thunderstore:valheim'`. */
export type SourceId = string;

export type StoreKind = 'thunderstore' | 'hexium' | 'nexus';

export type EventKind = 'new' | 'update';

/** One package as observed in an upstream listing. Platform-agnostic. */
export interface PackageSnapshot {
  source: SourceId;
  store: StoreKind;
  /** `'Owner-Name'` for Thunderstore/Hexium, `'<modId>'` for Nexus. */
  packageId: string;
  owner: string;
  name: string;
  /** Latest published version at observation time. */
  version: string;
  /**
   * Version published immediately before `version`, when the adapter could see the history.
   * `undefined` or `null` means unknown/none: an unseen package is then treated as `new`.
   */
  previousVersion?: string | null;
  url: string;
  iconUrl: string | null;
  description: string | null;
  categories: string[];
  isNsfw: boolean;
  isDeprecated: boolean;
  /** ISO-8601, UTC. */
  updatedAt: string;
  /** Approximate size of the latest archive in bytes, when the listing exposes it. */
  sizeBytes: number | null;
  /** Direct download URL of the latest archive; `undefined` or `null` when the source does not expose one. */
  downloadUrl?: string | null;
  /** Total download count of the package; `undefined` or `null` when the source does not expose one. */
  downloads?: number | null;
  /** Like/rating count (Thunderstore `rating_count`, Hexium `rating_score`); `undefined` or `null` when unknown. */
  likes?: number | null;
  /** The mod's own website (author-supplied); `undefined` or `null` when the source does not expose one or it is empty. */
  websiteUrl?: string | null;
}

/** A package plus what changed. This is the unit that is stored, deduplicated and rendered. */
export interface ModEvent {
  /** Deterministic: hash of (source, packageId, versionTo). */
  id: string;
  kind: EventKind;
  versionFrom: string | null;
  versionTo: string;
  /** Excerpt already extracted and truncated; null when unavailable or not fetched. */
  changelog: string | null;
  /** URL of the full changelog for the "read more" link, when known. */
  changelogUrl: string | null;
  /** ISO-8601, UTC. */
  createdAt: string;
  pkg: PackageSnapshot;
  /** Links to the same release on other stores, filled by cross-store dedup. */
  alsoOn: { store: StoreKind; url: string }[];
}

export interface SourceConfig {
  id: SourceId;
  store: StoreKind;
  /** Thunderstore community identifier, Hexium game slug, or Nexus game domain. */
  community: string;
  enabled: boolean;
}

export interface AppConfig {
  sources: SourceConfig[];
  /** Descriptive User-Agent sent to every upstream: name, version, repo URL. */
  userAgent: string;
}

export interface SourceState {
  id: SourceId;
  /** Opaque to the core; adapters decide what it holds (typically an ISO-8601 timestamp). */
  cursor: string | null;
  etag: string | null;
  bootstrapped: boolean;
  lastOkAt: string | null;
}

/** One alternative way into a subscription; its fields combine with AND, like the same fields of the base filter. */
export interface FilterRule {
  sources?: SourceId[];
  packages?: string[];
  includeCategories?: string[];
}

export interface SubscriptionFilter {
  /** Restrict to these sources. Absent or empty = all. */
  sources?: SourceId[];
  /** Restrict to these kinds. Absent or empty = both. */
  kinds?: EventKind[];
  /** NSFW content is excluded unless this is exactly `true`. */
  allowNsfw?: boolean;
  /** Case-insensitive; match a full `Owner-Name` package id or a bare owner name. */
  watchlist?: string[];
  /** Allowlist, same matching as `watchlist`: when non-empty only these packages or owners are delivered. */
  packages?: string[];
  /** Same matching as `watchlist`; wins over every other rule. */
  excludePackages?: string[];
  includeCategories?: string[];
  excludeCategories?: string[];
  /** Extra rules: an event passes when the base fields or any of these rules accept it. The other keys apply to every rule. */
  alsoMatch?: FilterRule[];
  /** Collapse the same release seen on several stores into one item. Default true. */
  dedupAcrossStores?: boolean;
  /** `false` never shows the Changelog block for this subscription, however long or short the excerpt. Default true. */
  includeChangelog?: boolean;
}

export type DeliveryMode = 'immediate' | 'digest';

export type SubscriptionTransport = 'webhook' | 'bot';

/** What kind of channel a bot subscription's `channelId` is: a forum (or media channel) takes posts, a text channel takes messages. */
export type ChannelKind = 'text' | 'forum';

export interface Subscription {
  id: string;
  guildId: string;
  /** Absent only for the `bot` transport. */
  webhookUrl?: string | null;
  /** Default `webhook`. */
  transport?: SubscriptionTransport;
  /** Destination channel (a text channel or a forum) of a `bot` subscription. */
  channelId?: string | null;
  /** Name shown in `/list` and in the `subscription` autocomplete. */
  label?: string | null;
  /** Discord user id of the creator. */
  createdBy?: string | null;
  /** Kind of `channelId`; default `text`. Only `threadPerMod` routing reads it. */
  channelKind?: ChannelKind;
  /** Write the updates of each mod into that mod's own thread or forum post. */
  threadPerMod?: boolean;
  /** Epoch seconds; 0 or absent is not paused, `Number.MAX_SAFE_INTEGER` is an open-ended pause. */
  pausedUntil?: number;
  /** Deliver into this existing forum post or channel thread instead of the webhook's parent channel. */
  threadId?: string | null;
  filter: SubscriptionFilter;
  mode: DeliveryMode;
  /** Only meaningful for `digest`. Default 30. */
  digestIntervalMin: number;
  enabled: boolean;
}

/** Fields of a subscription `updateSubscription` may change. */
export type SubscriptionPatch = Partial<
  Pick<Subscription, 'filter' | 'mode' | 'digestIntervalMin' | 'enabled' | 'label' | 'threadId' | 'threadPerMod' | 'pausedUntil'>
>;

/** A subscription that delivers through a Discord webhook. */
export type WebhookSubscription = Subscription & { webhookUrl: string };

export function hasWebhook(sub: Subscription): sub is WebhookSubscription {
  return typeof sub.webhookUrl === 'string' && sub.webhookUrl !== '';
}

export function isPaused(sub: Subscription, now: Date): boolean {
  return now.getTime() < (sub.pausedUntil ?? 0) * 1000;
}

/** A mod's thread in one channel, shared by every subscription of that channel. */
export interface ModThread {
  channelId: string;
  source: SourceId;
  packageId: string;
  /** Empty until a thread is opened on `anchorMessageId` (text channels). */
  threadId: string;
  anchorMessageId: string | null;
  /** ISO-8601, UTC. */
  createdAt: string;
}

/** Which message a template shapes. */
export type TemplateKind = 'immediate' | 'digest_line';

/** The text of a message template of one subscription. */
export interface SubscriptionTemplate {
  subscriptionId: string;
  kind: TemplateKind;
  body: string;
  /** ISO-8601, UTC. */
  updatedAt: string;
}

/** A bot message about one mod, so a message command can find the mod behind it. */
export interface MessageRecord {
  messageId: string;
  channelId: string;
  source: SourceId;
  packageId: string;
  eventId: string | null;
  /** ISO-8601, UTC. */
  createdAt: string;
}

/** A package matched by autocomplete. */
export interface PackageMatch {
  source: SourceId;
  packageId: string;
  owner: string;
  name: string;
}

export interface OutboxRow {
  id: string;
  subscriptionId: string;
  eventId: string;
  attempts: number;
  /** ISO-8601, UTC. */
  nextAttemptAt: string;
}

/** An outbox row joined with everything needed to render and send it. */
export interface DueDelivery {
  row: OutboxRow;
  subscription: Subscription;
  event: ModEvent;
}

// ---------------------------------------------------------------------------
// Discord wire shapes — only the subset we produce.
// ---------------------------------------------------------------------------

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string; icon_url?: string };
  author?: { name: string; url?: string; icon_url?: string };
  thumbnail?: { url: string };
  image?: { url: string };
}

/** Button emoji: a custom emoji has an `id`, a unicode one only a `name`. */
export interface DiscordButtonEmoji {
  id?: string;
  name: string;
  animated?: boolean;
}

/** Link button: the only interactive component a non-application webhook may send. */
export interface DiscordLinkButton {
  type: 2;
  style: 5;
  label: string;
  url: string;
  emoji?: DiscordButtonEmoji;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordLinkButton[];
}

/** Components V2 building blocks (message flag 1 << 15). */
export interface DiscordTextDisplay {
  type: 10;
  content: string;
}

export interface DiscordThumbnail {
  type: 11;
  media: { url: string };
}

export interface DiscordSection {
  type: 9;
  components: DiscordTextDisplay[];
  accessory: DiscordThumbnail;
}

export interface DiscordSeparator {
  type: 14;
  divider: boolean;
  spacing: 1 | 2;
}

export interface DiscordContainer {
  type: 17;
  accent_color?: number;
  components: (DiscordSection | DiscordTextDisplay | DiscordSeparator | DiscordActionRow)[];
}

/** What may sit at the top level of a message. A Text Display is a top-level content component in its own right. */
export type DiscordTopComponent = DiscordActionRow | DiscordContainer | DiscordTextDisplay;

/** Store id -> full Discord custom emoji markup, e.g. `<:name:123456789012345678>`. */
export type StoreEmojis = Partial<Record<StoreKind, string>>;

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
  /** The sender adds `with_components=true` when present. */
  components?: DiscordTopComponent[];
  /** `DISCORD.componentsV2Flag` for a Components V2 message, which has neither `content` nor `embeds`. */
  flags?: number;
  username?: string;
  avatar_url?: string;
  /** Always `{ parse: [] }` — mod names are user-controlled and must never ping. */
  allowed_mentions: { parse: [] };
}

/** A fixed internal limit an adapter measured against, so a limit that would silently disable a feature can be reported early. */
export interface CapUsage {
  /** Stable id within the source, e.g. `index-lines`. */
  id: string;
  /** What the limit is, for messages, e.g. `line cap`. */
  label: string;
  /** Unit of `limit` and `value`, e.g. `lines`. */
  unit: string;
  limit: number;
  /** Observed amount; null when unknown. A lower bound when `exceeded`. */
  value: number | null;
  exceeded: boolean;
  /** One sentence on what stops working past the limit. */
  consequence: string;
  /** Name of the constant that holds the limit. */
  constant: string;
  /** Shares of `limit` that raise an alert level; defaults to `CAP_ALERT_THRESHOLDS`. */
  thresholds?: readonly number[];
}

/** The last alert level reported for one limit, so an alert is sent once per level. */
export interface AlertState {
  level: number;
  notifiedAt: string;
}
