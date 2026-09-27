// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Messages } from './messages.ts';
import { pick, russianPlural } from './plural.ts';

export const ru: Messages = {
  newBy: (owner) => `Новинка от ${owner}`,
  updatedBy: (owner) => `Обновление от ${owner}`,
  newAnonymous: 'Новинка',
  updatedAnonymous: 'Обновление',
  downloaded: (count, formatted) => `Скачан ${formatted} ${pick(russianPlural(count), { one: 'раз', few: 'раза', many: 'раз', other: 'раза' })}`,
  likes: (count, formatted) => `${formatted} ${pick(russianPlural(count), { one: 'лайк', few: 'лайка', many: 'лайков', other: 'лайка' })}`,
  unnamed: 'без названия',
  description: 'Описание',
  changelog: 'Изменения',
  categories: 'Категории',
  fullChangelog: 'Полный список изменений',
  modPage: 'Страница мода',
  download: 'Скачать',
  website: 'Сайт',
  sourceCode: 'ratatoskr',
  updates: (count) => `${count} ${pick(russianPlural(count), { one: 'обновление', few: 'обновления', many: 'обновлений', other: 'обновления' })}`,
  alsoOn: 'Также на',
  page: (index, total) => `(стр. ${index}/${total})`,
  thousandsSeparator: '\u00a0',
  decimalSeparator: ',',
  byteUnits: ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'],
};
