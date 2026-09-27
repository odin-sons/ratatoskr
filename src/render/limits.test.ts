// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DISCORD } from '../core/constants.ts';
import type { DiscordContainer, DiscordLinkButton, DiscordMessage, DiscordTopComponent } from '../core/types.ts';
import { makeEvent, NOW } from './__fixtures__/events.ts';
import { renderImmediate } from './index.ts';
import { assertWithinLimits, componentCount, componentText } from './limits.ts';

const PAGE = 'https://thunderstore.io/c/valheim/p/Bob/Alpha/';
const button = (over: Partial<DiscordLinkButton> = {}): DiscordLinkButton => ({ type: 2, style: 5, label: 'Mod page', url: PAGE, ...over });

describe('assertWithinLimits on classic link buttons', () => {
  const base = { embeds: [{ description: 'x' }], allowed_mentions: { parse: [] as [] } };

  it('accepts a valid row', () => {
    expect(assertWithinLimits({ ...base, components: [{ type: 1, components: [button()] }] })).toEqual([]);
  });

  it('reports too many buttons, over-long labels and urls, empty rows and non-http urls', () => {
    const tooMany = { ...base, components: [{ type: 1 as const, components: Array.from({ length: 6 }, () => button()) }] };
    expect(assertWithinLimits(tooMany).join()).toContain('components[0].components: 6 > 5');
    expect(assertWithinLimits({ ...base, components: [{ type: 1, components: [button({ label: 'x'.repeat(81) })] }] }).join()).toContain('label: 81 > 80');
    expect(assertWithinLimits({ ...base, components: [{ type: 1, components: [button({ url: `https://a.io/${'x'.repeat(600)}` })] }] }).join()).toContain('url: 613 > 512');
    expect(assertWithinLimits({ ...base, components: [{ type: 1, components: [] }] }).join()).toContain('is empty');
    expect(assertWithinLimits({ ...base, components: [{ type: 1, components: [button({ url: 'javascript:1' })] }] }).join()).toContain('must be http(s)');
    expect(assertWithinLimits({ ...base, components: Array.from({ length: 6 }, () => ({ type: 1 as const, components: [button()] })) }).join()).toContain('components: 6 > 5');
  });

  it('rejects a container without the Components V2 flag and an empty emoji name', () => {
    const container: DiscordContainer = { type: 17, components: [{ type: 10, content: 'x' }] };
    expect(assertWithinLimits({ ...base, components: [container] }).join()).toContain('needs the Components V2 flag');
    expect(assertWithinLimits({ ...base, components: [{ type: 1, components: [button({ emoji: { name: '' } })] }] }).join()).toContain('emoji.name is empty');
  });
});

describe('assertWithinLimits on Components V2 messages', () => {
  const v2 = (components: DiscordTopComponent[], extra: Partial<DiscordMessage> = {}): DiscordMessage => ({
    flags: DISCORD.componentsV2Flag,
    allowed_mentions: { parse: [] },
    components,
    ...extra,
  });
  const text = (content: string) => ({ type: 10 as const, content });
  const container = (...components: DiscordContainer['components']): DiscordContainer => ({ type: 17, components });

  it('accepts what the renderer produces', () => {
    const msg = renderImmediate(makeEvent({ kind: 'new', description: 'd', changelog: '- x', categories: ['A'], downloadUrl: 'https://x.io/d' }), { now: NOW });
    expect(assertWithinLimits(msg)).toEqual([]);
    expect(componentCount(msg)).toBeLessThanOrEqual(DISCORD.componentsV2ComponentsMax);
    expect(componentText(msg)).toBeGreaterThan(0);
  });

  it('counts every nested component, thumbnail and button included, and the text of every display', () => {
    const msg = v2([
      container(
        { type: 9, components: [text('abc'), text('de')], accessory: { type: 11, media: { url: PAGE } } },
        { type: 14, divider: true, spacing: 1 },
        { type: 1, components: [button(), button()] },
      ),
    ]);
    expect(componentCount(msg)).toBe(1 + 1 + 2 + 1 + 1 + 1 + 2);
    expect(componentText(msg)).toBe(5);
  });

  it('reports content or embeds next to the flag, and a message without components', () => {
    expect(assertWithinLimits(v2([container(text('x'))], { content: 'hi' })).join()).toContain('must not have content or embeds');
    expect(assertWithinLimits(v2([container(text('x'))], { embeds: [{ description: 'x' }] })).join()).toContain('must not have content or embeds');
    expect(assertWithinLimits(v2([])).join()).toContain('no components');
  });

  it('reports more than 40 components and more than 4000 characters of text', () => {
    expect(assertWithinLimits(v2([container(...Array.from({ length: 40 }, () => text('x')))])).join()).toContain('components (total): 41 > 40');
    expect(assertWithinLimits(v2([container(text('x'.repeat(2500)), text('y'.repeat(2500)))])).join()).toContain('text displays: 5000 > 4000');
    expect(assertWithinLimits(v2([container(text('x'.repeat(4001)))])).join()).toContain('text display: 4001 > 4000');
    expect(assertWithinLimits(v2([container(text('x'.repeat(4000)))]))).toEqual([]);
  });

  it('reports empty text displays, empty containers, bad sections and non-http thumbnails', () => {
    expect(assertWithinLimits(v2([container(text('   '))])).join()).toContain('text display is empty');
    expect(assertWithinLimits(v2([container()])).join()).toContain('container is empty');
    expect(assertWithinLimits(v2([container({ type: 9, components: [], accessory: { type: 11, media: { url: PAGE } } })])).join()).toContain('section needs one to three');
    expect(assertWithinLimits(v2([container({ type: 9, components: [text('x')], accessory: { type: 11, media: { url: 'javascript:1' } } })])).join()).toContain('thumbnail url must be http(s)');
  });

  it('checks the buttons of a row inside a container', () => {
    const errors = assertWithinLimits(v2([container(text('x'), { type: 1, components: [button({ label: 'x'.repeat(81), url: 'ftp://a.io/x' })] })])).join();
    expect(errors).toContain('label: 81 > 80');
    expect(errors).toContain('must be http(s)');
  });

  it('demands allowed_mentions.parse to be empty', () => {
    const msg = { ...v2([container(text('x'))]), allowed_mentions: { parse: ['everyone'] } } as unknown as DiscordMessage;
    expect(assertWithinLimits(msg).join()).toContain('allowed_mentions.parse must be []');
  });
});
