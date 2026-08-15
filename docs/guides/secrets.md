---
title: Secrets
description: Reading, writing, versioning and exporting secrets, and the limits and escaping rules that apply.
sidebar:
  order: 3
---

:::note[Authenticate first]
Every command here needs an authenticated machine. Start with
[Authentication](/guides/authentication).
:::

:::caution[Not implemented]
The secrets domain layer is a set of stubs
(`packages/app/src/lib/server/core/secrets.ts` — every function throws
`NOT_IMPLEMENTED`), no secrets route is mounted, and the CLI commands are
argument definitions only. The interface below is fixed and the constraints are
real; the behaviour is not there yet.
:::

Every command on this page operates on one environment, so it needs a project
and an environment. Give them as flags or as `PRK_PROJECT` / `PRK_ENV`.

## Listing

```bash
prk secrets list --project api --env production
```

Lists key names and metadata. **Never values.** A row whose ciphertext will not
decrypt comes back marked unreadable rather than being dropped from the list —
see [Failure modes](#failure-modes).

## Reading one value

```bash
prk secrets get DATABASE_URL --project api --env production
```

Fetches exactly one secret. It does not download the environment in order to
print one line of it.

Every reveal is audited, with the reason recorded: `reveal`, `copy`, `export` or
`run`. That distinction is what lets a reader tell "someone looked at it" from
"someone took it".

## Writing

```bash
prk secrets set DATABASE_URL --project api --env production
```

The value is **never** an argument. It comes from a masked prompt read directly
from the terminal device, or from stdin:

```bash
printf '%s' "$VALUE" | prk secrets set DATABASE_URL --stdin --project api --env production
```

A value passed on the command line would be in your shell history and visible in
`ps` to every user on the machine. Reading the prompt from `/dev/tty` rather than
from stdin is what lets `--stdin` and an interactive prompt coexist.

Attach a description while you are there:

```bash
prk secrets set STRIPE_SECRET_KEY --description "Live mode, rotates quarterly" --project api --env production
```

## Deleting

```bash
prk secrets rm OLD_TOKEN --project api --env production
```

A delete writes a tombstone version — a history row with `op = 'delete'` and no
ciphertext — rather than erasing history. Recreating the key later **continues**
the version sequence instead of restarting at 1, so a version number never
refers to two different values in one environment. That matters, because the
version is inside the authenticated data that binds each ciphertext to its row.

## Bulk upload from a `.env` file

```bash
prk secrets upload .env --project api --env production
```

Preview first:

```bash
prk secrets upload .env --dry-run --project api --env production
```

Guard against a concurrent change:

```bash
prk secrets upload .env --expected-rev 42 --project api --env production
```

A mismatched revision is refused with exit code 6 and the environment is left
unchanged.

### The `.env` parser is strict

`.env` has no specification, so implementations disagree at the edges. This one
resolves every ambiguity by **refusing to guess**: a line it cannot parse
unambiguously fails the whole import. Importing a file and silently dropping the
two lines the parser did not understand is how a deploy loses `DATABASE_URL`.

| Form | Meaning |
|---|---|
| `# …` or blank | Ignored |
| `KEY=value` | Unquoted. Trailing whitespace trimmed, no escapes, **no inline comment** |
| `KEY='value'` | Literal. No escapes at all; `\` is a backslash |
| `KEY="value"` | `\\`, `\"`, `\n`, `\r`, `\t` are escapes; everything else is literal |
| `export KEY=…` | The `export ` prefix is accepted and dropped |

Unquoted values deliberately do not support a trailing `# comment`: a password
ending in ` # 1` is far more likely than a comment on a secret line, and guessing
wrong truncates the value.

A duplicate key is an **error**, not last-one-wins. So is an unterminated quote,
an unknown escape, trailing text after a closing quote, and a line with no `=`.

Source: `crates/prick-core/src/dotenv.rs`.

## Downloading

```bash
prk secrets download --project api --env production
```

```bash
prk secrets download --format json --output secrets.json --project api --env production
```

`--output` creates the file with mode `0600`. A world-readable file of secrets is
the same defect whether it happens by mistake or by default.

### Formats and escaping

Every format quotes **unconditionally**. Not "quote when necessary" — always.
Conditional quoting means modelling the consumer's grammar exactly, and a single
miss is a command injection or a silently altered value.

| Format | Rule |
|---|---|
| `env` | `KEY="value"`. Escapes `\`, `"`, newline, carriage return, tab. Raw UTF-8 otherwise |
| `shell` | `export KEY='value'`. POSIX single quotes; the only escape is `'` → `'\''` |
| `yaml` | Double-quotes **key and value** |
| `json` | Sorted keys, deterministic byte output |

Two of those deserve a sentence.

**`shell`** uses single quotes because inside them a POSIX shell interprets
nothing — not `$`, not a backtick, not a backslash, not `!`. Closing the quote,
emitting `\'`, and reopening is therefore total: any byte sequence round-trips.
A formatter that double-quotes and escapes only `"` leaves `$` and backtick live,
which turns a secret value into arbitrary command execution in the consumer's
shell.

**`yaml`** quotes the key as well as the value, which sidesteps the whole YAML
1.1-versus-1.2 minefield in one move: `yes`/`no`/`on`/`off` as booleans,
`null` and `~`, `12:30` read as a sexagesimal integer, `0755` as octal.

The `env` format does **not** emit `\uXXXX` escapes, because most `.env`
consumers do not implement them and would read the value back as a literal
backslash. A control character that the five supported escapes cannot express is
therefore an error — exit code 9, `UNREPRESENTABLE_OUTPUT` — never a silently
corrupt line. Use `--format json` or `--format yaml` for such a value.

Source: `crates/prick-core/src/format.rs`.

## History and rollback

```bash
prk secrets history DATABASE_URL --project api --env production
```

```bash
prk secrets rollback DATABASE_URL --to 3 --project api --env production
```

A rollback does **not** resurrect the old ciphertext. The old value is decrypted
and re-encrypted as version `current + 1` with fresh authenticated data. The old
envelope stays exactly where it was in history, and the restored value is bound
to its new version — so replaying an old blob back into the current row still
fails.

There is no rename command in the CLI. A rename is not cheap: the key name is
part of what each ciphertext is bound to, so renaming means decrypt under the old
identity and re-encrypt under the new one, in one transaction.

## Limits

| Limit | Default | Var |
|---|---|---|
| Key name | 1–256 characters, POSIX env var name: a letter or `_`, then letters, digits or `_` | — |
| Value size | 65536 bytes of UTF-8 | `SECRET_MAX_BYTES` |
| Secrets per environment | 500 | `ENV_MAX_SECRETS` |
| Request body | 1 MiB | `BODY_MAX_BYTES` |
| Description | 1024 characters | — |

The value limit is counted in **UTF-8 bytes**, not JavaScript string length. A
limit checked against string length would let a value of emoji or CJK text
through at three or four times the intended size.

The per-environment cap is not arbitrary. A full-environment replace has to fit
in **one** D1 `batch()`, because splitting it across batches would forfeit
atomicity, and `batch()` has a documented 30-second ceiling. Exceeding the cap is
a `413`, not a partial write.

:::caution[This number is not yet load-tested]
500 is derived from an undocumented per-batch statement limit against that
documented time ceiling. It must be load-tested before it is trusted. If the
test disagrees, the fix is to lower the cap — never to split the batch.
:::

## Failure modes

| Symptom | Meaning | What to do |
|---|---|---|
| `DECRYPT_FAILED` | The stored bytes were not sealed against the identity they are being read under: altered ciphertext, or a row moved between environments, keys or versions | Treat it as a tamper attempt until proven otherwise. The error names the environment, key, version and key id — never the value |
| `UNKNOWN_KID` | The envelope names a master key the ring does not hold | You probably removed `MASTER_KEY_OLD` too early. See [Key rotation](/guides/key-rotation) |
| `PAYLOAD_TOO_LARGE` | The environment would exceed `ENV_MAX_SECRETS`, or a value exceeds `SECRET_MAX_BYTES` | Split across environments, or raise the var |
| `CONFLICT` | Another writer took the same version number, twice | Re-run the command |
| `PRECONDITION_FAILED` | `--expected-rev` did not match | Re-read and re-apply |
| Exit code 9 | A value contains a control character the chosen format cannot encode | Use `--format json` or `--format yaml` |

A decrypt failure is never swallowed. On a reveal it fails the request; in a
listing the row is marked unreadable. Both write an audit row with
`outcome = 'error'`. A tamper attempt is meant to be the loudest thing in the
system.

## Next

- [Using secrets](/guides/using-secrets/) — Docker, npm scripts, Workers, CI.
- [Key rotation](/guides/key-rotation)
- [Encryption](/architecture/encryption)
