// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDigest, renderImmediate } from '../render/index.ts';
import { FIXED_NOW_ISO, makeBotSubscription, makeEvent, makeSubscription } from '../testing/fakes.ts';
import { makeHarness, type Harness } from '../testing/harness.ts';
import { drainOutbox } from './drain.ts';
import { outboxId } from './ids.ts';
import type { DiscordContainer, DiscordMessage, ModEvent, Subscription, TemplateKind } from './types.ts';

const now = new Date(FIXED_NOW_ISO);
const SOURCE = 'thunderstore:valheim';

const mod = (name: string, kind: 'new' | 'update' = 'update'): ModEvent =>
  makeEvent({
    kind,
    versionFrom: kind === 'update' ? '1.0.0' : null,
    versionTo: '2.0.0',
    pkg: { owner: 'Owner', name, packageId: `Owner-${name}`, url: `https://example.com/${name}`, downloadUrl: `https://example.com/${name}/dl` },
  });

async function queue(h: Harness, sub: Subscription, events: ModEvent[]): Promise<void> {
  h.store.addSubscription(sub);
  await h.store.commit({
    source: SOURCE,
    packages: events.map((e) => e.pkg),
    events,
    outbox: events.map((e) => ({ id: outboxId(sub.id, e.id), subscriptionId: sub.id, eventId: e.id, attempts: 0, nextAttemptAt: FIXED_NOW_ISO })),
    state: { id: SOURCE, cursor: null, etag: null, bootstrapped: true, lastOkAt: null },
  });
}

const template = (subscriptionId: string, kind: TemplateKind, body: string) => ({ subscriptionId, kind, body, updatedAt: FIXED_NOW_ISO });
const drain = (h: Harness) => drainOutbox({ store: h.store, sender: h.sender, renderer: { renderDigest, renderImmediate }, now });

const texts = (message: DiscordMessage): string[] =>
  (message.components![0] as DiscordContainer).components.flatMap((child) => (child.type === 10 ? [child.content] : child.type === 9 ? child.components.map((c) => c.content) : []));
const embedText = (message: DiscordMessage): string => (message.embeds ?? []).map((e) => `${e.description ?? ''}\n${(e.fields ?? []).map((f) => f.value).join('\n')}`).join('\n');

let warnings: string[];
beforeEach(() => {
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void warnings.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

describe('drainOutbox: message templates', () => {
  it('sends an immediate message from the template of its subscription', async () => {
    const h = makeHarness();
    await queue(h, makeSubscription({ id: 'a', mode: 'immediate' }), [mod('Alpha')]);
    await h.store.setTemplate(template('a', 'immediate', '{name} -> {version}'));
    await drain(h);
    expect(texts(h.sender.calls[0]!.payload)).toEqual(['Alpha -> 2.0.0']);
  });

  it('renders as before for a subscription without a template', async () => {
    const h = makeHarness();
    await queue(h, makeSubscription({ id: 'a', mode: 'immediate' }), [mod('Alpha')]);
    await drain(h);
    const plain = h.sender.calls[0]!.payload;
    expect(texts(plain)[0]).toContain('## ');
    expect(texts(plain)[0]).toContain('Alpha');
  });

  it('does not apply the template of one subscription to another', async () => {
    const h = makeHarness();
    await queue(h, makeSubscription({ id: 'a', mode: 'immediate', webhookUrl: 'https://discord.com/api/webhooks/1/aaa' }), [mod('Alpha')]);
    await queue(h, makeSubscription({ id: 'b', mode: 'immediate', webhookUrl: 'https://discord.com/api/webhooks/2/bbb' }), [mod('Alpha')]);
    await h.store.setTemplate(template('a', 'immediate', 'custom {name}'));
    await drain(h);
    const byHook = new Map(h.sender.calls.map((c) => [c.webhookUrl, texts(c.payload)[0]]));
    expect(byHook.get('https://discord.com/api/webhooks/1/aaa')).toBe('custom Alpha');
    expect(byHook.get('https://discord.com/api/webhooks/2/bbb')).toContain('## ');
  });

  it('works for a bot subscription too, with the digest template ignored in immediate mode', async () => {
    const h = makeHarness();
    await queue(h, makeBotSubscription({ id: 'bot', mode: 'immediate' }), [mod('Alpha')]);
    await h.store.setTemplate(template('bot', 'immediate', 'bot {name}'));
    await h.store.setTemplate(template('bot', 'digest_line', 'ignored {name}'));
    await drain(h);
    expect(texts(h.sender.calls[0]!.payload)).toEqual(['bot Alpha']);
  });

  it('falls back to the default message when the template shows nothing, and says so once for the run', async () => {
    const h = makeHarness();
    await queue(h, makeSubscription({ id: 'a', mode: 'immediate' }), [mod('Alpha'), mod('Beta')]);
    await h.store.setTemplate(template('a', 'immediate', '{nothing}'));
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 2, failed: 0 });
    for (const call of h.sender.calls) expect(texts(call.payload)[0]).toContain('## ');
    expect(warnings.filter((line) => line.includes('template'))).toEqual(['outbox template fell back to the default']);
  });

  it('asks the store for the templates once per run, only for the subscriptions it serves', async () => {
    const h = makeHarness();
    await queue(h, makeSubscription({ id: 'a', mode: 'immediate' }), [mod('Alpha'), mod('Beta')]);
    await queue(h, makeBotSubscription({ id: 'bot', mode: 'digest' }), [mod('Gamma')]);
    const asked: string[][] = [];
    const original = h.store.getTemplates.bind(h.store);
    h.store.getTemplates = async (ids: string[]) => {
      asked.push([...ids].sort());
      return original(ids);
    };
    await drain(h);
    expect(asked).toEqual([['a', 'bot']]);
  });

  it('delivers with the default messages when the templates cannot be read, and says so', async () => {
    const h = makeHarness();
    await queue(h, makeSubscription({ id: 'a', mode: 'immediate' }), [mod('Alpha')]);
    await h.store.setTemplate(template('a', 'immediate', 'custom {name}'));
    h.store.getTemplates = async () => {
      throw new Error('D1 is down');
    };
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 1, failed: 0 });
    expect(texts(h.sender.calls[0]!.payload)[0]).toContain('## ');
    expect(warnings).toContain('outbox templates could not be read');
  });

  it('keeps the template when the message is sent again without optional buttons after a 400', async () => {
    const h = makeHarness();
    await queue(h, makeSubscription({ id: 'a', mode: 'immediate' }), [mod('Alpha')]);
    await h.store.setTemplate(template('a', 'immediate', '{name}\n---\n{buttons}'));
    h.sender.enqueue({ ok: false, retryable: false, status: 400 });
    const report = await drain(h);
    expect(report).toMatchObject({ sent: 1, parked: 0 });
    const rows = (message: DiscordMessage) => ((message.components![0] as DiscordContainer).components.at(-1) as { components: unknown[] }).components;
    expect(rows(h.sender.calls[0]!.payload)).toHaveLength(2);
    expect(rows(h.sender.calls[1]!.payload)).toHaveLength(1);
    expect(texts(h.sender.calls[1]!.payload)).toEqual(['Alpha']);
  });

  it('puts the digest line template into the list of a digest', async () => {
    const h = makeHarness();
    await queue(h, makeSubscription({ id: 'd', mode: 'digest' }), [mod('Alpha'), mod('Beta')]);
    await h.store.setTemplate(template('d', 'digest_line', '{name} => {version}'));
    await drain(h);
    const text = h.sender.calls.map((c) => embedText(c.payload)).join('\n');
    expect(text).toContain('Alpha => 2.0.0');
    expect(text).toContain('Beta => 2.0.0');
  });

  it('lists every mod of a digest even when the line template is longer than a line may be', async () => {
    const h = makeHarness();
    await queue(h, makeSubscription({ id: 'd', mode: 'digest' }), [mod('Alpha'), mod('Beta')]);
    await h.store.setTemplate(template('d', 'digest_line', `${'x'.repeat(700)} {name}`));
    await drain(h);
    const text = h.sender.calls.map((c) => embedText(c.payload)).join('\n');
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
  });
});
