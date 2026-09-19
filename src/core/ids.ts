// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PackageSnapshot, SourceId } from './types.ts';

/** Deterministic and collision-free: composite key rather than a hash, so it needs no async crypto. */
export function eventId(source: SourceId, packageId: string, version: string): string {
  return `${source}|${packageId}|${version}`;
}

export function outboxId(subscriptionId: string, evId: string): string {
  return `${subscriptionId}|${evId}`;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Same release published on several stores collapses to one key. */
export function releaseKey(pkg: Pick<PackageSnapshot, 'owner' | 'name'>, version: string): string {
  return `${normalise(pkg.owner)}|${normalise(pkg.name)}|${version}`;
}
