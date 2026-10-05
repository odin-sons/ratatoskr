# Security policy

## Supported versions

Only the latest release receives fixes. Each operator deploys their own instance, so a fix reaches a deployment when its operator deploys the new version.

## Reporting a vulnerability

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**. If that is not available to you, email <andrew@gurylev.com> with the subject "ratatoskr security".

Do not open a public issue or discussion for a vulnerability, and do not post exploit details in a pull request.

Please include the affected version, what an attacker can do, and the steps or a minimal input that show it. A working proof of concept is welcome but not required.

The maintainer aims to acknowledge a report within 7 days, then says whether it counts as a vulnerability. If it does, a fix and a disclosure date are agreed with you, and the release carries a GitHub security advisory that credits you unless you prefer to stay anonymous. This is a volunteer project, so these are targets, not guarantees.

## What counts

The bot holds four kinds of secret: the Discord bot token (anyone holding it can act as the bot in every server it joined), Discord webhook URLs (anyone holding one can post to that channel), the optional Nexus API key, and the Cloudflare credentials used by deployment. It also serves one public route, `POST /interactions`, which accepts only requests signed with the application's Discord public key. In scope:

- a way to make the bot or its logs reveal a bot token, a webhook URL, an API key or another token;
- a way to make `POST /interactions` act on a request that does not carry a valid Discord signature, or to reach D1 before the signature is checked;
- a way for a user without the Manage Channel permission to create, change or remove a subscription, or to change one in a channel or server other than the one the command came from;
- a way to make the bot mention `@everyone`, `@here` or a role, or to post content that bypasses its sanitising of upstream text (mod names, descriptions, changelogs, links);
- a way to make the bot request URLs the operator did not configure;
- SQL or shell injection through the scripts (`add-subscription`, `subscriptions`, `deploy`, `wrangler`);
- a weakness in the GitHub workflows or release process that exposes secrets or lets an outsider publish a release.

Out of scope: vulnerabilities in Discord, Cloudflare, Thunderstore, Hexium or Nexus Mods themselves (report those to the vendor), problems that need access to an operator's Cloudflare account or `.env`, and behavior that only exceeds a free-plan quota.

## If a secret leaks

If a webhook URL or token appears in an issue, a log, a commit or a screenshot, treat it as compromised: delete the webhook in Discord and create a new one, or revoke and recreate the token (for the bot token: reset it in the Discord developer portal and update the Worker secret), before you do anything else. Removing the text from the issue afterwards does not make the old value safe.
