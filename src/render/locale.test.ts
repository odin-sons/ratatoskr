// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { DiscordContainer, DiscordMessage } from '../core/types.ts';
import { ru } from '../i18n/ru.ts';
import { makeEvent, NOW, realisticUpdates, unixSeconds } from './__fixtures__/events.ts';
import { countItems } from './count.ts';
import { renderDigest, renderImmediate } from './index.ts';
import { assertWithinLimits } from './limits.ts';

const PAGE = 'https://thunderstore.io/c/valheim/p/Bob/Alpha/';
const UPDATED = '2026-09-19T11:30:00Z';
const TIME = `<t:${unixSeconds(UPDATED)}:R>`;
const NBSP = '\u00a0';

const full = makeEvent({
  kind: 'update',
  name: 'Alpha',
  owner: 'Bob',
  url: PAGE,
  updatedAt: UPDATED,
  sizeBytes: 98_784_247,
  downloads: 12_345,
  likes: 21,
  description: 'Does things',
  changelog: '- fixed',
  changelogUrl: 'https://x.io/c',
  categories: ['Tools'],
  downloadUrl: 'https://x.io/d',
  websiteUrl: 'https://x.io/w',
  alsoOn: [{ store: 'hexium', url: 'https://hexium.example/p' }],
});

const container = (msg: DiscordMessage): DiscordContainer => msg.components![0] as DiscordContainer;
const texts = (msg: DiscordMessage): string[] =>
  container(msg).components.flatMap((b) => (b.type === 10 ? [b.content] : b.type === 9 ? b.components.map((t) => t.content) : []));
const labels = (msg: DiscordMessage): string[] => {
  const row = container(msg).components.at(-1)!;
  return row.type === 1 ? row.components.map((b) => b.label) : [];
};

describe('Components V2 message in every language', () => {
  it('renders english wording', () => {
    const msg = renderImmediate(full, { now: NOW, locale: 'en' });
    expect(texts(msg)).toEqual([
      [
        `# [Alpha](${PAGE})`,
        `\u2b06\ufe0f Updated by Bob · 1.2.3 → 1.2.4 · ${TIME}`,
        'ℹ️ 94.2 MB · Downloaded 12,345 times · 21 likes',
        'Also on [Hexium](https://hexium.example/p)',
        '',
        '**📜 Description**',
        'Does things',
      ].join('\n'),
      '**Changelog**\n- fixed\n[Full changelog](https://x.io/c)',
      '**🗂️ Categories**\nTools',
    ]);
    expect(labels(msg)).toEqual(['Mod page', 'Download', 'Website', 'ratatoskr']);
  });

  it('renders russian wording with russian plurals, number format and units', () => {
    const msg = renderImmediate(full, { now: NOW, locale: 'ru' });
    expect(texts(msg)).toEqual([
      [
        `# [Alpha](${PAGE})`,
        `\u2b06\ufe0f Обновление от Bob · 1.2.3 → 1.2.4 · ${TIME}`,
        `ℹ️ 94,2 МБ · Скачан 12${NBSP}345 раз · 21 лайк`,
        'Также на [Hexium](https://hexium.example/p)',
        '',
        '**📜 Описание**',
        'Does things',
      ].join('\n'),
      '**Изменения**\n- fixed\n[Полный список изменений](https://x.io/c)',
      '**🗂️ Категории**\nTools',
    ]);
    expect(labels(msg)).toEqual(['Страница мода', 'Скачать', 'Сайт', 'ratatoskr']);
  });

  it('uses the russian new-package wording', () => {
    const msg = renderImmediate(makeEvent({ kind: 'new', versionFrom: null, versionTo: '1.0.0', owner: 'Bob', updatedAt: UPDATED }), { now: NOW, locale: 'ru' });
    expect(texts(msg)[0]!.split('\n')[1]).toBe(`🆕 Новинка от Bob · 1.0.0 · ${TIME}`);
    const anonymous = renderImmediate(makeEvent({ kind: 'new', versionFrom: null, versionTo: '1.0.0', owner: '', updatedAt: UPDATED }), { now: NOW, locale: 'ru' });
    expect(texts(anonymous)[0]!.split('\n')[1]).toBe(`🆕 Новинка · 1.0.0 · ${TIME}`);
  });

  it('names a nameless mod in the catalog language, in every layout', () => {
    const nameless = makeEvent({ kind: 'new', name: '   ', url: PAGE });
    expect(texts(renderImmediate(nameless, { now: NOW, locale: 'ru' }))[0]!.split('\n')[0]).toBe(`# [без названия](${PAGE})`);
    expect(renderDigest([nameless], { detailed: () => true, now: NOW, locale: 'ru' })[0]!.embeds![0]!.description).toContain('# [без названия]');
    const compact = renderDigest([{ ...nameless, kind: 'update' }], { detailed: () => false, now: NOW, locale: 'ru' });
    expect(compact[0]!.embeds![0]!.description).toContain('[без названия]');
    expect(renderDigest([{ ...nameless, kind: 'update' }], { detailed: () => false, now: NOW })[0]!.embeds![0]!.description).toContain('[unnamed]');
  });

  it('falls back to english for a language it does not have', () => {
    const unknown = renderImmediate(full, { now: NOW, locale: 'xx' as never });
    expect(unknown).toEqual(renderImmediate(full, { now: NOW, locale: 'en' }));
    expect(renderImmediate(full, { now: NOW })).toEqual(renderImmediate(full, { now: NOW, locale: 'en' }));
  });

  it('degrades a changelog link that impersonates the localised full-changelog label', () => {
    const changelog = '- see [Полный список изменений](https://evil.example/phish)\n- [docs](https://ok.example/d)';
    const value = texts(renderImmediate(makeEvent({ kind: 'new', changelog, changelogUrl: 'https://x.io/c' }), { now: NOW, locale: 'ru' }))[1]!;
    expect(value).not.toContain('evil.example');
    expect(value).toContain('](https://ok.example/d)');
    expect(value.match(/Полный список изменений/g)).toHaveLength(2);
    expect(value.endsWith('[Полный список изменений](https://x.io/c)')).toBe(true);
    expect(value.match(/\]\(/g)).toHaveLength(2);
  });

  it('degrades an impostor in any letter case, and leaves links alone when the label text is absent', () => {
    const shout = renderImmediate(makeEvent({ kind: 'new', changelog: '- [ПОЛНЫЙ СПИСОК ИЗМЕНЕНИЙ](https://evil.example/x) [ok](https://ok.example/y)' }), { now: NOW, locale: 'ru' });
    expect(texts(shout)[1]).not.toContain('evil.example');
    expect(texts(shout)[1]).toContain('](https://ok.example/y)');
    const plain = renderImmediate(makeEvent({ kind: 'new', changelog: '- [ok](https://ok.example/y)' }), { now: NOW, locale: 'ru' });
    expect(texts(plain)[1]).toContain('](https://ok.example/y)');
  });

  it('keeps the module-produced english link out of a russian message', () => {
    const value = texts(renderImmediate(makeEvent({ kind: 'new', changelog: '- a\n[Full changelog](https://x.io/c)', changelogUrl: 'https://x.io/c' }), { now: NOW, locale: 'ru' }))[1]!;
    expect(value).toBe('**Изменения**\n- a\n[Полный список изменений](https://x.io/c)');
  });
});

describe('digest in every language', () => {
  it('renders a detailed embed in russian', () => {
    const [msg] = renderDigest([full], { detailed: () => true, now: NOW, locale: 'ru' });
    const embed = msg!.embeds![0]!;
    expect(embed.description!.split('\n').slice(1, 3)).toEqual([`\u2b06\ufe0f Обновление от Bob · 1.2.3 → 1.2.4 · ${TIME}`, `ℹ️ 94,2 МБ · Скачан 12${NBSP}345 раз · 21 лайк`]);
    expect(embed.fields!.map((f) => f.name)).toEqual(['Изменения', '🗂️ Категории', '\u200b']);
    expect(embed.fields![0]!.value).toBe('- fixed\n[Полный список изменений](https://x.io/c)');
  });

  it('renders store headings with the russian plural of each count', () => {
    const heading = (n: number): string => renderDigest(realisticUpdates(n), { detailed: () => false, now: NOW, locale: 'ru' })[0]!.embeds![0]!.description!.split('\n')[0]!;
    expect(heading(1)).toBe('**Thunderstore** · 1 обновление');
    expect(heading(2)).toBe('**Thunderstore** · 2 обновления');
    expect(heading(5)).toBe('**Thunderstore** · 5 обновлений');
    expect(heading(11)).toBe('**Thunderstore** · 11 обновлений');
    expect(heading(21)).toBe('**Thunderstore** · 21 обновление');
    expect(heading(22)).toBe('**Thunderstore** · 22 обновления');
  });

  it('shows compact list sizes with russian units', () => {
    const [msg] = renderDigest([makeEvent({ sizeBytes: 98_784_247, owner: 'Bob' })], { detailed: () => false, now: NOW, locale: 'ru' });
    expect(msg!.embeds![0]!.description).toContain('Bob · 94,2 МБ');
  });

  it('spells the page counter in russian, and never drops a mod', () => {
    const events = realisticUpdates(700);
    const messages = renderDigest(events, { detailed: () => false, now: NOW, locale: 'ru' });
    expect(messages.length).toBeGreaterThan(2);
    expect(countItems(messages)).toBe(700);
    messages.forEach((msg, i) => {
      expect(msg.embeds!.at(-1)!.footer).toEqual({ text: ru.page(i + 1, messages.length) });
      expect(assertWithinLimits(msg)).toEqual([]);
    });
  });

  it('falls back to english for an unknown language', () => {
    const events = realisticUpdates(3);
    expect(renderDigest(events, { detailed: () => false, now: NOW, locale: 'xx' as never })).toEqual(renderDigest(events, { detailed: () => false, now: NOW, locale: 'en' }));
  });
});
