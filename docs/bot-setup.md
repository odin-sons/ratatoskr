# Bot setup

From 2.0.0 the Worker is also a Discord bot: subscriptions are created in
Discord with slash commands. This guide covers what an operator does once, on
top of the normal deployment in the README. The design is in `docs/spec.md`,
section "Bot".

## 1. Create the Discord application

1. Open the [Discord developer portal](https://discord.com/developers/applications)
   and create a new application.
2. On the General Information page, copy the **Application ID** and the
   **Public Key**.
3. On the Bot page, create the bot user and copy its token. Treat the token as a
   password: anyone holding it acts as the bot in every server it joined. If it
   leaks, reset it in the portal and update the Worker secret.

## 2. Store the secrets

Put the three values into `.env` (git-ignored) for the registration script, and
the public key and the bot token into the Worker as secrets (the Worker reads
the application id from each interaction):

```sh
# .env
DISCORD_APP_ID=<application id>
DISCORD_PUBLIC_KEY=<public key>
DISCORD_BOT_TOKEN=<bot token>
```

```sh
pnpm run wrangler secret put DISCORD_PUBLIC_KEY
pnpm run wrangler secret put DISCORD_BOT_TOKEN
```

Without `DISCORD_PUBLIC_KEY` the endpoint answers 503. Without
`DISCORD_BOT_TOKEN` bot subscriptions stay queued and nothing is lost; the Worker
logs one line per run until the token is set.

## 3. Migrate the database and deploy

A database created before 2.0.0 needs three migrations, once, in this order:

```sh
pnpm run wrangler d1 execute <database name> --remote --file=migrations/0005_bot_subscriptions.sql
pnpm run wrangler d1 execute <database name> --remote --file=migrations/0006_subscription_channel_kind.sql
pnpm run wrangler d1 execute <database name> --remote --file=migrations/0007_mod_threads_thread_index.sql
```

A fresh database gets everything from `schema.sql`. Then deploy as usual
(`pnpm run deploy`). The Worker now has a `workers.dev` hostname; the only route
it serves is `POST /interactions`, and it checks Discord's signature before it
reads anything.

## 4. Point Discord at the endpoint

In the developer portal, on the General Information page, set **Interactions
Endpoint URL** to

```
https://<worker name>.<your workers.dev subdomain>/interactions
```

Discord sends a signed test request when you save; the page only accepts the URL
if the Worker answers it, so the secrets from step 2 must be in place first.

## 5. Register the commands

```sh
pnpm register-commands --dry-run   # prints the definitions, no network call
pnpm register-commands
```

Run it again after an update that adds commands. The commands need the Manage
Channel permission by default; `/info` and the Info button of a message are open
to every member. How messages look can be changed per subscription with
`/template`; see [docs/templates.md](templates.md).

## 6. Invite the bot

Open this URL with your application id (scopes `bot` and `applications.commands`,
permission integer `309237730304`):

```
https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot%20applications.commands&permissions=309237730304
```

The integer is View Channel, Send Messages (shown as Create Posts in a forum),
Embed Links, Read Message History, Create Public Threads and Send Messages in
Threads. `/subscribe` checks the bot's permissions in the place it runs and
names the missing ones.

## Using it

| Where you run it | What it does |
|---|---|
| A text channel | Subscribes the channel. With `thread_per_mod`, the bot posts a message about each mod and opens a thread on it; later updates of that mod go into the thread. |
| A forum post or a thread | Subscribes that one post, in `immediate` or `digest` mode. With `thread_per_mod`, it subscribes the whole forum, with one post per mod. |

Commands cannot run in a forum's own view, only inside one of its posts.
`/pause` and `/continue` stop and resume notifications, `/list` shows what is
subscribed, and `/unsubscribe` removes a subscription.

## Moving from a webhook subscription

Webhook subscriptions keep working until 3.0.0. To move one, run `/subscribe`
in the same channel or post with the same filter, check it with `/list`, then
remove the old row:

```sh
pnpm subscriptions list
pnpm subscriptions remove --id <id>
```

The webhook itself can be deleted in the channel's settings afterwards.
