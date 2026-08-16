---
title: Migrate from a .env file
description: Move an existing repository's secrets into prick, verify nothing was lost, and delete the file.
sidebar:
  order: 3
---

You have a repository with a `.env` file that everyone copies around. This moves
it into prick, proves nothing was lost on the way, and gets the file out of the
repository for good.

## Before you begin

- A project and environment to move into. If you have neither, do
  [Onboard a new service](/examples/onboard-a-service) first.
- `writer` or `admin` on the target environment.

```bash
export PRK_PROJECT=api
export PRK_ENV=production
```

## 1. Look at the file first

```bash
grep -c '' .env
```

The parser is strict, so it is worth knowing what is in there before you upload.
These forms all work:

```bash title=".env"
# A comment
DATABASE_URL=postgres://app:hunter2@db.example.com:5432/app
STRIPE_SECRET_KEY="sk_live_51H..."
LITERAL_VALUE='no \escapes \here'
export LEGACY_KEY=still-fine
```

These will be **refused**, and each is refused rather than guessed at:

| Line                  | Why                                                   |
| --------------------- | ----------------------------------------------------- |
| `KEY=one` twice       | A duplicate key is an error, not last-one-wins        |
| `KEY="unterminated`   | Unterminated quote                                    |
| `KEY="bad \q escape"` | Unknown escape                                        |
| `` KEY=`value` ``     | Backtick-quoted values are not accepted               |
| `KEY=value # comment` | On an unquoted value, ` #` reads two ways             |
| `JUST_A_WORD`         | No `=`                                                |
| `1FOO=bar`            | A key may not start with a digit                      |
| `FOO-BAR=baz`         | Only `A-Z`, `a-z`, `0-9` and `_` are allowed in a key |

A file it cannot parse unambiguously fails **whole**. Importing a file and
silently dropping the two lines the parser did not understand is how a deploy
loses `DATABASE_URL`.

:::danger[Comments on unquoted values are the one to expect]
The ` #` row is the one most `.env` files trip over, and it is worth
understanding rather than just fixing. This line:

```bash title=".env"
PASSWORD=hunter2 # 1
```

says two different things depending on who reads it: the password is
`hunter2 # 1`, or the password is `hunter2` and someone left a note. Both kinds
of file exist. A parser that picks one hands production a credential you never
wrote and reports success either way, so this one refuses the line and asks you
which you meant. Write whichever you actually have:

```bash
PASSWORD="hunter2 # 1"    # the hash is part of the password
PASSWORD="hunter2" # 1    # it is a comment
```

Only whitespace before the `#` is ambiguous. `COLOR=#ffffff`, `TOKEN=ab#cd` and
a `#` after a closing quote all parse as written, and every whole-line comment
is ignored as usual.

To see how many lines this affects before you start:

```bash
grep -nE "^[^#][^=]*=[^\"'].*[ \t]#" .env
```

:::

## 2. Dry-run the upload

```bash
prk secrets upload .env --dry-run
```

```
3 added, 0 changed, 0 removed (dry run; nothing was written).
```

Nothing was written. Read those numbers carefully — `removed` is the one that
bites.

### If it refuses the file

```
error: Line 12: the double-quoted value of "STRIPE_SECRET_KEY" is never closed.
  help: Check for an unescaped double quote inside the value.
```

Fix that line and run the dry run again. The message names the line and the key,
never the value — a rejected line of a `.env` file is by construction a line
containing a secret, and that message travels into an HTTP response and a log.

### If you get an interpolation warning

```
warning: line 8: value contains a $VAR-like sequence and will be stored literally -- this parser performs no interpolation. (DATABASE_URL)
```

This one matters. A `.env` file like:

```bash title=".env"
POSTGRES_HOST=db.example.com
DATABASE_URL=postgres://app@${POSTGRES_HOST}/app
```

stores `DATABASE_URL` with the literal text `${POSTGRES_HOST}` in it, because
this parser expands nothing. Whatever was expanding those variables before was
your shell or your framework, not the file. Expand them before uploading:

```bash
set -a && . ./.env && set +a
```

Then write the expanded values out and upload that instead.

## 3. Upload

```bash
prk secrets upload .env
```

```
3 added, 0 changed, 0 removed.
```

:::caution[`upload` replaces the environment]
Keys the file does not name are **deleted**. That is what "upload this
environment" means, and it is why the dry run exists. If you are adding to an
environment that already has secrets in it, pass `--merge`:

```bash
prk secrets upload .env --merge
```

:::

## 4. Prove nothing was lost

Download it straight back and compare:

```bash
prk secrets download --format env --output /tmp/roundtrip.env
```

```
Wrote 3 secrets to /tmp/roundtrip.env.
```

```bash
diff <(sort .env | grep -v '^#' | grep -v '^$') <(sort /tmp/roundtrip.env)
```

Expect differences in **quoting only** — the export format quotes
unconditionally, so `KEY=value` comes back as `KEY="value"`. If a _value_ differs,
stop and work out why before deleting anything.

For an exact comparison that ignores quoting, use JSON:

```bash
prk secrets download --format json | jq -S .
```

```json
{
  "DATABASE_URL": "postgres://app:hunter2@db.example.com:5432/app",
  "LEGACY_KEY": "still-fine",
  "STRIPE_SECRET_KEY": "sk_live_51H..."
}
```

Clean up the copy:

```bash
rm /tmp/roundtrip.env
```

## 5. Switch the application over

Replace whatever loaded the file with `prk run`:

```diff title="package.json"
-    "start": "node server.js"
+    "start": "prk run -- node server.js"
```

Or, if the process manager owns the environment, keep the file out of the
repository at least:

```bash
prk secrets download --format env --output /run/app/.env
```

`--output` creates the file with mode `0600`.

## 6. Remove the file, and its history

```bash
rm .env
```

```bash title=".gitignore"
.env
.env.*
!.env.example
```

Leave a `.env.example` behind with the **names** and no values, so a new
contributor knows what the application needs:

```bash
prk secrets list --json | jq -r '.[].key + "="' > .env.example
```

```bash title=".env.example"
DATABASE_URL=
LEGACY_KEY=
STRIPE_SECRET_KEY=
```

:::danger[If the file was ever committed, the secrets are still leaked]
Deleting a file does not remove it from git history — anyone with a clone still
has every value. Treat every secret that was in a committed `.env` as
compromised and rotate it. See
[Respond to a leaked secret](/examples/rotate-a-leaked-key).
:::

## 7. Do the other environments

```bash
prk secrets upload staging.env --env staging --dry-run
```

```
3 added, 0 changed, 0 removed (dry run; nothing was written).
```

```bash
prk secrets upload staging.env --env staging
```

## Migrating from JSON instead

A `.json` extension is parsed as JSON rather than as a `.env` document:

```bash
prk secrets upload secrets.json
```

The file must be a flat object of string values:

```json title="secrets.json"
{
  "DATABASE_URL": "postgres://app@db.example.com/app",
  "STRIPE_SECRET_KEY": "sk_live_51H..."
}
```

That is also the shape `prk secrets download --format json` writes, so moving an
environment between servers is a download and an upload.

## Next steps

- [`prk secrets`](/reference/cli/secrets) — every flag on `upload` and `download`.
- [Using secrets](/guides/using-secrets/) — how the application reads them now.
- [Script prk with `--json`](/examples/scripting-with-json)
