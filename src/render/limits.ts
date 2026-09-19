// SPDX-License-Identifier: AGPL-3.0-or-later
import { DISCORD } from '../core/constants.ts';
import type { DiscordEmbed, DiscordMessage } from '../core/types.ts';

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

/** Returns every violated Discord limit; empty means the message is acceptable. */
export function assertWithinLimits(msg: DiscordMessage): string[] {
  const errors: string[] = [];
  const over = (label: string, actual: number, max: number): void => {
    if (actual > max) errors.push(`${label}: ${actual} > ${max}`);
  };

  const embeds = msg.embeds ?? [];
  over('content', msg.content?.length ?? 0, DISCORD.contentMax);
  over('embeds', embeds.length, DISCORD.embedsPerMessage);
  over('total embed text', measureMessage(msg), DISCORD.embedTotalTextMax);
  if (embeds.length === 0 && !msg.content) errors.push('message has neither content nor embeds');
  if (msg.allowed_mentions?.parse?.length !== 0) errors.push('allowed_mentions.parse must be []');

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
