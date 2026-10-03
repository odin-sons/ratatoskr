# ratatoskr

[![Tests](https://img.shields.io/github/check-runs/odin-sons/ratatoskr/main?nameFilter=test&label=tests)](https://github.com/odin-sons/ratatoskr/actions/workflows/ci.yml)
[![Typecheck, lint, config](https://img.shields.io/github/check-runs/odin-sons/ratatoskr/main?nameFilter=static-checks&label=typecheck%20%2B%20lint)](https://github.com/odin-sons/ratatoskr/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/odin-sons/ratatoskr)](https://github.com/odin-sons/ratatoskr/releases)
[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/odin-sons/ratatoskr)](LICENSE)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-fe5196)](https://www.conventionalcommits.org/)
[![Cloudflare Workers free plan](https://img.shields.io/badge/Cloudflare%20Workers-free%20plan-f38020)](docs/spec.md)

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

Measured on a live instance, extrapolated to a full UTC day (see [docs/spec.md](docs/spec.md)):

| Resource | Free limit | Used | Share |
|---|---|---|---|
| Worker requests | 100,000/day | 288 | 0.3 % |
| D1 rows written | 100,000/day | ~9,000 | 9 % |
| D1 rows read | 5,000,000/day | ~220,000 | 4 % |
| Cron triggers | 5/account | 2 | 40 % |
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

2. Create the D1 database and put the printed `database_id` into `.env` (copy
   `.env.example` to `.env` first) as `D1_DATABASE_ID`.

   ```sh
   wrangler d1 create ratatoskr   # or the name you set as D1_DATABASE_NAME
   ```

3. Apply the schema to the remote database. Raw `wrangler` commands need the
   real `database_id`, which `wrangler.jsonc` never carries (see below); use
   `pnpm run wrangler` instead of `wrangler` directly for any command that
   touches the remote database.

   ```sh
   pnpm run wrangler d1 execute ratatoskr --remote --file=./schema.sql   # your D1_DATABASE_NAME, if set
   ```

   Upgrading an existing database: apply the files in `migrations/` you have not
   applied yet, in order, before `schema.sql`
   (for example `pnpm run wrangler d1 execute ratatoskr --remote --file=./migrations/0003_package_likes_and_website.sql`).
   Apply each file once; the current ones are `0001_outbox_delivered_at.sql`,
   `0002_package_download_url_and_downloads.sql`, `0003_package_likes_and_website.sql`
   and `0004_subscription_thread_id.sql`.
   A database created from the current `schema.sql` needs none of them.

4. Review `ratatoskr.config.json` (sources, game, User-Agent) and validate it.

   ```sh
   pnpm validate-config
   ```

5. Create a Discord webhook (channel settings, Integrations, Webhooks) and add
   a subscription. The script prints a `pnpm run wrangler d1 execute` command;
   it does not run it. Review the output, then run it.

   ```sh
   # put the webhook URL into .env (git-ignored, from step 2)
   pnpm add-subscription --guild-id <guild id> --webhook-url-env DISCORD_WEBHOOK_URL
   ```

   `pnpm add-subscription` loads `.env` automatically; a variable already
   exported in your shell takes precedence over the file.

   The webhook URL is a credential: anyone holding it can post to the channel.
   Passing it with `--webhook-url` leaves it in your shell history, so prefer
   `--webhook-url-env`. It is also stored in D1 in plain text and appears in the
   printed command.

6. Optional: a Discord channel for the bot's own warnings. Create a webhook in it and
   store the URL as a secret. The bot posts there when an internal limit nears (for
   example the Hexium package index at 70, 85 and 95 % of its cap) and again every day
   while a limit is exceeded. Without it nothing is sent.

   ```sh
   pnpm run wrangler secret put ALERT_WEBHOOK_URL
   ```

   Keep this webhook out of every subscription: it is for you, not for the readers of
   the mod channels. An existing database needs `schema.sql` applied again (step 3)
   before the first deploy that carries alerts; it adds the `alert_state` table.

7. Optional: the D1 usage monitor. It reads the day's D1 usage from Cloudflare's analytics API,
   alerts in the channel from step 6 at 50, 70, 85 and 95 % of a daily limit, switches optional work
   off from 70 %, and sends a usage chart every Monday. Create a token that can do nothing else: in
   the Cloudflare dashboard, Profile → API Tokens → Create Token → Custom, one permission, Account →
   Account Analytics → Read, limited to your account. Store it and your account id (on the Workers & Pages overview, or from `pnpm run wrangler
   whoami`) as secrets, separate from the deploy token.

   ```sh
   pnpm run wrangler secret put CLOUDFLARE_ANALYTICS_TOKEN
   ```

   ```sh
   pnpm run wrangler secret put CLOUDFLARE_ACCOUNT_ID
   ```

   Put the same two values in `.env` to see the numbers from your machine with `pnpm run usage`.

8. Only if you enable Nexus (see the disclaimer above): set
   `"enabled": true` on the `nexus:*` source in `ratatoskr.config.json` and store
   your personal key.

   ```sh
   pnpm run wrangler secret put NEXUS_API_KEY
   ```

9. Deploy. Use `pnpm run deploy`; plain `pnpm deploy` is a different, built-in
   pnpm command.

   ```sh
   pnpm run deploy
   ```

   `wrangler.jsonc` commits a placeholder `database_id`, never your real one.
   `pnpm run deploy` reads `D1_DATABASE_ID` from `.env` (step 2), substitutes it
   into a throwaway copy of `wrangler.jsonc` next to the real one, deploys with
   that, and deletes it immediately after — your id never touches a file that
   could be committed. It also loads `.env` for the optional store emoji
   (`STORE_EMOJI_*`), `RATATOSKR_EMOJI` and `RATATOSKR_LANGUAGE` (see below), so
   they reach the Worker without being committed either. A plain `wrangler
   deploy` (bypassing this script) is expected to be rejected by the Cloudflare
   API for the placeholder id; `--dry-run` skips that check entirely (it makes
   no network calls), so it succeeds either way and proves nothing about the id.
   Use `pnpm run wrangler` for any other `wrangler` command that needs the real
   one.

   Pushing a `vX.Y.Z` tag also deploys, via `.github/workflows/release.yml`,
   after cutting the GitHub Release: gated on approving the `production`
   environment (`Settings → Environments → production`, a required reviewer —
   not automatic). Needs `CLOUDFLARE_API_TOKEN` and `D1_DATABASE_ID` (same
   value as your `.env`) as that environment's **secrets** — not repository
   secrets, so they stay unreadable by any workflow run that hasn't cleared
   the approval gate. The optional presentation ones below aren't
   credentials, so they go in the same environment's **variables** instead,
   if you want a tag-triggered deploy to carry them too.

### Several instances on one account

The Worker is named `ratatoskr` and the D1 database `ratatoskr` unless you say otherwise. Two
instances on one Cloudflare account (for two games, say) need different names, because both
are unique per account. Set `WORKER_NAME` and `D1_DATABASE_NAME` in each checkout's
`.env` (or as `production` environment variables for a tag-triggered deploy). `pnpm run deploy`
and `pnpm run wrangler` substitute them into the same throwaway copy of `wrangler.jsonc` that
carries the real `database_id`, and `pnpm add-subscription` and `pnpm subscriptions` use
`D1_DATABASE_NAME` as their `--database` default. Create the database under the same name:
`wrangler d1 create <D1_DATABASE_NAME>`.

Each instance needs its own `ratatoskr.config.json`, `.env` and secrets, so use one checkout or
fork per instance, and keep every `wrangler` call going through `pnpm run wrangler` (for secrets too), because the
plain command reads the committed names. They share the account's limits: 5 cron triggers (an instance uses 2),
100,000 Worker requests and 5M D1 row reads plus 100,000 row writes per day.

## Configuration

### `ratatoskr.config.json`

Deployment-wide settings, validated at build time (`pnpm validate-config`, run
in CI) and not bundled into the Worker.

```json
{
  "userAgent": "ratatoskr/1.0.2 (+https://github.com/odin-sons/ratatoskr; unofficial mod notifier)",
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

### Store emoji (`STORE_EMOJIS`)

Optional. Messages can show a custom emoji per store at the start of the title
(`# <emoji> [Name](url)`), on the `Mod page` button and at the start of each
per-store digest heading. Without one the title is just the linked name and the
button uses a built-in Unicode emoji. It is a Worker variable, an object (or a
JSON string of one) keyed by store:

```json
{
  "thunderstore": "<:thunderstore:123456789012345678>",
  "hexium": "<:hexium:123456789012345678>",
  "nexus": "<:nexus:123456789012345678>"
}
```

- Values are full Discord emoji markup, `<:name:id>` (or `<a:name:id>` for an
  animated one); plain `:name:` does not work through the API. To get the
  markup, type `\:name:` in a Discord message and copy what it shows.
- They must be custom emoji from a server the webhook can use; the safest choice
  is an emoji of the server that owns the channel. Otherwise Discord shows the
  raw `<:name:id>` text.
- Each value must match `<a?:[A-Za-z0-9_]{2,32}:[0-9]{17,20}>`. Invalid
  entries and unknown keys are ignored (one warning in the log names only the
  keys); a store without an entry shows no emoji.
- `wrangler.jsonc` ships `"vars": { "STORE_EMOJIS": {}, "LANGUAGE": "en" }`. The easy way to set
  it: put `STORE_EMOJI_THUNDERSTORE`, `STORE_EMOJI_HEXIUM` and `STORE_EMOJI_NEXUS`
  in the git-ignored `.env` (see `.env.example`); `pnpm run deploy` validates them
  and passes them to the Worker as `STORE_EMOJIS`. Do not commit your ids.
  Always deploy with `pnpm run deploy` on a machine that has your `.env`: a
  plain `wrangler deploy` is expected to be rejected for `wrangler.jsonc`'s
  placeholder `database_id` (see the deploy step above), but a `pnpm run
  deploy` on a machine or CI runner missing only the optional emoji/language
  variables
  still succeeds and silently publishes the config's empty `STORE_EMOJIS`. The
  same goes for `RATATOSKR_LANGUAGE` and `RATATOSKR_EMOJI` below.

### Source-link emoji (`RATATOSKR_EMOJI`)

Optional. Every message ends with a small `-# <emoji> [ratatoskr vX](url)`
line linking to this project's source (the AGPL notice); it shows a squirrel
by default. Set the
Worker variable `RATATOSKR_EMOJI` to full custom emoji markup (same format and
rules as `STORE_EMOJIS`) to use your own. An invalid value is ignored with one
warning that names only the variable. Easiest: put `RATATOSKR_EMOJI` in the
git-ignored `.env`; `pnpm run deploy` validates it and passes it to the Worker.

### Language (`LANGUAGE`)

Optional Worker variable, default `en`. Every text the bot writes into a
message (labels, plural forms, button captions, number and size formats) comes
from a catalog in `src/i18n`: `en` and `ru` exist. An unknown value falls back
to `en` with one warning that names only the variable. `wrangler.jsonc` ships
`"LANGUAGE": "en"`; the easy way to change it is `RATATOSKR_LANGUAGE=ru` in the
git-ignored `.env`, which `pnpm run deploy` validates against the catalogs and
passes to the Worker as `LANGUAGE` (a bad value stops the deploy). The `.env` key
is not called `LANGUAGE` because that is the POSIX locale variable, which many
shells already set. To add a language, add a
`src/i18n/<code>.ts` that satisfies the `Messages` type (TypeScript fails if a
key is missing) and register it in `src/i18n/index.ts`. Log lines, warnings and
the run report stay English.

### Message format

An immediate message is one Discord Components V2 message: a container in the
store's colour holding

- the header: a linked h2 title (`## <store emoji> [Name](url)`), the kind line
  (`⬆️ Updated by Owner · 1.2.2 → 1.2.3 · <relative time>`, or `🆕 New by
  Owner · 1.0.0 · ...`), an info line (`ℹ️ 94.2 MB · Downloaded 12,345 times ·
  21 likes`, each part only when known) and the description excerpt, with the
  mod icon as a thumbnail beside it;
- a `Changelog` block (about 500 characters, ending with a link to the full
  changelog) and a `🗂️ Categories` block, each only when there is something to show;
- a row of link buttons: `Mod page`, `Download` and `Website`, each only when
  the source provides a URL. Discord refuses a button whose host has no real
  top-level domain (`https://mysite`), so such a URL gets no button; if Discord
  rejects a message anyway, the bot resends it once with only `Mod page`
  before giving up (counted as `degraded` in the run log);
- outside the coloured block, a trailing small `-# <emoji> [ratatoskr
  v<version>](url)` line linking to this project's source (the AGPL notice).
  It is always present, whatever else in the message failed to render.

In immediate mode every update also gets a changelog excerpt, within the
per-tick fetch cap. Discord only accepts this format because the bot sends
`with_components=true` and the Components V2 flag; such a message cannot carry
`content` or embeds.

Digests hold many mods per message, so they stay classic embeds (no buttons):
new packages and watchlist hits are detailed embeds with the same header,
`Changelog` and `🗂️ Categories` fields; updates are a compact list per store
(`**Thunderstore** · 37 updates`). The last embed of every digest message ends
with a small `-# ratatoskr v<version>` line linking to the source repository
(the AGPL notice), and a digest that spans several messages numbers them in the
last embed's footer.

### Subscriptions

Subscriptions live in the D1 `subscriptions` table and are created with
`pnpm add-subscription` (run `pnpm add-subscription --help` for all options).
Delivery options: `--mode immediate|digest` (default `digest`) and
`--interval <minutes>` (5 to 1440, default 30, digest only).

The filter is built from flags (`--source`, `--kind`, `--package`,
`--exclude-package`, `--category`, `--exclude-category`, `--allow-nsfw`; the
list flags can be repeated) or given as raw JSON with `--filter '<json>'` or
`--filter-file <path>`. Flags and raw JSON cannot be combined. Every field is
optional; the empty filter `{}` matches everything except NSFW content. All
fields apply together (a package must pass every one that is set).

| Field | Flag | Meaning |
|---|---|---|
| `sources` | `--source` | Restrict to these source ids. Absent or empty means all. |
| `kinds` | `--kind` | `"new"`, `"update"`, or both. Absent or empty means both. |
| `packages` | `--package` | Allowlist: only these packages. Each entry is a full `Owner-Name` package id or a bare owner name, case-insensitive. Absent or empty means no restriction. |
| `excludePackages` | `--exclude-package` | Never deliver these packages. Same entries and matching as `packages`; wins over every other field. |
| `allowNsfw` | `--allow-nsfw` | NSFW content is excluded unless this is exactly `true`. |
| `watchlist` | (JSON only) | Highlights these packages (same entries as `packages`) in digests with a detailed embed. It never restricts what is delivered; use `packages` for that. |
| `includeCategories` | `--category` | Only packages in these categories. |
| `excludeCategories` | `--exclude-category` | Drop packages in these categories. |
| `dedupAcrossStores` | (JSON only) | Collapse the same release seen on several stores into one item. Default `true`. |
| `includeChangelog` | `--no-changelog` | Set to `false` to never show the Changelog block for this subscription. Default `true`. Most mods ship a long `CHANGELOG.md`, and showing it in every message makes each card much taller; turn it off for a broad subscription and keep it on for a subscription that follows one mod or a small set. |

Examples:

```sh
# Only these authors or packages, delivered immediately
pnpm add-subscription --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL \
  --mode immediate --package Azumatt --package RandyKnapp-EpicLoot

# Everything, but highlight these authors in the digest (watchlist does not restrict)
pnpm add-subscription --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL \
  --filter '{"watchlist":["Azumatt","RandyKnapp-EpicLoot"]}'

# NSFW opt-in
pnpm add-subscription --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL \
  --filter '{"allowNsfw":true}'

# Digest every 60 minutes, new packages only, Thunderstore only
pnpm add-subscription --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL \
  --mode digest --interval 60 \
  --filter '{"sources":["thunderstore:valheim"],"kinds":["new"]}'
```

### Forum posts and channel threads

`--thread-id <id>` delivers into an existing forum post or text-channel thread
instead of the webhook's parent channel — a numeric Discord snowflake, the same
id you'd copy from the thread's own URL. The webhook still lives on the parent
(forum or text) channel; only where each subscription's messages land changes.
The thread must already exist: this project never creates one, and a subscription
pointed at a deleted or archived-forever thread just fails delivery like any other
bad destination (see "Managing subscriptions" in `docs/spec.md`).

```sh
# Deliver into one forum post instead of the forum channel itself
pnpm add-subscription --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL \
  --thread-id 222233334444555566 --filter '{"sources":["hexium:valheim"]}'
```

### Several channels and targeted subscriptions

Every subscription is its own row: one webhook (one channel), its own filter,
mode and interval. Rows are independent, so you can add as many as you like and
the same event can go to several channels. Create one webhook per channel, put
each URL into its own variable in the git-ignored `.env` (see `.env.example`,
which already lists `DISCORD_WEBHOOK_URL_HEXIUM` and `DISCORD_WEBHOOK_URL_NEXUS`),
and give every subscription a readable `--id`. Inserting an id that already
exists fails instead of replacing the row.

```sh
# One channel per store
pnpm add-subscription --id thunderstore --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL \
  --source thunderstore:valheim
pnpm add-subscription --id hexium --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL_HEXIUM \
  --source hexium:valheim
pnpm add-subscription --id nexus --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL_NEXUS \
  --source nexus:valheim

# A channel that only follows the updates of one mod (full Owner-Name package id)
pnpm add-subscription --id epicloot-updates --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL_EPICLOOT \
  --mode immediate --package RandyKnapp-EpicLoot --kind update

# A channel that follows one author (every mod and every event of that owner)
pnpm add-subscription --id azumatt --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL_AZUMATT \
  --mode immediate --package Azumatt

# Everything except one noisy mod (or all mods of one owner)
pnpm add-subscription --id main --guild-id <id> --webhook-url-env DISCORD_WEBHOOK_URL \
  --exclude-package SomeAuthor-NoisyMod
```

Every command prints a `pnpm run wrangler d1 execute` command and runs nothing;
review it, then run it. Package entries match the package id or the owner exactly
(case-insensitive, no partial matches); when a package is both allowed and
excluded, the exclusion wins. Because the sources are matched separately, a
per-store channel receives the releases of its own store even when the same
release is also on another store.

Managing existing subscriptions works the same way, with `pnpm subscriptions`
(it also only prints the command; add `--local` for the local database):

```sh
pnpm subscriptions list                       # id, guild, mode, filter, enabled, thread id, webhook id (never the token)
pnpm subscriptions disable --id azumatt       # stop delivering, keep the row
pnpm subscriptions enable  --id azumatt
pnpm subscriptions set-filter --id main --exclude-package SomeAuthor-NoisyMod --exclude-package Other
pnpm subscriptions remove  --id azumatt       # deletes the row and its undelivered queue entries
```

`set-filter` replaces the whole filter with the flags you pass (use
`--filter '{}'` to clear it), so run `list` first to see the current one.
`disable`, `enable` and `set-filter` are silent when the id does not exist (0
rows changed in the wrangler output).

The filter is checked twice: when an event is queued and again just before
delivery against the subscription's current filter. After `set-filter`,
`disable` or `remove`, anything already queued that no longer matches is
dropped instead of being sent.

## Local development

```sh
pnpm dev          # wrangler dev --test-scheduled
```

Apply the schema to the local database once with
`wrangler d1 execute ratatoskr --local --file=./schema.sql` (your `D1_DATABASE_NAME`, if set). With
`--test-scheduled`, wrangler exposes a development-only route that fires the
cron handler; the deployed Worker has no such route.

```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*%2F5+*+*+*+*"
```

The reconcile trigger runs at 03:01, 04:01 and 05:01 UTC and picks its run from the hour of
the scheduled time, so pass a time inside one of those minutes:

```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=1+3%2C4%2C5+*+*+*&time=1791082860000"
```

Other commands:

```sh
pnpm test              # vitest
pnpm typecheck
pnpm validate-config
pnpm lint
pnpm check             # typecheck, lint, tests and config validation
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
