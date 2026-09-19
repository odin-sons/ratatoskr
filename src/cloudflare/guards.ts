// SPDX-License-Identifier: AGPL-3.0-or-later

const WEBHOOK_HOSTS: ReadonlySet<string> = new Set([
  'discord.com',
  'discordapp.com',
  'canary.discord.com',
  'ptb.discord.com',
]);

const WEBHOOK_PATH = /^\/api(?:\/v\d+)?\/webhooks\/(\d{17,20})\/([\w-]{1,256})$/;

export function isSnowflake(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}

/** Returns the webhook id segment, or null when `url` is not a Discord webhook URL. */
export function parseDiscordWebhookUrl(url: string): { id: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !WEBHOOK_HOSTS.has(parsed.hostname)) return null;
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return null;
  const match = WEBHOOK_PATH.exec(parsed.pathname);
  const id = match?.[1];
  return id !== undefined && isSnowflake(id) ? { id } : null;
}

export function isDiscordWebhookUrl(url: string): boolean {
  return parseDiscordWebhookUrl(url) !== null;
}
