// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD } from '../core/constants.ts';
import type { DiscordEmbed, DiscordMessage, StoreEmojis, StoreKind } from '../core/types.ts';
import type { Block, Line } from './compact.ts';
import { resolveStoreEmojis } from './emoji.ts';
import { FOOTER_SEP, PROJECT_FIELD, TEXT_BUDGET } from './layout.ts';
import { measureEmbed } from './limits.ts';
import { STORE_ORDER, STORES } from './stores.ts';

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

const WORST_COUNT = 9999;

function listHeading(store: StoreKind, count: number, emoji: string): string {
  return `${emoji ? `${emoji} ` : ''}**${STORES[store].label}**${FOOTER_SEP}${count} ${count === 1 ? 'update' : 'updates'}`;
}

function advance(state: State, store: StoreKind, len: number, headingWorst: number): { state: State; appended: boolean } | null {
  if (state.lastStore === store) {
    const desc = state.lastDesc + 1 + len;
    const used = state.used + 1 + len;
    if (desc <= DISCORD.embedDescriptionMax && used <= TEXT_BUDGET) {
      return { state: { ...state, used, lastDesc: desc }, appended: true };
    }
  }
  const opening = headingWorst + 1 + len;
  const used = state.used + opening;
  if (state.embeds < DISCORD.embedsPerMessage && opening <= DISCORD.embedDescriptionMax && used <= TEXT_BUDGET) {
    return { state: { used, embeds: state.embeds + 1, lastStore: store, lastDesc: opening }, appended: false };
  }
  return null;
}

function fitsEmbed(state: State, cost: number): boolean {
  return state.embeds < DISCORD.embedsPerMessage && state.used + cost <= TEXT_BUDGET;
}

/** Packs atomic embeds and store blocks into as few messages as the Discord limits allow, then adds the project field. */
export class Packer {
  private drafts: Draft[] = [];
  private current: Draft | null = null;
  private readonly emojis: StoreEmojis;
  private readonly headingWorst: Record<StoreKind, number>;

  constructor(storeEmojis?: StoreEmojis) {
    this.emojis = resolveStoreEmojis(storeEmojis);
    const worst = {} as Record<StoreKind, number>;
    for (const store of STORE_ORDER) worst[store] = listHeading(store, WORST_COUNT, this.emojis[store] ?? '').length;
    this.headingWorst = worst;
  }

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

  private fitsBlock(start: State, block: Block): boolean {
    let state = start;
    for (const line of block.lines) {
      const next = advance(state, block.store, line.text.length, this.headingWorst[block.store]);
      if (!next) return false;
      state = next.state;
    }
    return true;
  }

  private addLine(store: StoreKind, line: Line): void {
    const worst = this.headingWorst[store];
    let draft = this.open();
    let next = advance(draft.state, store, line.text.length, worst);
    if (!next) {
      this.current = null;
      draft = this.open();
      next = advance(draft.state, store, line.text.length, worst);
    }
    if (!next) throw new Error('render: a single list line exceeds an empty message');
    draft.state = next.state;
    const last = draft.slots[draft.slots.length - 1];
    if (next.appended && last?.kind === 'list') last.lines.push(line);
    else draft.slots.push({ kind: 'list', store, lines: [line] });
  }

  /** Keeps a store together in one message when it fits in one; otherwise fills message after message. */
  addBlock(block: Block): void {
    if (this.current && !this.fitsBlock(this.current.state, block) && this.fitsBlock(EMPTY, block)) this.current = null;
    for (const line of block.lines) this.addLine(block.store, line);
  }

  private listEmbed(slot: { store: StoreKind; lines: Line[] }): DiscordEmbed {
    const count = slot.lines.reduce((sum, line) => sum + line.count, 0);
    const heading = listHeading(slot.store, count, this.emojis[slot.store] ?? '');
    return { description: `${heading}\n${slot.lines.map((line) => line.text).join('\n')}`, color: STORES[slot.store].color };
  }

  private toMessage(draft: Draft, index: number, total: number): DiscordMessage {
    const embeds = draft.slots.map((slot) => (slot.kind === 'embed' ? { ...slot.embed } : this.listEmbed(slot)));
    const last = embeds[embeds.length - 1]!;
    last.fields = [...(last.fields ?? []), { ...PROJECT_FIELD }];
    const page = total > 1 ? `(${index + 1}/${total})` : undefined;
    const footer = [last.footer?.text, page].filter((part): part is string => Boolean(part)).join(FOOTER_SEP);
    if (footer) last.footer = { text: footer };
    return { embeds, allowed_mentions: { parse: [] } };
  }

  finish(): DiscordMessage[] {
    const total = this.drafts.length;
    return this.drafts.map((draft, index) => this.toMessage(draft, index, total));
  }
}
