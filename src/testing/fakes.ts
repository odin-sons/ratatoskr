// SPDX-License-Identifier: AGPL-3.0-or-later
import { eventId } from '../core/ids.ts';
import type { Renderer, RenderContext } from '../core/drain.ts';
import type { Language } from '../i18n/index.ts';
import type { Clock, PollContext, PollResult, SendResult, Sender, SourceAdapter } from '../core/ports.ts';
import type {
  AppConfig,
  CapUsage,
  DiscordMessage,
  ModEvent,
  PackageSnapshot,
  SourceConfig,
  StoreEmojis,
  StoreKind,
  Subscription,
} from '../core/types.ts';

export const FIXED_NOW_ISO = '2026-09-19T12:07:00.000Z';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export class FakeClock implements Clock {
  private ms: number;

  constructor(iso: string = FIXED_NOW_ISO) {
    this.ms = Date.parse(iso);
  }

  now(): Date {
    return new Date(this.ms);
  }

  set(iso: string): void {
    this.ms = Date.parse(iso);
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

export function fixedClock(iso: string = FIXED_NOW_ISO): Clock {
  return { now: () => new Date(iso) };
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

export interface SentCall {
  webhookUrl: string;
  payload: DiscordMessage;
  threadId?: string | null;
}

export const SEND_OK: SendResult = { ok: true };
export const rateLimited = (retryAfterSeconds: number | null): SendResult => ({
  ok: false,
  retryable: true,
  retryAfterSeconds,
  status: 429,
});
export const serverError = (status = 500): SendResult => ({ ok: false, retryable: true, retryAfterSeconds: null, status });
export const clientError = (status = 404): SendResult => ({ ok: false, retryable: false, status });

/** Records every call. Scripted results are consumed in order; once empty, `fallback` applies. */
export class FakeSender implements Sender {
  readonly calls: SentCall[] = [];
  /** Includes failed attempts; results returned so far. */
  readonly results: SendResult[] = [];
  private queue: SendResult[] = [];
  fallback: (call: SentCall, index: number) => SendResult = () => SEND_OK;

  enqueue(...results: SendResult[]): this {
    this.queue.push(...results);
    return this;
  }

  async send(webhookUrl: string, payload: DiscordMessage, threadId?: string | null): Promise<SendResult> {
    const call = { webhookUrl, payload, threadId };
    const index = this.calls.length;
    this.calls.push(call);
    const result = this.queue.shift() ?? this.fallback(call, index);
    this.results.push(result);
    return result;
  }

  callsTo(webhookUrl: string): SentCall[] {
    return this.calls.filter((c) => c.webhookUrl === webhookUrl);
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type PollScript = PollResult | Error | ((ctx: PollContext) => PollResult);

export interface ChangelogResult {
  excerpt: string | null;
  url: string | null;
  websiteUrl?: string | null;
}

/** Scripted `SourceAdapter`. `poll` consumes one script entry per call and returns `skipped` once empty. */
export class FakeAdapter implements SourceAdapter {
  readonly config: SourceConfig;
  readonly pollCalls: PollContext[] = [];
  readonly reconcileCalls: PollContext[] = [];
  readonly changelogCalls: { pkg: PackageSnapshot; version: string }[] = [];
  detailRequests?: number;
  private script: PollScript[] = [];
  reconcileResult: PackageSnapshot[] | Error | null = null;
  changelog: (pkg: PackageSnapshot, version: string) => ChangelogResult | Error = (pkg, version) => ({
    excerpt: `changelog ${pkg.packageId} ${version}`,
    url: `${pkg.url}changelog/`,
  });
  reconcile?: (ctx: PollContext) => Promise<PackageSnapshot[]>;

  constructor(config: Partial<SourceConfig> & { id: string }, opts: { reconcilable?: boolean } = {}) {
    const store = (config.store ?? (config.id.split(':')[0] as StoreKind));
    this.config = { store, community: 'valheim', enabled: true, ...config };
    if (opts.reconcilable) {
      this.reconcile = async (ctx) => {
        this.reconcileCalls.push(ctx);
        if (this.reconcileResult instanceof Error) throw this.reconcileResult;
        return this.reconcileResult ?? [];
      };
    }
  }

  enqueue(...results: PollScript[]): this {
    this.script.push(...results);
    return this;
  }

  async poll(ctx: PollContext): Promise<PollResult> {
    this.pollCalls.push(ctx);
    const next = this.script.shift();
    if (next === undefined) return { status: 'skipped' };
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(ctx) : next;
  }

  async fetchChangelog(_ctx: PollContext, pkg: PackageSnapshot, version: string): Promise<ChangelogResult> {
    this.changelogCalls.push({ pkg, version });
    const result = this.changelog(pkg, version);
    if (result instanceof Error) throw result;
    return result;
  }
}

export function okPoll(
  packages: PackageSnapshot[],
  extra: { cursor?: string | null; etag?: string | null; complete?: boolean; warnings?: string[]; capUsage?: CapUsage[] } = {},
): PollResult {
  return {
    status: 'ok',
    packages,
    cursor: extra.cursor ?? null,
    etag: extra.etag ?? null,
    complete: extra.complete ?? true,
    ...(extra.warnings === undefined ? {} : { warnings: extra.warnings }),
    ...(extra.capUsage === undefined ? {} : { capUsage: extra.capUsage }),
  };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/** One message per digest (or per `perMessage` events); content lists event ids so tests can assert contents. */
export class FakeRenderer implements Renderer {
  readonly digestCalls: {
    events: ModEvent[];
    detailed: boolean[];
    storeEmojis: StoreEmojis | undefined;
    ratatoskrEmoji: string | undefined;
    locale: Language | undefined;
  }[] = [];
  readonly immediateCalls: ModEvent[] = [];
  /** Emoji option received by each `renderImmediate` call, in call order. */
  readonly immediateEmojis: (StoreEmojis | undefined)[] = [];
  /** Source-button emoji and language received by each `renderImmediate` call, in call order. */
  readonly immediateSettings: { ratatoskrEmoji: string | undefined; locale: Language | undefined }[] = [];
  perMessage = Number.POSITIVE_INFINITY;

  renderDigest(events: ModEvent[], opts: { detailed: (e: ModEvent) => boolean; now: Date } & RenderContext): DiscordMessage[] {
    this.digestCalls.push({
      events,
      detailed: events.map((e) => opts.detailed(e)),
      storeEmojis: opts.storeEmojis,
      ratatoskrEmoji: opts.ratatoskrEmoji,
      locale: opts.locale,
    });
    const messages: DiscordMessage[] = [];
    const size = Math.max(1, Math.min(this.perMessage, events.length));
    for (let i = 0; i < events.length; i += size) {
      messages.push({
        content: `digest:${events.slice(i, i + size).map((e) => e.id).join(',')}`,
        allowed_mentions: { parse: [] },
      });
    }
    return messages;
  }

  renderImmediate(event: ModEvent, opts?: { now: Date } & RenderContext): DiscordMessage {
    this.immediateCalls.push(event);
    this.immediateEmojis.push(opts?.storeEmojis);
    this.immediateSettings.push({ ratatoskrEmoji: opts?.ratatoskrEmoji, locale: opts?.locale });
    return { content: `immediate:${event.id}`, allowed_mentions: { parse: [] } };
  }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function makeSnapshot(overrides: Partial<PackageSnapshot> = {}): PackageSnapshot {
  const store: StoreKind = overrides.store ?? (overrides.source?.split(':')[0] as StoreKind | undefined) ?? 'thunderstore';
  const source = overrides.source ?? `${store}:valheim`;
  const owner = overrides.owner ?? 'Owner';
  const name = overrides.name ?? 'Mod';
  const packageId = overrides.packageId ?? `${owner}-${name}`;
  return {
    version: '1.0.0',
    url: `https://${store}.invalid/${packageId}/`,
    iconUrl: null,
    description: null,
    categories: [],
    isNsfw: false,
    isDeprecated: false,
    updatedAt: '2026-09-19T11:00:00.000Z',
    sizeBytes: null,
    ...overrides,
    source,
    store,
    packageId,
    owner,
    name,
  };
}

export function makeEvent(overrides: Partial<Omit<ModEvent, 'pkg'>> & { pkg?: Partial<PackageSnapshot> } = {}): ModEvent {
  const { pkg: pkgOverrides, ...rest } = overrides;
  const versionTo = rest.versionTo ?? pkgOverrides?.version ?? '1.0.0';
  const pkg = makeSnapshot({ ...pkgOverrides, version: versionTo });
  return {
    id: eventId(pkg.source, pkg.packageId, versionTo),
    kind: 'new',
    versionFrom: null,
    versionTo,
    changelog: null,
    changelogUrl: null,
    createdAt: FIXED_NOW_ISO,
    alsoOn: [],
    ...rest,
    pkg,
  };
}

export function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-1',
    guildId: 'guild-1',
    webhookUrl: 'https://discord.invalid/api/webhooks/1/token',
    filter: {},
    mode: 'immediate',
    digestIntervalMin: 30,
    enabled: true,
    ...overrides,
  };
}

export function makeConfig(sources: SourceConfig[] = []): AppConfig {
  return { sources, userAgent: 'ratatoskr-test/0.0.0 (+https://example.invalid)' };
}
