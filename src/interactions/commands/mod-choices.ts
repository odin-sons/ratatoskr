// SPDX-License-Identifier: AGPL-3.0-or-later
import { AUTOCOMPLETE_MAX_RESULTS, DISCORD_INTERACTION } from '../../core/constants.ts';
import type { Store } from '../../core/ports.ts';
import type { AutocompleteChoice } from '../responses.ts';

/** Autocomplete choices for a mod option: the stored package id as value, one choice per id. */
export async function modChoices(store: Store, prefix: string, options: { sfwOnly?: boolean } = {}): Promise<AutocompleteChoice[]> {
  const choices = new Map<string, AutocompleteChoice>();
  for (const match of await store.searchPackages(prefix, options)) {
    if (match.packageId.length > DISCORD_INTERACTION.choiceValueMax || choices.has(match.packageId)) continue;
    choices.set(match.packageId, { name: `${match.name} (${match.owner})`, value: match.packageId });
  }
  return [...choices.values()].slice(0, AUTOCOMPLETE_MAX_RESULTS);
}
