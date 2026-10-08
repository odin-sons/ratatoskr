# Message templates

A subscription can change how its messages look. There are two templates: one for
the message of a single event (immediate mode) and one for the line of a mod in a
digest. Edit them with `/template` (see `docs/bot-setup.md`); the rules the code
follows are in `docs/spec.md`, section "Message templates".

A template is plain text with variables in braces. `{name}` shows the name of the
mod, `{changelog:short}` a short form of the changelog, `{changelog:full:300}` the
full form cut to 300 characters, `{changelog:medium:l3}` the medium form cut to
three lines. A form a variable does not have is ignored, with no error.

## Syntax

| Written | Meaning |
|---|---|
| `{name}` | the variable `name` |
| `{name:form}` | a form of the variable, for example `short`, `medium`, `full`, `link` |
| `{name:300}` | at most 300 characters |
| `{name:l3}` | at most 3 lines |
| `{name:full:300:l3}` | arguments combine, in any order |
| `{{` and `}}` | the characters `{` and `}` |
| `(?` ... `?)` | an optional part, dropped when every variable inside is empty |
| `---` alone on a line | ends a block; blocks are separated by a divider |

Rules that keep a message tidy:

- A line with variables is dropped when all of them are empty. A line without
  variables is always kept.
- A block whose variables are all empty disappears with its divider.
- A line that holds only buttons becomes a row of buttons (at most five).
- `{icon}` marks the block that gets the thumbnail. It prints nothing.
- A template is at most 2000 characters. The notice with the link to the source of
  the bot is always added after it.

## Variables

| Variable | Shows | Forms |
|---|---|---|
| `name` | the name of the mod | `link` makes it a link to the mod page |
| `owner` | the author or team | |
| `store` | the store, for example Thunderstore | |
| `store_emoji` | the emoji of the store, empty when none | |
| `kind_emoji` | an emoji for a new mod or an update | |
| `version` | the new version | |
| `version_from` | the previous version, empty for a new mod | |
| `versions` | `1.2 → 1.3`, or just the version for a new mod | |
| `kind` | "New by Author" or "Updated by Author", in the language of the deployment | |
| `time` | when the mod was updated, as a Discord relative time | |
| `size` | the download size, for example 2.4 MB | |
| `downloads` | the number of downloads, empty for a new mod | |
| `likes` | the number of likes, empty when there are none | |
| `description` | an excerpt of the description | `short` (120), `medium` (350, default), `full` (1000) |
| `changelog` | an excerpt of the changelog with a link to the full one; empty for a new mod and for subscriptions with the changelog switched off | `short` (150), `medium` (500, default), `full` (1000) |
| `changelog_url`, `url`, `download_url`, `website_url` | a plain link, empty when the mod has none | |
| `categories` | the categories, comma separated | |
| `also_on` | the same release on other stores, as links | |
| `title` | the heading of the default message: store emoji and the linked name | |
| `kind_line` | kind emoji, `kind`, `versions` and `time`, joined with a dot | |
| `info_line` | `size`, `downloads` and `likes`, joined with a dot, after an info emoji | |
| `icon` | the thumbnail; prints nothing | |
| `buttons` | the buttons Mod page, Download and Website | |
| `page_button`, `download_button`, `website_button`, `info_button` | one button each | |

The numbers in brackets are the most characters the form can show; a limit you
write can only make a value shorter. Cutting happens on a line or word boundary,
never inside a link, and an ellipsis marks the cut.

In a digest line only `name`, `owner`, `store`, `store_emoji`, `version`,
`version_from`, `versions`, `size` and `url` are available. A line is one line of
text: several lines of the template are joined with a space, and a line longer than
600 characters is replaced by the default line.

## The default templates

The message of an event:

```
{icon}{title}
{kind_line}
{info_line}
{also_on}

{description}
---
**Changelog**
{changelog}
---
**🗂️ Categories**
{categories}
---
{buttons}
```

The labels follow the language of the deployment. The line of a mod in a digest:

```
**{name:link}** {versions}(? · {owner}?)(? · {size}?)
```

## Examples

A short message, with the changelog cut to three lines:

```
{icon}## {name:link} {versions}
{changelog:medium:l3}
---
{buttons}
```

A one-line digest entry with the author first:

```
{owner}: {name:link} {versions}
```

## When a message does not fit

If a message is too long for Discord, the bot tries again with shorter forms
(everything longer than `medium` becomes `medium`, then `short`), then drops the
optional blocks, and in the end uses the default template. A digest that does not
fit moves down its own levels as it always has. You do not have to size a
template for the worst case.
