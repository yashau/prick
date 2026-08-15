---
title: Key rotation
description: Rotating MASTER_KEY with MASTER_KEY_OLD, re-encrypting incrementally, and the one irreversible mistake.
sidebar:
  order: 7
---

:::note[Authenticate first]
The CLI and UI steps here need an authenticated machine. The `wrangler` steps
need Cloudflare credentials instead. Start with
[Authentication](/guides/authentication).
:::

Rotation replaces the master key without downtime and without a bulk migration
window. Two keys are loaded at once: the new one, which everything is written
under, and the retired one, which old rows are still read under.

:::caution[Partly implemented]
The key ring, the two-key derivation and the validation are implemented
(`packages/app/src/lib/server/crypto/keyring.ts`). The re-encryption job is not:
`getKeyringStatus` and `rekeyPage` are stubs, `POST /api/v1/admin/rekey` is not
mounted, no cron trigger is configured, and the settings screen does not exist.

So in this build you can _start_ a rotation and old rows keep working — but
there is no way to finish one, and therefore no point at which it is safe to
remove `MASTER_KEY_OLD`. Do not remove it.
:::

## The rule

**Never remove a retired key while any row still references its key id.** Those
values become permanently undecryptable. It is the one irreversible mistake
available in this design, which is why the readiness signal is meant to be
computed rather than judged.

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

```bash
prk secrets set DATABASE_URL --project api --env production
```

Any write to a secret produces a new version under the active key, so ordinary
traffic migrates rows on its own. The dedicated job does the rest a page at a
time, so no single request has to re-encrypt a large database.

:::caution[Not implemented]
The rekey job and its endpoint do not exist yet. Ordinary writes do migrate
individual rows once the secrets write path is implemented, but there is
currently no mechanism to sweep the ones nobody touches.
:::

### 6. Wait for zero, then remove the retired key

`keyring_state` holds one row per key id ever observed, with a `rows_remaining`
count. It is **recomputed** by the rekey job rather than maintained as a running
counter, because a "safe to remove" indicator derived from a number that drifted
is worse than no indicator at all.

Only when the retired key id reports zero rows may you remove it:

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

If it belongs to a key you never had, that row did not come from this
deployment. Investigate where it came from before you do anything else.

This is exactly why the failure is a distinct error code and not a generic
"decryption failed": _restore the key_ and _investigate a compromise_ are
opposite responses, and one message cannot tell them apart.

## How often

There is no rule here that is right for every install. Rotate when you have
reason to: a person with deploy access leaves, a laptop is lost, an audit
requires it. Rotating on a calendar with no way to complete the migration is
worse than not rotating — you accumulate retired keys you can never remove.

## Next

- [Backup and recovery](/guides/backup-and-recovery)
- [Encryption](/architecture/encryption)
- [Configuration](/reference/configuration)
