---
title: prk secrets
description: Read, write, import, export, version and roll back the secrets in one environment.
sidebar:
  order: 5
---

Everything on this page acts on **one environment**, so every command needs a
project and an environment. Give them as `--project` / `--env`, or set
`PRK_PROJECT` / `PRK_ENV` once and drop the flags.

```
prk secrets list
prk secrets get <KEY>
prk secrets set <KEY> [--stdin] [--description <TEXT>] [--reason <TEXT>]
prk secrets rm <KEY> [--reason <TEXT>]
prk secrets upload <FILE> [--merge] [--dry-run] [--expected-rev <REV>] [--reason <TEXT>]
prk secrets download [--format <FORMAT>] [--output <FILE>]
prk secrets history <KEY>
prk secrets rollback <KEY> --to <N> [--reason <TEXT>]
```

## All flags at a glance

| Flag                    | Command                           | Meaning                                                     |
| ----------------------- | --------------------------------- | ----------------------------------------------------------- |
| `--stdin`               | `set`                             | Read the value from stdin instead of prompting              |
| `--description <TEXT>`  | `set`                             | Note stored with the secret and shown in listings           |
| `--reason <TEXT>`       | `set`, `rm`, `upload`, `rollback` | Recorded verbatim in the audit row                          |
| `--merge`               | `upload`                          | Merge into the environment instead of replacing it          |
| `--dry-run`             | `upload`                          | Report what would change and exit without writing           |
| `--expected-rev <REV>`  | `upload`                          | Fail unless the environment is still at this revision       |
| `--format <FORMAT>`     | `download`                        | `env` (default), `shell`, `yaml`, `json`                    |
| `--output <FILE>`, `-o` | `download`                        | Write to a file instead of stdout, created with mode `0600` |
| `--to <N>`              | `rollback`                        | The version to restore. Required                            |

## `prk secrets list`

Key names and metadata.

```bash
prk secrets list --project api --env production
```

```
DATABASE_URL	v4	you@example.com	Primary Postgres, read-write
STRIPE_SECRET_KEY	v2	deploy@example.com	none
```

Columns are tab-separated: key, current version, who last wrote it, and the
`--description` stored with it. A key with no description reads `none` rather
than leaving the column empty, because a blank after a tab looks like a
rendering fault. With nothing to show:

```
No secrets in this environment.
```

```bash
prk secrets list --project api --env production --json
```

```json
[
  {
    "key": "DATABASE_URL",
    "description": "Primary Postgres, read-write",
    "version": 4,
    "updated_at": 1760000000000,
    "updated_by": "you@example.com",
    "kid": "k1",
    "unreadable": false
  }
]
```

:::danger[A row marked `UNREADABLE` is a data-integrity failure]
A secret whose ciphertext will not decrypt is listed rather than dropped:

```
DATABASE_URL	v4	you@example.com	Primary Postgres, read-write
STRIPE_SECRET_KEY	v2	UNREADABLE	Live mode, rotates quarterly
```

The description survives, because it is plaintext metadata stored beside the key
name — what failed to decrypt is the value, and the note is often the only thing
left saying what the row was for.

```
warning: 1 secret(s) could not be decrypted. This is a data-integrity failure, not a display problem: do not deploy from this environment until it is resolved.
```

Treat it as a tamper attempt until proven otherwise, and do not deploy from that
environment until you know why. A listing that is quietly one row shorter is how
a deploy goes out without `DATABASE_URL`.
:::

## `prk secrets get`

One secret's value, on stdout and nothing else — so it composes.

```bash
prk secrets get DATABASE_URL --project api --env production
```

```
postgres://app:hunter2@db.example.com:5432/app
```

```bash
export DATABASE_URL="$(prk secrets get DATABASE_URL -P api -E production)"
```

```bash
prk secrets get DATABASE_URL -P api -E production --json
```

```json
{ "key": "DATABASE_URL", "value": "postgres://app:hunter2@db.example.com:5432/app" }
```

Every reveal is audited, and the audit row records _why_: `reveal`, `copy`,
`export` or `run`. That is what lets a reader tell "someone looked at it" from
"someone took it".

## `prk secrets set`

Writes a value. The value is **never** an argument.

```bash
prk secrets set DATABASE_URL --project api --env production
```

```
Value for DATABASE_URL:
```

Type it — the prompt is masked and reads the terminal device directly — and:

```
Added `DATABASE_URL` (rev 43).
```

An existing key reports the other verb:

```
Updated `DATABASE_URL` (rev 44).
```

### From a pipe

```bash
printf '%s' "$VALUE" | prk secrets set DATABASE_URL --stdin -P api -E production
```

Because the prompt reads `/dev/tty` rather than stdin, `--stdin` and an
interactive prompt never contend for the same stream.

:::caution[Why the value is never a flag]
A value on the command line is written to your shell history and is visible in
`ps` output to every user on the machine. The prompt and `--stdin` are the two
ways in.
:::

### Describe it while you are there

```bash
prk secrets set STRIPE_SECRET_KEY --description "Live mode, rotates quarterly" -P api -E production
```

Descriptions are stored **in plaintext** beside the key name, so they are safe
to read in a listing and must never contain a value.

Omitting `--description` leaves any existing description alone — it is not a
clear.

### Record why

```bash
prk secrets set STRIPE_SECRET_KEY --reason "rotating after the 2026-08-14 incident" -P api -E production
```

`--reason` is copied verbatim into the audit row. It never contains a value, so
it is safe to read back in an audit query.

## `prk secrets rm`

```bash
prk secrets rm OLD_TOKEN --project api --env production
```

```
Delete secret `OLD_TOKEN`? [y/N]
```

```
Deleted `OLD_TOKEN` (rev 45).
```

### Record why it went

```bash
prk secrets rm OLD_TOKEN --reason "rotated out after the 2026-08-14 incident" --project api --env production
```

The most destructive thing you can do to one secret is also the one you are most
often asked to explain afterwards, and the tombstone is the only row left to
explain it on. `--reason` is copied verbatim into that audit row, exactly as it
is for [`set`](#record-why), `upload` and `rollback`.

A delete writes a **tombstone version** — a history row with `op = 'delete'` and
no ciphertext — so history survives. Recreating the key later continues the
version sequence instead of restarting at 1, which keeps a version number
pointing at exactly one value for the life of the environment.

## `prk secrets upload`

Loads an environment from a file. By default this **replaces** the environment:
keys the file does not name are deleted.

```bash
prk secrets upload .env --project api --env production
```

```
3 added, 1 changed, 2 removed.
```

The file is sent as a blob and parsed **by the server**, so what the server
accepts is exactly what this command accepts. A `.json` extension is parsed as
JSON; anything else is parsed as a `.env` document.

### Preview first

```bash
prk secrets upload .env --dry-run -P api -E production
```

```
3 added, 1 changed, 2 removed (dry run; nothing was written).
```

### Merge instead of replace

```bash
prk secrets upload additions.env --merge -P api -E production
```

```
2 added, 0 changed, 0 removed.
```

`--merge` leaves keys the file does not name untouched. Without it, "upload this
environment" means the environment ends up matching the file exactly.

### Guard against a concurrent change

```bash
prk secrets upload .env --expected-rev 42 -P api -E production
```

If somebody else wrote to the environment in the meantime, the revision has
moved and the write is refused:

```
error: The environment has changed since you last read it.
  help: Re-read the environment and re-submit with its current `expected_rev`. Nothing was written.
```

Exit code 6, `PRECONDITION_FAILED`, and the environment is left byte-for-byte
unchanged. Read the current revision with
[`prk env list`](/reference/cli/env#prk-env-list), re-apply your change, and try
again.

### Warnings

Lines the parser accepted but wants to flag are printed before the summary:

```
warning: line 7: value contains a $VAR-like sequence and will be stored literally -- this parser performs no interpolation. (DATABASE_URL)
3 added, 1 changed, 0 removed.
```

That one is worth reading twice: `POSTGRES_HOST=db.internal` followed by
`DATABASE_URL=postgres://${POSTGRES_HOST}/app` stores the second value with the
`${POSTGRES_HOST}` text intact. Expand it before uploading, or store the
expanded value.

### Under `--json`

```bash
prk secrets upload .env --dry-run -P api -E production --json
```

```json
{
  "applied": false,
  "added": ["NEW_KEY"],
  "changed": ["DATABASE_URL"],
  "removed": ["OLD_TOKEN"],
  "warnings": []
}
```

`applied` is `false` for a dry run and `true` for a write, so one script can do
both.

:::note[The whole file goes in one request]
A bulk write is one database transaction with its audit row inside it. If the
document does not fit, it is rejected with `413` rather than split — splitting
would forfeit the atomicity that makes a failed import leave the environment
exactly as it was.
:::

### The `.env` parser is strict

`.env` has no specification, so implementations disagree at the edges. This one
resolves every ambiguity by **refusing to guess**: a line it cannot parse
unambiguously fails the whole import.

| Form              | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `# …` or blank    | Ignored                                                                       |
| `KEY=value`       | Unquoted. Surrounding whitespace trimmed                                      |
| `KEY='value'`     | Literal. No escapes at all, so it cannot contain a single quote               |
| `KEY="value"`     | Escapes are `\n`, `\r`, `\t`, `\f`, `\b`, `\"`, `\'`, `\\`, `\$` and `` \` `` |
| `` KEY=`value` `` | Rejected outright                                                             |
| `export KEY=…`    | The `export ` prefix is accepted and dropped                                  |

Only whitespace or a `#` comment may follow a closing quote.

A duplicate key is an **error**, not last-one-wins. So is an unterminated quote,
an unknown escape, trailing text after a closing quote, an empty or invalid key
name, and a line with no `=`.

:::caution[On an unquoted value, ` #` is refused rather than read]
`PASSWORD=hunter2 # 1` is a password containing a hash to one reader and a
password with a comment after it to the next. Both files exist, and either
reading stores a value you did not write while reporting success — so the line
is refused and you say which you meant. Any one of these is unambiguous:

```bash
PASSWORD="hunter2 # 1"    # the hash is part of the password
PASSWORD="hunter2" # 1    # it is a comment
PASSWORD=hunter2#1        # no whitespace, so nothing to resolve
```

The whitespace is what makes it ambiguous. `COLOR=#ffffff` and `TOKEN=ab#cd`
parse as written.
:::

Every rejection names the line and the key, never the value:

```
error: Line 12: the double-quoted value of "STRIPE_SECRET_KEY" is never closed.
  help: Check for an unescaped double quote inside the value.
```

```
error: Line 8: duplicate key "DATABASE_URL", already set on line 3.
  help: Remove one of the two declarations. This file does not say which value you meant.
```

```
error: Line 4: the unquoted value of "PASSWORD" has a `#` after whitespace, so this line reads as a value containing a hash or as a value with a comment.
  help: Quote the value to keep the `#`, or delete the comment. A `#` with no whitespace in front of it is already part of the value.
```

## `prk secrets download`

Writes the whole environment out.

```bash
prk secrets download --project api --env production
```

```
DATABASE_URL="postgres://app:hunter2@db.example.com:5432/app"
STRIPE_SECRET_KEY="sk_live_51H..."
```

To a file:

```bash
prk secrets download --output .env -P api -E production
```

```
Wrote 12 secrets to .env.
```

`--output` creates the file with mode `0600`, and on Windows with a DACL holding
a single entry for the current user.

### Formats

```bash
prk secrets download --format shell -P api -E production
```

```
export DATABASE_URL='postgres://app:hunter2@db.example.com:5432/app'
export STRIPE_SECRET_KEY='sk_live_51H...'
```

| Format  | Output                                                                              |
| ------- | ----------------------------------------------------------------------------------- |
| `env`   | `KEY="value"`. Escapes `\`, `"`, newline, carriage return, tab. Raw UTF-8 otherwise |
| `shell` | `export KEY='value'`. POSIX single quotes; the only escape is `'` → `'\''`          |
| `yaml`  | Double-quotes **key and value**                                                     |
| `json`  | Sorted keys, deterministic byte output                                              |

Every format quotes **unconditionally** — always, not "when necessary".
Conditional quoting means modelling the consumer's grammar exactly, and a single
miss is either a command injection or a silently altered value.

`shell` uses single quotes because a POSIX shell interprets nothing inside them:
not `$`, not a backtick, not a backslash, not `!`. Closing the quote, emitting
`\'`, and reopening covers every byte sequence.

`yaml` quotes the key as well as the value, which sidesteps the YAML
1.1-versus-1.2 minefield in one move — `yes`/`no`/`on`/`off` as booleans, `null`
and `~`, `12:30` as a sexagesimal integer, `0755` as octal.

`json` sorts its keys and is byte-deterministic, so
`prk secrets download --format json | diff` is meaningful.

:::caution[One value can be unrepresentable in `env` format]
The `env` format emits no `\uXXXX` escapes, because most `.env` consumers read
them back as a literal backslash. A control character the five supported escapes
cannot express is therefore an error — exit code 9,
`UNREPRESENTABLE_OUTPUT` — rather than a silently corrupt line.

Use `--format json` or `--format yaml` for such a value.
:::

## `prk secrets history`

Every version of one key, newest information first.

```bash
prk secrets history DATABASE_URL --project api --env production
```

```
v4	set	you@example.com
v3	set	deploy@example.com
v2	delete	you@example.com	DELETED
v1	set	you@example.com
```

Columns are version, operation, and who did it. A tombstone is shown rather than
skipped — "this key was deleted at version 2" answers half the questions this
command gets asked.

With nothing to show:

```
No history for `DATABASE_URL`.
```

```bash
prk secrets history DATABASE_URL -P api -E production --json
```

```json
[
  {
    "version": 4,
    "op": "set",
    "created_at": 1760000000000,
    "created_by": "you@example.com",
    "kid": "k1",
    "deleted": false
  }
]
```

## `prk secrets rollback`

Restores an earlier value.

```bash
prk secrets rollback DATABASE_URL --to 3 --project api --env production
```

```
Restored `DATABASE_URL` from version 3 as version 5 (rev 46).
```

The old plaintext is decrypted and re-encrypted as a **new** version. The old
envelope stays exactly where it is in history, and the restored value is bound
to its new version — so an old ciphertext blob replayed into the current row
still fails its tag check.

Record why while you are at it:

```bash
prk secrets rollback DATABASE_URL --to 3 --reason "bad connection string in v4" -P api -E production
```

```bash
prk secrets rollback DATABASE_URL --to 3 -P api -E production --json
```

```json
{ "key": "DATABASE_URL", "restored_from": 3, "version": 5, "rev": 46 }
```

## Limits

| Limit                   | Default                                                        | Variable           |
| ----------------------- | -------------------------------------------------------------- | ------------------ |
| Key name                | 1–256 characters: a letter or `_`, then letters, digits or `_` | —                  |
| Value size              | 65536 bytes of UTF-8                                           | `SECRET_MAX_BYTES` |
| Secrets per environment | 500                                                            | `ENV_MAX_SECRETS`  |
| Request body            | 1 MiB                                                          | `BODY_MAX_BYTES`   |
| Description             | 1024 characters                                                | —                  |

The value limit counts **UTF-8 bytes**, so a value of emoji or CJK text is
measured the way it is stored.

`prk` sizes its own read ceiling from the first two rows, so a whole-environment
export at the defaults always fits. Raising `SECRET_MAX_BYTES` or
`ENV_MAX_SECRETS` past their defaults can put an environment beyond what the CLI
will read back — that is `RESPONSE_TOO_LARGE`, exit 12.

## Common errors

| Error                    | Exit | What happened                                                                       | What to do                                                   |
| ------------------------ | ---- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `NOT_FOUND`              | 5    | No such key, version, environment or project — or not visible to you                | Check `prk secrets list`                                     |
| `PRECONDITION_FAILED`    | 6    | `--expected-rev` did not match                                                      | Re-read the revision and re-apply                            |
| `CONFLICT`               | 6    | A concurrent writer took the same version number                                    | Re-run the command                                           |
| `PAYLOAD_TOO_LARGE`      | 11   | The environment would exceed its cap, or a value is too large                       | Split across environments, or raise the limit                |
| `VALIDATION_FAILED`      | 11   | A key name was rejected, or the uploaded document could not be parsed unambiguously | Fix the line the error names; the parser rules are above     |
| `UNREPRESENTABLE_OUTPUT` | 9    | A value cannot be encoded in the chosen format                                      | Use `--format json` or `--format yaml`                       |
| `RESPONSE_TOO_LARGE`     | 12   | The environment holds more secret data than one response can carry                  | `prk secrets list`, then delete or shrink the largest values |
| `DECRYPT_FAILED`         | —    | Stored bytes were not sealed against the row they sit in                            | Treat as tampering; see [Key rotation](/guides/key-rotation) |

## Next steps

- [`prk run`](/reference/cli/run) — hand these secrets to a program.
- [Using secrets](/guides/using-secrets/) — Docker, npm scripts, Workers, CI.
- [Migrate from a `.env` file](/examples/migrate-from-dotenv)
