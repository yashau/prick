---
title: Secrets
description: How secrets are stored, versioned and exported, and the rules that decide what a value can contain.
sidebar:
  order: 3
---

A secret is a key and a value inside one environment. The key name is stored in
plaintext; the value is encrypted. This guide covers how that works and the
rules you will run into.

:::note[Before you begin]
Every command here needs an authenticated machine and a project and environment
to work in. Start with [Authentication](/guides/authentication), and set the
scope once so you can drop the flags:

```bash
export PRK_PROJECT=api
export PRK_ENV=production
```

:::

For the flags on each command, see [`prk secrets`](/reference/cli/secrets).

## Writing a value

```bash
prk secrets set DATABASE_URL
```

The value comes from a masked prompt, or from stdin:

```bash
printf '%s' "$VALUE" | prk secrets set DATABASE_URL --stdin
```

The value is **never** taken as an argument. Anything on a command line is
written to your shell history and visible in `ps` to every user on the machine.
The prompt reads the terminal device directly, which is what lets `--stdin` and
an interactive prompt coexist.

Give it a description while you are there, so a listing tells the next person
what they are looking at:

```bash
prk secrets set STRIPE_SECRET_KEY --description "Live mode, rotates quarterly"
```

Descriptions are stored in plaintext beside the key name. Never put a value in
one.

## Reading

```bash
prk secrets list
```

Lists key names and metadata. Values never appear in a listing.

```bash
prk secrets get DATABASE_URL
```

Fetches exactly one secret rather than downloading the environment to print one
line of it.

Every reveal is audited, and the audit row records **why**: `reveal`, `copy`,
`export` or `run`. That distinction is what lets a reader tell "someone looked
at it" from "someone took it".

## Versioning

Every write creates a new version. Nothing overwrites in place.

```bash
prk secrets history DATABASE_URL
```

```
v4	set	you@example.com
v3	set	deploy@example.com
v2	delete	you@example.com	DELETED
v1	set	you@example.com
```

A delete writes a **tombstone** — a history row with `op = 'delete'` and no
ciphertext — so the record survives. Recreating the key later continues the
sequence rather than restarting at 1, which keeps a version number pointing at
exactly one value for the life of the environment. That matters because the
version is part of what binds each ciphertext to its row.

```bash
prk secrets rollback DATABASE_URL --to 3
```

A rollback decrypts the old value and re-encrypts it as version `current + 1`
with fresh authenticated data. The old envelope stays where it is in history,
and the restored value is bound to its new version — so replaying an old blob
back into the current row still fails its tag check.

:::note[There is no rename]
The key name is part of what each ciphertext is bound to, so a rename means
decrypting under the old identity and re-encrypting under the new one, in one
transaction. Set the new key and delete the old one instead.
:::

## Loading a whole environment

```bash
prk secrets upload .env --dry-run
```

```
3 added, 1 changed, 2 removed (dry run; nothing was written).
```

Upload **replaces** by default: keys the file does not name are deleted. Pass
`--merge` to add without removing. Always dry-run first — `removed` is the
number that bites.

The whole document goes in one request, because a bulk write is one transaction
with its audit row inside it. A failed import leaves the environment exactly as
it was.

Guard against a concurrent change with the environment's revision:

```bash
prk secrets upload .env --expected-rev 42
```

A mismatch is refused with `PRECONDITION_FAILED` (exit 6) and the environment is
left byte-for-byte unchanged.

### The `.env` parser refuses to guess

`.env` has no specification, so implementations disagree at the edges. This one
resolves every ambiguity by refusing: a line it cannot parse unambiguously fails
the **whole** import. Importing a file and silently dropping the two lines the
parser did not understand is how a deploy loses `DATABASE_URL`.

The accepted forms and every rejection are listed in
[`prk secrets upload`](/reference/cli/secrets#the-env-parser-is-strict). The one
worth knowing before you start is that on an unquoted value, whitespace before a
`#` is refused: `PASSWORD=hunter2 # 1` is a password containing a hash to one
reader and a password with a comment to the next, so the file has to say which.
Quote the value to keep the hash, or quote it and leave the comment outside.

For a full walkthrough, see
[Migrate from a `.env` file](/examples/migrate-from-dotenv).

## Exporting

```bash
prk secrets download --format env --output .env
```

`--output` creates the file with mode `0600`.

Four formats are available — `env`, `shell`, `yaml` and `json` — and every one
of them quotes **unconditionally**. Not "quote when necessary": always.
Conditional quoting means modelling the consumer's grammar exactly, and a single
miss is either a command injection or a silently altered value.

Two are worth a sentence:

**`shell`** uses single quotes, because inside them a POSIX shell interprets
nothing — not `$`, not a backtick, not a backslash, not `!`. Closing the quote,
emitting `\'`, and reopening covers every byte sequence. A formatter that
double-quotes and escapes only `"` leaves `$` and backtick live, which turns a
secret value into arbitrary command execution in the consumer's shell.

**`yaml`** quotes the key as well as the value, which sidesteps the YAML
1.1-versus-1.2 minefield in one move: `yes`/`no`/`on`/`off` as booleans, `null`
and `~`, `12:30` read as a sexagesimal integer, `0755` as octal.

The `env` format emits no `\uXXXX` escapes, because most `.env` consumers read
them back as a literal backslash. A control character that its five escapes
cannot express is therefore an error — exit code 9, `UNREPRESENTABLE_OUTPUT` —
rather than a silently corrupt line. Use `json` or `yaml` for such a value.

## Limits

| Limit                   | Default                                                        | Variable           |
| ----------------------- | -------------------------------------------------------------- | ------------------ |
| Key name                | 1–256 characters: a letter or `_`, then letters, digits or `_` | —                  |
| Value size              | 65536 bytes of UTF-8                                           | `SECRET_MAX_BYTES` |
| Secrets per environment | 500                                                            | `ENV_MAX_SECRETS`  |
| Request body            | 1 MiB                                                          | `BODY_MAX_BYTES`   |
| Description             | 1024 characters                                                | —                  |

The value limit counts **UTF-8 bytes** rather than JavaScript string length, so
a value of emoji or CJK text is measured the way it is stored.

The per-environment cap follows from atomicity: a full-environment replace has
to fit in **one** D1 `batch()`, and `batch()` has a documented 30-second
ceiling. Exceeding the cap is a `413`, never a partial write.

:::caution[This number is not yet load-tested]
500 is derived from an undocumented per-batch statement limit against that
documented time ceiling. It must be load-tested before it is trusted. If the
test disagrees, the fix is to lower the cap — never to split the batch.
:::

## When something goes wrong

| Symptom               | Meaning                                                                                                                                                    | What to do                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DECRYPT_FAILED`      | The stored bytes were not sealed against the identity they are being read under: altered ciphertext, or a row moved between environments, keys or versions | Treat it as a tamper attempt until proven otherwise. The error names the environment, key, version and key id — never the value |
| `UNKNOWN_KID`         | The envelope names a master key the ring does not hold                                                                                                     | You probably removed `MASTER_KEY_OLD` too early. See [Key rotation](/guides/key-rotation)                                       |
| `PAYLOAD_TOO_LARGE`   | The environment would exceed `ENV_MAX_SECRETS`, or a value exceeds `SECRET_MAX_BYTES`                                                                      | Split across environments, or raise the variable                                                                                |
| `CONFLICT`            | Another writer took the same version number                                                                                                                | Re-run the command                                                                                                              |
| `PRECONDITION_FAILED` | `--expected-rev` did not match                                                                                                                             | Re-read the revision and re-apply                                                                                               |
| Exit code 9           | A value contains a control character the chosen format cannot encode                                                                                       | Use `--format json` or `--format yaml`                                                                                          |

A decrypt failure is never swallowed. On a reveal it fails the request; in a
listing the row is marked `UNREADABLE` and a warning tells you not to deploy
from that environment. Both write an audit row with `outcome = 'error'`. A
tamper attempt is meant to be the loudest thing in the system.

## Next steps

- [Using secrets](/guides/using-secrets/) — Docker, npm scripts, Workers, CI.
- [`prk secrets`](/reference/cli/secrets) — every flag, with examples.
- [Key rotation](/guides/key-rotation)
- [Encryption](/architecture/encryption) — what binds a ciphertext to its row.
