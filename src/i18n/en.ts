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
  updates: (count) => `${count} ${pick(englishPlural(count), { one: 'update', other: 'updates' })}`,
  alsoOn: 'Also on',
  page: (index, total) => `(${index}/${total})`,
  thousandsSeparator: ',',
  decimalSeparator: '.',
  unknownCommand: 'Unknown command.',
  somethingWrong: 'Something went wrong. Try again later.',
  missingManageChannel: 'You need the Manage Channel permission to use this command.',
  guildOnly: 'This command works only in a server channel.',
  unsupportedChannel: 'This command does not work in this kind of channel. Use it in a text channel, a thread or a forum post.',
  botPermissionsMissing: (permissions) => `I am missing permissions in this channel: ${permissions}.`,
  byteUnits: ['B', 'KB', 'MB', 'GB', 'TB'],
};
