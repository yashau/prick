---
title: prk keyring
description: Read the master key ring, and drive a rotation to zero from the command line.
sidebar:
  order: 8
---

Both subcommands need a **global** admin grant. The key ring is
installation-wide, so an admin grant on a project or a single environment is not
enough.

```
prk keyring status
prk keyring rekey [--limit <ROWS>] [--pages <N>] [--until-done]
```

This is the command-line half of the settings screen. Same two operations, same
two endpoints, same domain function underneath — see
[Key rotation](/guides/key-rotation) for the whole job, of which this is step 5.

## `prk keyring status`

Every key id the installation has ever written under, and how many rows still
reference each.

```bash
prk keyring status
```

```
9d1c8f2a4b6e0d31	active	0 row(s)
4f2a9c1e7b3d5a08	retiring	2417 row(s)
```

```
Rows still reference a retired key. Do NOT remove `MASTER_KEY_OLD`: those values would become permanently undecryptable. Run `prk keyring rekey --until-done`.
```

Columns are key id, status, and rows remaining. The three statuses:

| Status     | Means                                                |
| ---------- | ---------------------------------------------------- |
| `active`   | Everything is written under this key today           |
| `retiring` | The ring still holds it, and rows still reference it |
| `retired`  | The ring no longer holds this key at all             |

A `retired` entry with rows against it is the one to investigate before doing
anything else: those rows cannot be decrypted until the key is put back in
`MASTER_KEY_OLD`. See
[If you removed the key too early](/guides/key-rotation#if-you-removed-the-key-too-early).

When the rotation is finished:

```
Nothing references a retired key. `MASTER_KEY_OLD` can be removed; redeploy after you delete it.
```

That line is the **only** thing to act on. The counts are taken live over
`secret_versions` every time you ask, and they cover history as well as current
versions — an earlier version stranded under a retired key id is a rollback that
stops working the moment the key goes.

```bash
prk keyring status --json
```

```json
{
  "active_kid": "9d1c8f2a4b6e0d31",
  "entries": [
    {
      "kid": "9d1c8f2a4b6e0d31",
      "status": "active",
      "rows_remaining": 0,
      "last_rekey_at": null
    },
    {
      "kid": "4f2a9c1e7b3d5a08",
      "status": "retiring",
      "rows_remaining": 2417,
      "last_rekey_at": 1760000000000
    }
  ],
  "safe_to_remove_old_key": false
}
```

## `prk keyring rekey`

Re-encrypts rows onto the active key, one page at a time.

```bash
prk keyring rekey
```

```
Re-encrypted 100 row(s) over 1 page(s); 2317 remaining.
```

```
Run it again to move the next page.
```

| Flag             | Default | Meaning                                              |
| ---------------- | ------- | ---------------------------------------------------- |
| `--limit <ROWS>` | `100`   | Rows per page. 1 to 100                              |
| `--pages <N>`    | `1`     | How many pages this invocation may move              |
| `--until-done`   | off     | Keep going until nothing is left under a retired key |

**The default moves exactly one page.** Running the command for the first time
is finding out what it does, so the default is the one that cannot surprise.

### Run it to completion

```bash
prk keyring rekey --until-done
```

```
Re-encrypted 2417 row(s) over 25 page(s); 0 remaining.
```

```
Nothing is left under a retired key. Confirm with `prk keyring status` before removing `MASTER_KEY_OLD`.
```

Interrupting this is safe. Every key in the ring stays loaded until you remove
one, so a rotation left part-way is a rotation that is part-way — not a broken
installation. Re-run it and it picks up where it stopped.

### Bound a maintenance window

```bash
prk keyring rekey --pages 5
```

`--pages` and `--until-done` are mutually exclusive: "five pages, but also all of
them" has no meaning, and resolving it by precedence would silently ignore one of
the two flags you typed.

### Under `--json`

```bash
prk keyring rekey --until-done --json
```

```json
{ "pages": 25, "rekeyed": 2417, "remaining": 0, "stalled": false }
```

The totals are for the **invocation**, not for its last page, so a script can
branch on `remaining` without tracking pages itself.

`stalled` is true when a page re-encrypted nothing while rows were still
outstanding. `--until-done` stops there rather than spinning, and the warning
points at `prk keyring status` — a key id listed as `retired` with rows against
it needs its key restored in `MASTER_KEY_OLD` before a rekey can move those
rows.

## Why the loop is on this side

A page is one D1 `batch()`, and D1 documents a ceiling on how long one may take.
A server-side "do it all" would either exceed that or split the work across
transactions — and splitting is what this design refuses everywhere: a failure in
the second half would leave the first committed. Repeating a bounded, resumable
call is the shape that survives being interrupted.

The server refuses a `--limit` above 100 rather than clamping it, so `prk`
refuses it locally too and names the flag you typed. A clamp would answer 100 to
a request for 1000 and report success, and a caller pacing itself off the number
it asked for would be wrong by a factor of ten with nothing to notice.

## A page that will not open stops there

If any row in a page fails authenticated decryption, the page fails: an audit row
is written with `outcome: 'error'`, nothing in that page is re-encrypted, and the
command exits non-zero. It does not skip the row and carry on — a skipped row
would be left behind under a key you are about to delete while the remaining
count fell to zero anyway.

| Error          | Exit | Means                                                            |
| -------------- | ---- | ---------------------------------------------------------------- |
| `FORBIDDEN`    | 4    | Your admin grant is scoped below global                          |
| `SERVER_ERROR` | 8    | `UNKNOWN_KID` — restore the key in `MASTER_KEY_OLD` and redeploy |
| `SERVER_ERROR` | 8    | `DECRYPT_FAILED` — treat as tampering until proven otherwise     |

## Next steps

- [Key rotation](/guides/key-rotation) — the whole job, start to finish.
- [Backup and recovery](/guides/backup-and-recovery) — do this before you rotate.
- [Exit codes and errors](/reference/cli/errors)
