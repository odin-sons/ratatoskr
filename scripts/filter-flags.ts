// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import type { EventKind } from '../src/core/types.ts';

const EVENT_KINDS: readonly string[] = ['new', 'update'] satisfies EventKind[];

/** `parseArgs` option definitions shared by every script that builds a subscription filter. */
export const FILTER_FLAG_OPTIONS = {
  filter: { type: 'string' },
  'filter-file': { type: 'string' },
  source: { type: 'string', multiple: true },
  kind: { type: 'string', multiple: true },
  package: { type: 'string', multiple: true },
  'exclude-package': { type: 'string', multiple: true },
  category: { type: 'string', multiple: true },
  'exclude-category': { type: 'string', multiple: true },
  'allow-nsfw': { type: 'boolean' },
} as const;

export const FILTER_FLAGS_USAGE = `  --filter <json>            SubscriptionFilter as a JSON string (default: {})
  --filter-file <path>       SubscriptionFilter read from a JSON file
  --source <id>              Only this source, e.g. hexium:valheim (repeatable)
  --kind <new|update>        Only new packages or only updates (repeatable)
  --package <Owner-Name|Owner>
                             Only this package or every package of this owner (repeatable)
  --exclude-package <Owner-Name|Owner>
                             Never this package or owner; wins over everything (repeatable)
  --category <name>          Only packages in this category (repeatable)
  --exclude-category <name>  Drop packages in this category (repeatable)
  --allow-nsfw               Also deliver NSFW packages (excluded by default)`;

export const FILTER_FLAGS_NOTE = 'The filter flags (--source ... --allow-nsfw) cannot be combined with --filter or --filter-file.';

export interface FilterFlagValues {
  filter?: string;
  'filter-file'?: string;
  source?: string[];
  kind?: string[];
  package?: string[];
  'exclude-package'?: string[];
  category?: string[];
  'exclude-category'?: string[];
  'allow-nsfw'?: boolean;
}

const LIST_FLAGS = [
  ['source', 'sources'],
  ['kind', 'kinds'],
  ['package', 'packages'],
  ['exclude-package', 'excludePackages'],
  ['category', 'includeCategories'],
  ['exclude-category', 'excludeCategories'],
] as const;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Turns the filter flags into an unvalidated filter object. The caller runs the
 * result through the subscription validator before it reaches SQL.
 */
export function resolveFilter(
  values: FilterFlagValues,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): unknown {
  const given: string[] = [];
  for (const [flag] of LIST_FLAGS) if ((values[flag]?.length ?? 0) > 0) given.push(`--${flag}`);
  if (values['allow-nsfw'] === true) given.push('--allow-nsfw');

  const rawFlags = [values.filter, values['filter-file']].filter((v) => v !== undefined).length;
  if (rawFlags === 2) throw new Error('use either --filter or --filter-file, not both');
  if (rawFlags === 1 && given.length > 0) {
    throw new Error(`use either raw JSON (--filter or --filter-file) or the filter flags, not both (${given.join(', ')} given)`);
  }

  if (rawFlags === 1) {
    const text = values['filter-file'] !== undefined ? readFile(values['filter-file']) : (values.filter as string);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('filter is not valid JSON');
    }
  }

  const filter: Record<string, unknown> = {};
  for (const kind of values.kind ?? []) {
    if (!EVENT_KINDS.includes(kind)) throw new Error(`--kind must be one of ${EVENT_KINDS.join(', ')}`);
  }
  for (const [flag, key] of LIST_FLAGS) {
    const list = values[flag];
    if (list !== undefined && list.length > 0) filter[key] = unique(list);
  }
  if (values['allow-nsfw'] === true) filter.allowNsfw = true;
  return filter;
}
