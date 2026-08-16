---
title: Key rotation
description: Rotating MASTER_KEY with MASTER_KEY_OLD, re-encrypting incrementally, and the one irreversible mistake.
sidebar:
  order: 7
---

:::note[Before you begin]
The CLI and UI steps here need an authenticated machine. The `wrangler` steps
need Cloudflare credentials instead. Start with
[Authentication](/guides/authentication).
:::

Rotation replaces the master key without downtime and without a bulk migration
window. Two keys are loaded at once: the new one, which everything is written
under, and the retired one, which old rows are still read under.

The whole job, before you start:

1. Generate a new key, and back it up.
2. Move the current key to `MASTER_KEY_OLD`.
3. Install the new key as `MASTER_KEY`.
4. Deploy. New writes now use the new key.
5. Re-encrypt existing rows, one page at a time, until `remaining` is zero.
6. Only then, remove the retired key.

Steps 1 to 4 take minutes. Step 5 takes as long as it takes, and you can leave
it part-way done safely — both keys stay loaded until you remove one.

:::note[This is about `MASTER_KEY`, not an application secret]
If a stored value such as a Stripe key leaked, you want
[Respond to a leaked secret](/examples/rotate-a-leaked-key) instead. This page
is about the key that encrypts everything.
:::

:::caution[You drive the rekey]
The rekey runs when you run it. Three things drive it and they reach the same
function: `prk keyring rekey`, the **Run one page now** button on the settings
screen, and `POST /api/v1/admin/rekey`. Each invocation moves one bounded page
and tells you how many rows are left. Repeat until that number is zero —
`prk keyring rekey --until-done` runs the loop for you.
:::

## The rule

**Never remove a retired key while any row still references its key id.** Those
values become permanently undecryptable. It is the one irreversible mistake
available in this design, which is why the readiness signal is computed rather
than judged: `GET /api/v1/admin/keyring` counts the actual rows in
`secret_versions`, grouped by the key id in each envelope, every time it is
asked. It never reports a cached number.

Both admin routes require a **global admin** grant. An admin grant on a project
or a single environment is not enough — the key ring is installation-wide.

## The flow

### 1. Generate the new key

```bash
openssl rand -base64 32
```

Back it up before you install it — a Worker secret cannot be read back. See
[Backup and recovery](/guides/backup-and-recovery).

### 2. Move the current key to `MASTER_KEY_OLD`

You need the value of the key currently in use. This is the step that fails if
you never recorded it.

```bash
pnpm --dir packages/app exec wrangler secret put MASTER_KEY_OLD
```

`MASTER_KEY_OLD` may name **more than one** retired key, comma-separated. Base64
contains no comma in either alphabet, so the separator is unambiguous here.

### 3. Install the new key

```bash
pnpm --dir packages/app exec wrangler secret put MASTER_KEY
```

Each entry must be base64 that decodes to exactly 32 bytes, and the ring refuses
to build otherwise. Two specific refusals are worth knowing, because both mean
the rotation has not actually happened:

- A retired key that is byte-identical to the active key. The "safe to remove"
  signal would go green while nothing had moved.
- Two keys in the ring that derive the same key id. A row could not then be
  attributed to the key that protects it, and the rekey job could not tell what
  is left to do.

### 4. Deploy

```bash
pnpm --dir packages/app exec wrangler deploy
```

From this moment, **new writes use the new key**. Existing rows still decrypt
under the retired one. Nothing is written under a retired key, ever — a retired
key is decrypt-only.

### 5. Re-encrypt, incrementally

Two things move rows onto the new key, and you generally want both.

**Ordinary writes.** Any write to a secret produces a new version sealed under
the active key, so normal traffic migrates rows on its own:

```bash
prk secrets set DATABASE_URL --project api --env production
```

**The rekey**, for everything nobody is touching:

```bash
prk keyring rekey --until-done
```

```
Re-encrypted 2417 row(s) over 25 page(s); 0 remaining.
```

Or one page at a time — from the command line, from the settings screen's **Run
one page now** button, or from `POST /api/v1/admin/rekey` directly:

```bash
prk keyring rekey
```

```
Re-encrypted 100 row(s) over 1 page(s); 2317 remaining.
```

One page is one database transaction, capped at 100 rows: the whole page commits
in a single `batch()`, splitting it across two would mean a failure in the second
left the first committed, and D1 documents a 30-second ceiling on a transaction.
A `limit` above 100 is refused rather than clamped, so a caller pacing itself off
the number it asked for cannot be wrong about what moved.

Repeat while `remaining` is above zero. The operation is resumable, and repeating
a call that already succeeded is a no-op rather than a second pass — so
interrupting `--until-done` costs you nothing but the pages you had left.

Every flag is on the [`prk keyring`](/reference/cli/keyring) reference page.

What a page does to each row: decrypt under the key the envelope names,
re-encrypt under the active key with the **identical** authenticated data, and
update the row in place. The row keeps its id, its environment, its key name,
its version and its history position. The environment's revision counter is not
bumped, so a rekey never invalidates an `expected_rev` a client is holding.

**History is rekeyed too**, not just the current version of each secret. A
rollback decrypts an arbitrary earlier version, so a version left behind under a
retired key is a rollback that stops working the moment the key is removed.
Deletion tombstones carry no ciphertext and no key id, so they are neither
counted nor touched.

:::danger[A row that will not open stops the whole page]
If any row in a page fails authenticated decryption, the page fails: an audit
row is written with `outcome: 'error'` naming the key and the key id, nothing is
re-encrypted, and the request returns an error. The rekey does not skip the row
and carry on — a skipped row would be left behind under a key you are about to
delete while the remaining count fell to zero anyway, which is the one outcome
that turns a maintenance job into data loss.

`UNKNOWN_KID` means the envelope names a key the ring does not hold — restore it
in `MASTER_KEY_OLD`. `DECRYPT_FAILED` means the bytes were not sealed against
the identity they are stored under; treat that as tampering until proven
otherwise.
:::

### 6. Wait for zero, then remove the retired key

```bash
prk keyring status
```

```
9d1c8f2a4b6e0d31	active	0 row(s)
4f2a9c1e7b3d5a08	retiring	0 row(s)
```

```
Nothing references a retired key. `MASTER_KEY_OLD` can be removed; redeploy after you delete it.
```

The settings screen is the same readout. `keyring_state` holds one row per key
id ever observed, and its `rows_remaining` is **recomputed** by the rekey from
the real rows rather than decremented as a running counter — a counter that
drifted by one in the direction of zero is a green light on an installation that
is not safe. Neither readout reads that column at all: both count live, every
time they are asked.

`safeToRemoveOldKey` goes true only when every non-active key id reports zero.
It is also held false by a stored value the server cannot attribute to any key
id — a row like that cannot have been written by this application, so nothing
can say which key protects it, and an unknown must not read as safe. Investigate
that before removing anything.

Only when every retired key id reports zero rows may you remove it:

```bash
pnpm --dir packages/app exec wrangler secret delete MASTER_KEY_OLD
```

```bash
pnpm --dir packages/app exec wrangler deploy
```

## Why a rekey does not bump the version

A rekey re-encrypts a value under the **identical** authenticated data, changing
only which key protects it. The version does not change, and neither does the
row's identity.

That works because the key id lives in the **envelope** and not in the AAD. If
the key id were part of the AAD, every rekey would be a version bump, and
rotating a key would rewrite the history of every secret you own. See
[Encryption](/architecture/encryption#what-is-bound-and-what-is-not).

## If you removed the key too early

```
No master key with id 4f2a9c1e7b3d5a08 is loaded. The keyring holds: 9d1c…
```

`UNKNOWN_KID` names the id it wanted and lists the ids it has. If that id belongs
to a key you retired, restore it in `MASTER_KEY_OLD` and redeploy — the data is
fine, the ring is not.

The settings screen shows the same thing before it becomes an error: a key id
that the ring no longer holds is listed as `retired`, and if it still has rows
against it, the indicator stays red.

If it belongs to a key you never had, that row did not come from this
deployment. Investigate where it came from before you do anything else.

This is exactly why the failure is a distinct error code and not a generic
"decryption failed": _restore the key_ and _investigate a compromise_ are
opposite responses, and one message cannot tell them apart.

## How often

There is no rule here that is right for every install. Rotate when you have
reason to: a person with deploy access leaves, a laptop is lost, an audit
requires it. Rotating on a calendar without following the migration through to
zero is worse than not rotating — you accumulate retired keys you can never
remove.

## Next steps

- [`prk keyring`](/reference/cli/keyring) — every flag on the two commands above.
- [Backup and recovery](/guides/backup-and-recovery)
- [Encryption](/architecture/encryption)
- [Configuration](/reference/configuration)
