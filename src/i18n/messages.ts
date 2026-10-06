// SPDX-License-Identifier: AGPL-3.0-or-later

/** Every user-visible string of the renderer. A locale that misses a key does not compile. */
export interface Messages {
  /** Info line of a new package, with the owner name (already escaped). */
  newBy(owner: string): string;
  updatedBy(owner: string): string;
  /** Same lines when the owner is unknown. */
  newAnonymous: string;
  updatedAnonymous: string;
  /** `count` picks the plural form; `formatted` is the number as shown. */
  downloaded(count: number, formatted: string): string;
  likes(count: number, formatted: string): string;
  /** Name shown for a package whose name is empty. */
  unnamed: string;
  description: string;
  changelog: string;
  categories: string;
  fullChangelog: string;
  modPage: string;
  download: string;
  website: string;
  /** Count line of a compact store list, e.g. `37 updates`. */
  updates(count: number): string;
  alsoOn: string;
  /** Suffix of a digest that spans several messages. */
  page(index: number, total: number): string;
  /** Between the digit groups of a large number. */
  thousandsSeparator: string;
  decimalSeparator: string;
  /** Interaction replies. */
  unknownCommand: string;
  somethingWrong: string;
  missingManageChannel: string;
  guildOnly: string;
  unsupportedChannel: string;
  /** `permissions` is the already joined list of permission names. */
  botPermissionsMissing(permissions: string): string;
  /** `/subscribe` refusals. */
  subscribeNeedsFilter: string;
  subscribeThreadPerModDigest: string;
  subscribeIntervalImmediate: string;
  sourceNotConfigured(source: string): string;
  /** `details` is the joined list of validation problems. */
  invalidOptions(details: string): string;
  subscribeLimitChannel(max: number): string;
  subscribeLimitGuild(max: number): string;
  subscribeLimitTotal(max: number): string;
  subscribeOwnerAndMod: string;
  modNotFound(mod: string): string;
  subscribeDuplicate: string;
  /** `where` is a channel mention, `details` the mode and the filter summary. */
  subscribed(label: string, where: string, details: string): string;
  subscriptionId(id: string): string;
  /** `/unsubscribe`. */
  unsubscribed(label: string): string;
  subscriptionNotFound: string;
  /** `/list`. */
  listEmpty: string;
  listChannelTitle: string;
  listGuildTitle: string;
  listWebhook: string;
  listPrevious: string;
  listNext: string;
  /** Pieces of a subscription line. */
  modeImmediate: string;
  modeDigest(minutes: number): string;
  threadPerMod: string;
  filterEverything: string;
  filterPackages(list: string): string;
  filterCategories(list: string): string;
  filterSources(list: string): string;
  filterOnlyNew: string;
  filterOnlyUpdates: string;
  /** B, KB, MB, GB, TB. */
  byteUnits: readonly [string, string, string, string, string];
}
