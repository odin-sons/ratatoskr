# ratatoskr

A Discord bot that reports new and updated game mods from Thunderstore, Hexium
and Nexus Mods. It runs entirely on the Cloudflare Workers free plan, triggered
by cron, with no inbound HTTP routes. Each operator deploys their own instance
for their own game (primary target: Valheim).

Named after the squirrel that carries messages up and down Yggdrasil.

## Disclaimers

- **Unofficial.** ratatoskr is an independent project. It is not affiliated
  with, endorsed by, or sponsored by Thunderstore, Hexium or Nexus Mods. All
  names belong to their respective owners.
- **Licence.** AGPL-3.0-or-later; see [LICENSE](LICENSE). The AGPL network
  clause applies to a running instance: users of your deployment must be able to
  obtain its source. Messages posted by the bot carry a link to the source
  repository: <https://github.com/odin-sons/ratatoskr>. If you modify the code,
  publish your modified source.
- **Nexus Mods.** The Nexus source is optional and **disabled by default**. It
  requires your own personal Nexus API key, supplied as a Worker secret; no key
  is ever shipped in this repository, and there is no hosted instance. Personal
  keys are intended for personal use and testing. You are responsible for
  complying with the
  [Nexus Mods API Acceptable Use Policy](https://help.nexusmods.com/article/114-api-acceptable-use-policy),
  including registering your application with Nexus if your use falls outside
  what the policy allows for personal keys. See [docs/legal.md](docs/legal.md).
- **You are responsible for your deployment.** The operator is responsible for
  what their instance posts and where it posts it, and for complying with the
  terms of Discord, Cloudflare and each upstream service.
- **NSFW filtering.** Content flagged as adult or NSFW by any upstream is
  excluded by default. A subscription must explicitly opt in with
  `"allowNsfw": true`.
- Mod content (names, descriptions, changelogs, icons) belongs to the mod
  authors. The bot posts short excerpts and links to the original; it does not
  proxy or mirror downloads.

## What it does

Every 5 minutes a cron trigger polls the enabled sources once per deployment
(never per guild), detects new packages and version changes, and delivers them
to Discord webhooks according to each subscription's filter. Delivery is either
`immediate` or a periodic `digest` (default every 30 minutes). Digests never
drop a mod: detail is reduced before messages are split.

| Source | Detects new | Detects updates |
|---|---|---|
| Thunderstore | yes | yes |
| Hexium | yes | yes, with up to ~15 minutes of extra latency |
| Nexus Mods (optional) | yes | yes |

The first run for each source only records current state and posts nothing.

## Architecture

A cron-triggered Worker reads each source's listing, diffs it against state in
D1, writes events and outbox rows in one transaction together with the source
cursor, then drains the outbox to Discord within a per-tick budget. The core
(diff, matcher, renderer) is platform-agnostic; Cloudflare specifics live in an
adapter layer. Details: [docs/spec.md](docs/spec.md). Verified upstream
endpoints: [docs/api-notes.md](docs/api-notes.md).

### Quota footprint

Estimated at 800 events/day and two guilds (from [docs/spec.md](docs/spec.md)):

| Resource | Free limit | Used | Share |
|---|---|---|---|
| Worker requests | 100,000/day | 288 | 0.3 % |
| D1 rows written | 100,000/day | ~4,000 | 4 % |
| D1 rows read | 5,000,000/day | ~50,000 | 1 % |
| External subrequests | 50/invocation | <= 21 | n/a |

The binding limit is the 10 ms CPU budget per invocation, not quotas.

## Setup

Requirements: a Cloudflare account, Node.js 24, pnpm.

**Deploy to Cloudflare button.** The one-click button needs a public repository
URL. This repository is currently private; once it is public, the button will
be `https://deploy.workers.cloudflare.com/?url=https://github.com/odin-sons/ratatoskr`.
Until then, use the manual steps below.

1. Fork or clone the repository and install dependencies.

   ```sh
   pnpm install
   ```

2. Create the D1 database and copy the printed `database_id` into
   `wrangler.jsonc`.

   ```sh
   wrangler d1 create ratatoskr
   ```

3. Apply the schema to the remote database.

   ```sh
   wrangler d1 execute ratatoskr --remote --file=./schema.sql
   ```

   Upgrading an existing database: apply the files in `migrations/` you have not
   applied yet, in order, before `schema.sql`
   (`wrangler d1 execute ratatoskr --remote --file=./migrations/0001_outbox_delivered_at.sql`).
   A database created from the current `schema.sql` needs none of them.

4. Review `ratatoskr.config.json` (sources, game, User-Agent) and validate it.

   ```sh
   pnpm validate-config
   ```

5. Create a Discord webhook (channel settings, Integrations, Webhooks) and add
   a subscription. The script prints the `wrangler d1 execute` command; it does
   not run it. Review the output, then run it.

   ```sh
   export DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/<id>/<token>'
   pnpm add-subscription --guild-id <guild id> --webhook-url-env DISCORD_WEBHOOK_URL
   ```

   The webhook URL is a credential: anyone holding it can post to the channel.
   Passing it with `--webhook-url` leaves it in your shell history, so prefer
   `--webhook-url-env`. It is also stored in D1 in plain text and appears in the
   printed command.

6. Only if you enable Nexus (see the disclaimer above): set
   `"enabled": true` on the `nexus:*` source in `ratatoskr.config.json` and store
   your personal key.

   ```sh
   wrangler secret put NEXUS_API_KEY
   ```

7. Deploy. Use `pnpm run deploy`; plain `pnpm deploy` is a different, built-in
   pnpm command.

   ```sh
   pnpm run deploy
   ```

## Configuration

### `ratatoskr.config.json`

Deployment-wide settings, validated at build time (`pnpm validate-config`, run
in CI) and not bundled into the Worker.

```json
{
  "userAgent": "ratatoskr/0.1.0 (+https://github.com/odin-sons/ratatoskr; unofficial mod notifier)",
  "sources": [
    { "id": "thunderstore:valheim", "store": "thunderstore", "community": "valheim", "enabled": true },
    { "id": "hexium:valheim", "store": "hexium", "community": "valheim", "enabled": true },
    { "id": "nexus:valheim", "store": "nexus", "community": "valheim", "enabled": false }
  ]
}
```

- `userAgent`: sent to every upstream. Keep the project name, version and a
  repository URL; if you fork, point it at your fork and add a contact route.
- `sources[].id`: must be `<store>:<community>`.
- `sources[].store`: `thunderstore`, `hexium` or `nexus`.
- `sources[].community`: Thunderstore community identifier, Hexium game slug,
  or Nexus game domain.
- `sources[].enabled`: Nexus is disabled by default. The validator warns if a
  Nexus source is enabled.

### Subscriptions

Subscriptions live in the D1 `subscriptions` table and are created with
`pnpm add-subscription` (run `pnpm add-subscription --help` for all options).
Delivery options: `--mode immediate|digest` (default `digest`) and
`--interval <minutes>` (5 to 1440, default 30, digest only).

The filter is a JSON object, passed with `--filter '<json>'` or
`--filter-file <path>`. Every field is optional; the empty filter `{}` matches
everything except NSFW content.

| Field | Meaning |
|---|---|
| `sources` | Restrict to these source ids. Absent or empty means all. |
| `kinds` | `"new"`, `"update"`, or both. Absent or empty means both. |
| `allowNsfw` | NSFW content is excluded unless this is exactly `true`. |
| `watchlist` | Case-insensitive full `Owner-Name` package ids or bare owner names. |
| `includeCategories` | Only packages in these categories. |
| `excludeCategories` | Drop packages in these categories. |
| `dedupAcrossStores` | Collapse the same release seen on several stores into one item. Default `true`. |

Examples:

```sh
# Watchlist: only these authors or packages, delivered immediately
pnpm add-subscription --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL \
  --mode immediate \
  --filter '{"watchlist":["Azumatt","RandyKnapp-EpicLoot"]}'

# NSFW opt-in
pnpm add-subscription --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL \
  --filter '{"allowNsfw":true}'

# Digest every 60 minutes, new packages only, Thunderstore only
pnpm add-subscription --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL \
  --mode digest --interval 60 \
  --filter '{"sources":["thunderstore:valheim"],"kinds":["new"]}'
```

## Local development

```sh
pnpm dev          # wrangler dev --test-scheduled
```

Apply the schema to the local database once with
`wrangler d1 execute ratatoskr --local --file=./schema.sql`. With
`--test-scheduled`, wrangler exposes a development-only route that fires the
cron handler; the deployed Worker has no such route.

```sh
curl "http://localhost:8787/__scheduled?cron=*%2F5+*+*+*+*"
```

Other commands:

```sh
pnpm test              # vitest
pnpm typecheck
pnpm validate-config
pnpm check             # all three
```

## Troubleshooting

- **Nothing is posted after the first deploy.** Expected: the first run per
  source records current state only. New and updated mods are posted from the
  second run onward.
- **`pnpm validate-config` fails.** The message names the offending field in
  `ratatoskr.config.json`.
- **`add-subscription` reports an invalid webhook URL.** It must look like
  `https://discord.com/api/webhooks/<numeric id>/<token>`, with no query
  string.
- **Nothing arrives for a subscription.** Check that its filter is not
  excluding everything (for example `kinds` or `watchlist`), that NSFW content
  is not the only thing being reported, and that the row is `enabled`.
- **Updates from Hexium arrive late.** By design: updates to existing Hexium
  packages are detected on a slower cadence (about every 15 minutes).
- **Upstream stopped returning data.** Parts of the Thunderstore and Hexium
  APIs are undocumented and may change. The Worker fails soft and keeps
  serving the other sources; see [docs/api-notes.md](docs/api-notes.md).
- **`wrangler d1 execute` changed nothing in production.** Without `--remote`
  wrangler targets the local database.

## Contributing

Conventional commits; TypeScript strict; zero runtime dependencies. See
[CLAUDE.md](CLAUDE.md) for the hard constraints of the Workers free plan.
