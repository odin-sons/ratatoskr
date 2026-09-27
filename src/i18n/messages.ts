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
  /** B, KB, MB, GB, TB. */
  byteUnits: readonly [string, string, string, string, string];
}
