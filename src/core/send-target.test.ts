// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { targetKey } from './send-target.ts';

describe('targetKey', () => {
  it('keys a webhook target by its url, ignoring the thread', () => {
    expect(targetKey({ kind: 'webhook', url: 'https://discord.com/api/webhooks/1/a' })).toBe('https://discord.com/api/webhooks/1/a');
    expect(targetKey({ kind: 'webhook', url: 'https://discord.com/api/webhooks/1/a', threadId: '5' })).toBe('https://discord.com/api/webhooks/1/a');
  });

  it('keys a bot target by its channel id, ignoring the thread', () => {
    const a = targetKey({ kind: 'bot', channelId: '123456789012345678' });
    expect(targetKey({ kind: 'bot', channelId: '123456789012345678', threadId: '223456789012345678' })).toBe(a);
    expect(targetKey({ kind: 'bot', channelId: '323456789012345678' })).not.toBe(a);
  });

  it('never collides between kinds', () => {
    expect(targetKey({ kind: 'bot', channelId: '1' })).not.toBe(targetKey({ kind: 'webhook', url: '1' }));
  });
});
