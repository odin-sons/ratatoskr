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

/** Unknown id → `new`; known with a different version → `update`; same version → nothing (timestamps never trigger). */
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
    events.push({
      id: eventId(pkg.source, pkg.packageId, pkg.version),
      kind: knownVersion === undefined ? 'new' : 'update',
      versionFrom: knownVersion ?? null,
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
