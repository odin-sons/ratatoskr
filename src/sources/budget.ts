// SPDX-License-Identifier: AGPL-3.0-or-later

/** Internal per-tick caps for secondary requests; anything beyond a cap is deferred to a later tick. */
export const SOURCE_BUDGET = {
  thunderstoreVersionLookups: 10,
  thunderstoreListingPages: 3,
  /** Cold-start seeding of the Hexium package index in this many hash slices, one per poll. */
  hexiumSeedSlices: 8,
  /** Per-package lookups (one subrequest each) per Hexium index scan; the rest are found again by the next scan. */
  hexiumLookupsPerPoll: 15,
  hexiumLookupsPerReconcile: 20,
  nexusMetadataLookups: 5,
} as const;

/** Hexium package index bodies above this size are refused (the live index is about 390 bytes per package). */
export const HEXIUM_INDEX_MAX_BYTES = 1.5 * 1024 * 1024;

/** An index with more lines than this is refused; an index tick costs about 4 ms CPU at 1318 lines and 7 ms at 3000. */
export const HEXIUM_INDEX_MAX_LINES = 3000;

/** An index line longer than this is unreadable (the longest real line is about 5 KB). */
export const HEXIUM_INDEX_MAX_LINE_BYTES = 32 * 1024;

/** Hexium per-package lookup responses (about 1.1 KB) above this size are refused before parsing. */
export const HEXIUM_LOOKUP_MAX_BYTES = 64 * 1024;

/** Nexus self-throttle: skip polling when the remaining share of a window drops below this fraction. */
export const NEXUS_THROTTLE_RESERVE = 0.05;

/** Newest release age (ms) within which a listing/version mismatch is treated as a stale CDN cache. */
export const STALE_CACHE_WINDOW_MS = 120_000;

export const FETCH_TIMEOUT_MS = 15_000;

/** Timestamps this far past the poll time are treated as clock skew; further ahead they never raise or keep a cursor. */
export const CURSOR_FUTURE_SLACK_MS = 60 * 60 * 1000;

/** Changelog responses above this size are refused before parsing. */
export const CHANGELOG_MAX_BYTES = 128 * 1024;

/** Thunderstore versions responses above this size (about 2300 versions) are refused before parsing. */
export const VERSIONS_MAX_BYTES = 512 * 1024;
