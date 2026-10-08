// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModEvent, StoreKind } from '../core/types.ts';
import { getMessages, type Messages } from '../i18n/index.ts';
import { CAPS } from './layout.ts';
import { STORE_ORDER } from './stores.ts';
import type { ParsedTemplate } from './template/parse.ts';
import { renderLine, type LineContext } from './template/line.ts';
import { formatBytes, inline, mdLink, safeUrl } from './text.ts';

export type Level = 0 | 1 | 2 | 3 | 4;

export const MAX_LEVEL: Level = 4;

/** One rendered list line. `count` is the number of mods on it (more than 1 only at L3). */
export interface Line {
  text: string;
  count: number;
}

export interface Block {
  store: StoreKind;
  lines: Line[];
}

export interface Prepared {
  store: StoreKind;
  ownerKey: string;
  name: string;
  url: string | null;
  from: string | null;
  to: string;
  owner: string;
  size: string | null;
}

export function prepare(event: ModEvent, messages: Messages = getMessages(undefined)): Prepared {
  const { pkg } = event;
  const from = event.versionFrom ? inline(event.versionFrom, CAPS.version) : '';
  return {
    store: pkg.store,
    ownerKey: pkg.owner,
    name: inline(pkg.name, CAPS.name) || messages.unnamed,
    url: safeUrl(pkg.url),
    from: from || null,
    to: inline(event.versionTo, CAPS.version) || '?',
    owner: inline(pkg.owner, CAPS.owner),
    size: formatBytes(pkg.sizeBytes, messages.byteUnits, messages.decimalSeparator),
  };
}

function link(p: Prepared, bold: boolean): string {
  const text = p.url ? mdLink(p.name, p.url) : p.name;
  return bold ? `**${text}**` : text;
}

function versions(p: Prepared): string {
  return p.from ? `${p.from} → ${p.to}` : p.to;
}

/** The list line template of a digest and what its variables need besides the mod. */
export interface LineOptions {
  template: ParsedTemplate | null;
  context: LineContext;
}

const NO_LINE_OPTIONS: LineOptions = { template: null, context: { storeEmojis: {} } };

function itemLine(p: Prepared, level: 0 | 1 | 2 | 4, line: LineOptions): string {
  switch (level) {
    case 0:
      return renderLine(line.template, p, line.context);
    case 1:
      return `${link(p, true)} ${versions(p)}`;
    case 2:
      return `${link(p, false)} → ${p.to}`;
    case 4:
      return `${p.name} ${p.to}`;
  }
}

const GROUP_SEPARATOR = ' | ';

function groupedLines(items: Prepared[]): Line[] {
  const groups = new Map<string, Prepared[]>();
  for (const p of items) {
    const group = groups.get(p.ownerKey);
    if (group) group.push(p);
    else groups.set(p.ownerKey, [p]);
  }
  const lines: Line[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const header = first.owner ? `**${first.owner}** · ` : '';
    let text = '';
    let count = 0;
    for (const p of group) {
      const entry = `${link(p, false)} ${p.to}`;
      if (count > 0 && header.length + text.length + GROUP_SEPARATOR.length + entry.length > CAPS.groupLine) {
        lines.push({ text: header + text, count });
        text = '';
        count = 0;
      }
      text = count === 0 ? entry : `${text}${GROUP_SEPARATOR}${entry}`;
      count += 1;
    }
    lines.push({ text: header + text, count });
  }
  return lines;
}

/** Renders every item at one level; store order is fixed and empty stores are omitted. */
export function renderBlocks(items: readonly Prepared[], level: Level, line: LineOptions = NO_LINE_OPTIONS): Block[] {
  const byStore = new Map<StoreKind, Prepared[]>();
  for (const p of items) {
    const list = byStore.get(p.store);
    if (list) list.push(p);
    else byStore.set(p.store, [p]);
  }
  const blocks: Block[] = [];
  for (const store of STORE_ORDER) {
    const list = byStore.get(store);
    if (!list) continue;
    const lines: Line[] = level === 3 ? groupedLines(list) : list.map((p) => ({ text: itemLine(p, level, line), count: 1 }));
    blocks.push({ store, lines });
  }
  return blocks;
}
