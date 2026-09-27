# Licensing and acceptable use

Not legal advice. This is the working position the project operates under.

## Our licence: AGPL-3.0-or-later

- `LICENSE` at the repository root.
- `// SPDX-License-Identifier: AGPL-3.0-or-later` header in every source file.
- AGPL's network clause requires that users of the running service can obtain
  the source. For a Discord bot that means a visible link in the output. Every
  message carries one pointing at `github.com/odin-sons/ratatoskr`: an immediate
  message ends with a small linked subtext line, `ratatoskr v1.0.2`, outside its
  coloured block; a digest ends with the same text as the last field of its
  last embed (embed footers cannot carry links). Both are always present,
  whatever else in the message is missing or invalid.
  This also answers "what is this thing posting in our channel".

AGPL was chosen over GPL deliberately: this is server-side software, and plain
GPL lets anyone run a modified copy as a service without publishing changes.

### Compatibility with upstream

Calling an HTTP API does not create a derivative work. There is direct
precedent in this ecosystem: Gale, a public mod manager talking to both
Thunderstore and Hexium, is itself GPL-3.0.

**Do not copy code from `thunderstore-io/thunderstore-ui`.** It has no LICENSE
file at the root, which means all rights reserved by default. Endpoint paths and
response field names are facts about a wire format and are fine to write down;
their zod schemas and TypeScript types are code and are not. Write types from
observed responses — which is also more robust, since their fields are actively
changing.

## Nexus Mods

Nexus is the only upstream with a formal barrier, and it lands squarely on this
project's distribution model.

Their [API Acceptable Use Policy](https://help.nexusmods.com/article/114-api-acceptable-use-policy)
is separate from their Terms of Service. The relevant provision: personal API
keys are tolerated for applications in testing or intended for personal use
only. Once an application is public-facing and intended for a wider audience —
end users rather than a select group of testers — the developer is expected to
contact `support@nexusmods.com` and register the application. Nexus does not
endorse personal keys in place of registered application keys and reserves the
right to act against abuse of them. The consequence of non-compliance is losing
API access, not litigation.

There is a recent precedent: the G1L launcher stripped its entire Nexus API
integration and its key field in July 2026 for exactly this reason.

Open-sourcing the code is not itself the trigger — GitHub is full of
AGPL projects talking to their API. The trigger is shipping something that end
users run. "Every instance is personally deployed" is a defensible reading but
not a guaranteed one, and the people interpreting it are their support staff,
not a court.

**Therefore, non-negotiable:**

1. Nexus is an **optional source, disabled by default**.
2. No key ever ships in the repository, and there is no hosted instance that
   others connect to using someone else's key.
3. The README states plainly that the operator supplies their own personal key
   and is responsible for complying with the AUP, and links to it.
4. **Nexus-derived data never enters a shared cache.** If a cross-deployment
   upstream cache is ever built, Thunderstore and Hexium data may go through it
   — they are public and unauthenticated. Data fetched with someone's personal
   Nexus key may not.

Registering the application with Nexus is free and rarely refused, and would
remove the ambiguity. Worth doing before any wide announcement.

### Age-restricted content

Nexus's Terms of Service state that third parties using their APIs are
responsible for filtering the content returned. NSFW filtering is therefore a
correctness requirement, not a preference.

Filter by default on every source:

- Thunderstore cyberstorm listing: `is_nsfw`
- Hexium listing: `has_nsfw_content`
- Nexus: `contains_adult_content`

Opt-in only, per subscription, and never on by default.

## Thunderstore and Hexium

No formal barrier. Both APIs are public and unauthenticated; r2modman and Gale
have used them for years. What is expected of a good citizen:

- Mod content — descriptions, changelogs, icons — belongs to the mod authors
  under their own varied licences. Send an excerpt plus a link to the original.
  Never reproduce a changelog or description in full. The per-version
  extraction and truncation in `docs/spec.md` is exactly the right behaviour
  here.
- Do not proxy downloads. Do not mirror archives. Linking an icon by URL in an
  embed is fine — that is what a browser preview does.
- Descriptive `User-Agent` with project name, version and repository URL, plus
  a contact route. Workers egress from shared Cloudflare addresses; a ban for
  looking like a scraper would hit unrelated people.
- Honour `Cache-Control` and `ETag`. Do not poll faster than necessary.
- Do not use their logos or imply an official relationship. Describe the
  project as an unofficial notifier. Own avatar, own branding.
- Talk to them before any wide release. Both have active Discords. One message
  describing the project and asking which endpoint they would prefer closes
  both the goodwill question and the stability question — parts of
  Thunderstore's cyberstorm API are undocumented and carry no compatibility
  guarantee.

## README requirements

- Unaffiliated-with disclaimer naming all three platforms.
- AGPL notice and source link.
- Nexus AUP note as described above.
- Statement that the operator is responsible for what their deployment posts.
