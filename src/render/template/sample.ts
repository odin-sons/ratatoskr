// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModEvent } from '../../core/types.ts';

/** A made-up update used to show how a template looks when no real mod is given. */
export function sampleEvent(now: Date): ModEvent {
  const at = now.toISOString();
  return {
    id: 'sample|event',
    kind: 'update',
    versionFrom: '1.2.0',
    versionTo: '1.3.0',
    changelog: '- Added a new sword\n- Fixed the shield block\n- Reworked the crafting menu\n- Tuned the damage of the bow',
    changelogUrl: 'https://example.com/example-mod/changelog',
    createdAt: at,
    alsoOn: [],
    pkg: {
      source: 'thunderstore:valheim',
      store: 'thunderstore',
      packageId: 'Example-ExampleMod',
      version: '1.3.0',
      name: 'Example Mod',
      owner: 'Example',
      url: 'https://example.com/example-mod',
      iconUrl: null,
      downloadUrl: 'https://example.com/example-mod/download',
      websiteUrl: 'https://example.com/example-mod/site',
      description: 'An example mod that shows how a message looks with your template.',
      categories: ['Tools', 'Weapons'],
      sizeBytes: 2_500_000,
      downloads: 12_345,
      likes: 42,
      isNsfw: false,
      isDeprecated: false,
      updatedAt: at,
    },
  };
}
