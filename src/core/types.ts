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
  includeCategories?: string[];
  excludeCategories?: string[];
  /** Collapse the same release seen on several stores into one item. Default true. */
  dedupAcrossStores?: boolean;
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
  timestamp?: string;
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
  username?: string;
  avatar_url?: string;
  /** Always `{ parse: [] }` — mod names are user-controlled and must never ping. */
  allowed_mentions: { parse: [] };
}
