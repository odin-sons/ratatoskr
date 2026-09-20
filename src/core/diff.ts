// SPDX-License-Identifier: AGPL-3.0-or-later
import { eventId } from './ids.ts';
import type { ModEvent, PackageSnapshot } from './types.ts';

/** One snapshot per packageId; the newest `updatedAt` wins, later entries win ties. First-seen order is kept. */
export function dedupeSnapshots(snapshots: PackageSnapshot[]): PackageSnapshot[] {
  const byId = new Map<string, PackageSnapshot>();
  for (const snap of snapshots) {
    const prev = byId.get(snap.packageId);
    if (prev === undefined || snap.updatedAt >= prev.updatedAt) byId.set(snap.packageId, snap);
  }
  return [...byId.values()];
}

/**
 * Known with a different version → `update`; same version → nothing (timestamps never trigger).
 * Unknown id → `update` when the snapshot carries a distinct `previousVersion`, otherwise `new`.
 */
export function diffSnapshots(
  known: Map<string, string>,
  snapshots: PackageSnapshot[],
  now: Date,
): { events: ModEvent[] } {
  const createdAt = now.toISOString();
  const events: ModEvent[] = [];
  for (const pkg of dedupeSnapshots(snapshots)) {
    const knownVersion = known.get(pkg.packageId);
    if (knownVersion === pkg.version) continue;
    const versionFrom = knownVersion ?? seenBefore(pkg);
    events.push({
      id: eventId(pkg.source, pkg.packageId, pkg.version),
      kind: versionFrom === null ? 'new' : 'update',
      versionFrom,
      versionTo: pkg.version,
      changelog: null,
      changelogUrl: null,
      createdAt,
      pkg,
      alsoOn: [],
    });
  }
  return { events };
}

function seenBefore(pkg: PackageSnapshot): string | null {
  const previous = pkg.previousVersion;
  return previous !== undefined && previous !== null && previous !== '' && previous !== pkg.version ? previous : null;
}
