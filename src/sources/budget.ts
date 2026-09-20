// SPDX-License-Identifier: AGPL-3.0-or-later

/** Internal per-tick caps for secondary requests; anything beyond a cap is deferred to a later tick. */
export const SOURCE_BUDGET = {
  thunderstoreVersionLookups: 10,
  thunderstoreListingPages: 3,
  hexiumDumpSlices: 4,
  nexusMetadataLookups: 5,
} as const;

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
