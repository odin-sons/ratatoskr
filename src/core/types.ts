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
  /** Collapse the same release seen on several stores into one item. Default true. */
  dedupAcrossStores?: boolean;
  /** `false` never shows the Changelog block for this subscription, however long or short the excerpt. Default true. */
  includeChangelog?: boolean;
}

export type DeliveryMode = 'immediate' | 'digest';

export interface Subscription {
  id: string;
  guildId: string;
  webhookUrl: string;
  filter: SubscriptionFilter;
  mode: DeliveryMode;
  /** Only meaningful for `digest`. Default 30. */
  digestIntervalMin: number;
  enabled: boolean;
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

/** What may sit at the top level of a message. */
export type DiscordTopComponent = DiscordActionRow | DiscordContainer;

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
