// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD } from '../core/constants.ts';
import type { DiscordEmbed, DiscordMessage, StoreKind } from '../core/types.ts';
import type { Block, Line } from './compact.ts';
import { FOOTER_SEP, SOURCE_FOOTER, TEXT_BUDGET } from './layout.ts';
import { measureEmbed } from './limits.ts';
import { STORES } from './stores.ts';

interface State {
  used: number;
  embeds: number;
  lastStore: StoreKind | null;
  lastDesc: number;
}

type Slot = { kind: 'embed'; embed: DiscordEmbed } | { kind: 'list'; store: StoreKind; lines: Line[] };

interface Draft {
  slots: Slot[];
  state: State;
}

const EMPTY: State = { used: 0, embeds: 0, lastStore: null, lastDesc: 0 };
const LIST_FOOTER_TAIL_WORST = `${FOOTER_SEP}9999 updates`.length;

function listFooterWorst(store: StoreKind): number {
  return STORES[store].label.length + LIST_FOOTER_TAIL_WORST;
}

function advance(state: State, store: StoreKind, len: number): { state: State; appended: boolean } | null {
  if (state.lastStore === store) {
    const desc = state.lastDesc + 1 + len;
    const used = state.used + 1 + len;
    if (desc <= DISCORD.embedDescriptionMax && used <= TEXT_BUDGET) {
      return { state: { ...state, used, lastDesc: desc }, appended: true };
    }
  }
  const used = state.used + len + listFooterWorst(store);
  if (state.embeds < DISCORD.embedsPerMessage && len <= DISCORD.embedDescriptionMax && used <= TEXT_BUDGET) {
    return { state: { used, embeds: state.embeds + 1, lastStore: store, lastDesc: len }, appended: false };
  }
  return null;
}

function fitsEmbed(state: State, cost: number): boolean {
  return state.embeds < DISCORD.embedsPerMessage && state.used + cost <= TEXT_BUDGET;
}

function fitsBlock(start: State, block: Block): boolean {
  let state = start;
  for (const line of block.lines) {
    const next = advance(state, block.store, line.text.length);
    if (!next) return false;
    state = next.state;
  }
  return true;
}

function listEmbed(slot: { store: StoreKind; lines: Line[] }): DiscordEmbed {
  const style = STORES[slot.store];
  const count = slot.lines.reduce((sum, line) => sum + line.count, 0);
  return {
    description: slot.lines.map((line) => line.text).join('\n'),
    color: style.color,
    footer: { text: `${style.label}${FOOTER_SEP}${count} ${count === 1 ? 'update' : 'updates'}` },
  };
}

function toMessage(draft: Draft, index: number, total: number): DiscordMessage {
  const embeds = draft.slots.map((slot) => (slot.kind === 'embed' ? { ...slot.embed } : listEmbed(slot)));
  const last = embeds[embeds.length - 1]!;
  const parts = [last.footer?.text, SOURCE_FOOTER, total > 1 ? `(${index + 1}/${total})` : undefined];
  last.footer = { text: parts.filter((part): part is string => Boolean(part)).join(FOOTER_SEP) };
  return { embeds, allowed_mentions: { parse: [] } };
}

/** Packs atomic embeds and store blocks into as few messages as the Discord limits allow. */
export class Packer {
  private drafts: Draft[] = [];
  private current: Draft | null = null;

  startMessage(): void {
    this.current = null;
  }

  private open(): Draft {
    if (!this.current) {
      this.current = { slots: [], state: EMPTY };
      this.drafts.push(this.current);
    }
    return this.current;
  }

  addEmbed(embed: DiscordEmbed): void {
    const cost = measureEmbed(embed);
    if (this.current && !fitsEmbed(this.current.state, cost)) this.current = null;
    const draft = this.open();
    draft.slots.push({ kind: 'embed', embed });
    draft.state = { used: draft.state.used + cost, embeds: draft.state.embeds + 1, lastStore: null, lastDesc: 0 };
  }

  private addLine(store: StoreKind, line: Line): void {
    let draft = this.open();
    let next = advance(draft.state, store, line.text.length);
    if (!next) {
      this.current = null;
      draft = this.open();
      next = advance(draft.state, store, line.text.length);
    }
    if (!next) throw new Error('render: a single list line exceeds an empty message');
    draft.state = next.state;
    const last = draft.slots[draft.slots.length - 1];
    if (next.appended && last?.kind === 'list') last.lines.push(line);
    else draft.slots.push({ kind: 'list', store, lines: [line] });
  }

  /** Keeps a store together in one message when it fits in one; otherwise fills message after message. */
  addBlock(block: Block): void {
    if (this.current && !fitsBlock(this.current.state, block) && fitsBlock(EMPTY, block)) this.current = null;
    for (const line of block.lines) this.addLine(block.store, line);
  }

  finish(): DiscordMessage[] {
    const total = this.drafts.length;
    return this.drafts.map((draft, index) => toMessage(draft, index, total));
  }
}
