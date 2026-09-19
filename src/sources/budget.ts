// SPDX-License-Identifier: AGPL-3.0-or-later

/** Internal per-tick caps for secondary requests; anything beyond a cap is deferred to a later tick. */
export const SOURCE_BUDGET = {
  thunderstoreVersionLookups: 10,
  thunderstoreListingPages: 3,
  hexiumDetailLookups: 10,
  nexusMetadataLookups: 5,
} as const;

/** Nexus self-throttle: skip polling when the remaining share of a window drops below this fraction. */
export const NEXUS_THROTTLE_RESERVE = 0.05;

/** Newest release age (ms) within which a listing/version mismatch is treated as a stale CDN cache. */
export const STALE_CACHE_WINDOW_MS = 120_000;

export const FETCH_TIMEOUT_MS = 15_000;
