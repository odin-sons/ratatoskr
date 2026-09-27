// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Messages } from './messages.ts';
import { englishPlural, pick } from './plural.ts';

export const en: Messages = {
  newBy: (owner) => `New by ${owner}`,
  updatedBy: (owner) => `Updated by ${owner}`,
  newAnonymous: 'New',
  updatedAnonymous: 'Updated',
  downloaded: (count, formatted) => `Downloaded ${formatted} ${pick(englishPlural(count), { one: 'time', other: 'times' })}`,
  likes: (count, formatted) => `${formatted} ${pick(englishPlural(count), { one: 'like', other: 'likes' })}`,
  unnamed: 'unnamed',
  description: 'Description',
  changelog: 'Changelog',
  categories: 'Categories',
  fullChangelog: 'Full changelog',
  modPage: 'Mod page',
  download: 'Download',
  website: 'Website',
  sourceCode: 'ratatoskr',
  updates: (count) => `${count} ${pick(englishPlural(count), { one: 'update', other: 'updates' })}`,
  alsoOn: 'Also on',
  page: (index, total) => `(${index}/${total})`,
  thousandsSeparator: ',',
  decimalSeparator: '.',
  byteUnits: ['B', 'KB', 'MB', 'GB', 'TB'],
};
