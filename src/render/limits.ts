// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD } from '../core/constants.ts';
import type { DiscordActionRow, DiscordContainer, DiscordEmbed, DiscordLinkButton, DiscordMessage, DiscordThumbnail, DiscordTopComponent } from '../core/types.ts';

type Nested = DiscordTopComponent | DiscordContainer['components'][number];

export function measureEmbed(embed: DiscordEmbed): number {
  let total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
  for (const field of embed.fields ?? []) total += field.name.length + field.value.length;
  total += (embed.footer?.text.length ?? 0) + (embed.author?.name.length ?? 0);
  return total;
}

/** Sum of the text Discord counts against the per-message embed budget. */
export function measureMessage(msg: DiscordMessage): number {
  let total = 0;
  for (const embed of msg.embeds ?? []) total += measureEmbed(embed);
  return total;
}

type Visited = Nested | DiscordLinkButton | DiscordThumbnail;

function walk(components: readonly Nested[], visit: (component: Visited) => void): void {
  for (const component of components) {
    visit(component);
    if (component.type === 1) for (const button of component.components) visit(button);
    else if (component.type === 17) walk(component.components, visit);
    else if (component.type === 9) {
      walk(component.components, visit);
      visit(component.accessory);
    }
  }
}

/** Every component of a message, nested ones included, as Discord counts them against the per-message maximum. */
export function componentCount(msg: DiscordMessage): number {
  let n = 0;
  walk(msg.components ?? [], () => {
    n += 1;
  });
  return n;
}

/** Total length of the text displays of a message, which Discord caps for a Components V2 message. */
export function componentText(msg: DiscordMessage): number {
  let n = 0;
  walk(msg.components ?? [], (component) => {
    if (component.type === 10) n += component.content.length;
  });
  return n;
}

/** Returns every violated Discord limit; empty means the message is acceptable. */
export function assertWithinLimits(msg: DiscordMessage): string[] {
  const errors: string[] = [];
  const over = (label: string, actual: number, max: number): void => {
    if (actual > max) errors.push(`${label}: ${actual} > ${max}`);
  };
  const isV2 = msg.flags !== undefined && (msg.flags & DISCORD.componentsV2Flag) !== 0;

  const embeds = msg.embeds ?? [];
  over('content', msg.content?.length ?? 0, DISCORD.contentMax);
  over('embeds', embeds.length, DISCORD.embedsPerMessage);
  over('total embed text', measureMessage(msg), DISCORD.embedTotalTextMax);
  if (msg.allowed_mentions?.parse?.length !== 0) errors.push('allowed_mentions.parse must be []');
  const top = msg.components ?? [];
  if (isV2) {
    if (msg.content !== undefined || msg.embeds !== undefined) errors.push('a Components V2 message must not have content or embeds');
    if (top.length === 0) errors.push('a Components V2 message has no components');
    checkV2(msg, over, errors);
  } else {
    if (embeds.length === 0 && !msg.content) errors.push('message has neither content nor embeds');
    over('components', top.length, DISCORD.actionRowsPerMessage);
    top.forEach((row, i) => {
      if (row.type === 1) checkRow(`components[${i}]`, row, over, errors);
      else errors.push(`components[${i}] needs the Components V2 flag`);
    });
  }
  embeds.forEach((embed, i) => {
    const at = `embeds[${i}]`;
    over(`${at}.title`, embed.title?.length ?? 0, DISCORD.embedTitleMax);
    over(`${at}.description`, embed.description?.length ?? 0, DISCORD.embedDescriptionMax);
    over(`${at}.footer.text`, embed.footer?.text.length ?? 0, DISCORD.embedFooterTextMax);
    over(`${at}.author.name`, embed.author?.name.length ?? 0, DISCORD.embedAuthorNameMax);
    const fields = embed.fields ?? [];
    over(`${at}.fields`, fields.length, DISCORD.embedFieldsMax);
    fields.forEach((field, j) => {
      over(`${at}.fields[${j}].name`, field.name.length, DISCORD.embedFieldNameMax);
      over(`${at}.fields[${j}].value`, field.value.length, DISCORD.embedFieldValueMax);
      if (field.name.length === 0 || field.value.length === 0) errors.push(`${at}.fields[${j}] is empty`);
    });
  });
  return errors;
}

function checkRow(at: string, row: DiscordActionRow, over: (label: string, actual: number, max: number) => void, errors: string[]): void {
  over(`${at}.components`, row.components.length, DISCORD.buttonsPerRow);
  if (row.components.length === 0) errors.push(`${at} is empty`);
  row.components.forEach((button, j) => {
    const where = `${at}.components[${j}]`;
    over(`${where}.label`, button.label.length, DISCORD.buttonLabelMax);
    over(`${where}.url`, button.url.length, DISCORD.buttonUrlMax);
    if (button.label.length === 0) errors.push(`${where}.label is empty`);
    if (!/^https?:\/\//.test(button.url)) errors.push(`${where}.url must be http(s)`);
    if (button.emoji !== undefined && button.emoji.name.length === 0) errors.push(`${where}.emoji.name is empty`);
  });
}

function checkV2(msg: DiscordMessage, over: (label: string, actual: number, max: number) => void, errors: string[]): void {
  over('components (total)', componentCount(msg), DISCORD.componentsV2ComponentsMax);
  over('text displays', componentText(msg), DISCORD.componentsV2TextMax);
  walk(msg.components ?? [], (component) => {
    switch (component.type) {
      case 10:
        if (component.content.trim().length === 0) errors.push('a text display is empty');
        over('text display', component.content.length, DISCORD.componentsV2TextMax);
        break;
      case 9:
        if (component.components.length < 1 || component.components.length > 3) errors.push('a section needs one to three text displays');
        break;
      case 1:
        checkRow('action row', component, over, errors);
        break;
      case 11:
        if (!/^https?:\/\//.test(component.media.url)) errors.push('a thumbnail url must be http(s)');
        break;
      case 17:
        if (component.components.length === 0) errors.push('a container is empty');
        break;
      default:
        break;
    }
  });
}
