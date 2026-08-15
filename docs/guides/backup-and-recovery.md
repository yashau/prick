---
title: Backup and recovery
description: What to back up, why a database export on its own is worthless, and how to restore.
sidebar:
  order: 6
---

:::danger[A D1 export without `MASTER_KEY` is just ciphertext]
Secret values are encrypted with a key derived from `MASTER_KEY`. That key is
**not** in the database, not in `wrangler.jsonc`, and not in any export.

If you lose `MASTER_KEY`, every value in every backup you hold is permanently
unrecoverable. There is no recovery key, no escrow, and no vendor who can help.
Cloudflare cannot read a Worker secret back to you either.

This is the single most common way people lose everything. Back up the key
**before** you store the first secret.
:::

:::note[Authenticate first]
The CLI commands here need an authenticated machine. The `wrangler` commands
need Cloudflare credentials instead. Start with
[Authentication](/guides/authentication).
:::

## There are two things to back up

| Thing | Where it lives | Backed up how |
|---|---|---|
| `MASTER_KEY` (and any `MASTER_KEY_OLD`) | A Worker secret | By you, at the moment you generate it |
| The D1 database | Cloudflare | `wrangler d1 export` |

Both are required. Either one alone is useless.

## Backing up `MASTER_KEY`

A Worker secret is write-only. Once installed you can list its name, but you
cannot read the value back — not through `wrangler`, not through the dashboard.
So the only moment you can capture it is when you generate it:

```bash
openssl rand -base64 32
```

Store that string somewhere durable and independent of this deployment:

- A password manager, in a vault that more than one person can reach.
- Offline, in a safe, if that suits your organisation.
- **Not** in prick. A secrets manager cannot hold the key that decrypts itself.
- **Not** in the same repository, CI system or cloud account as the Worker.

More than one person should be able to recover it. A key only the person who
left the company can reach is a key you have already lost.

If you have already installed a key you did not record, generate a new one and
[rotate](/guides/key-rotation) to it.

### Confirming that a key matches a database

Each master key derives a **key id** — the first 8 bytes of an HKDF output,
rendered as 16 hex characters — and every stored row carries the id of the key it
was sealed under. So the key and the data cannot drift apart silently: restore a
database against the wrong `MASTER_KEY` and reads fail with `UNKNOWN_KID`, and
the error names the id it wanted and lists the ids it has.

That is a diagnosis, not a repair. Find the right key.

## Backing up the database

```bash
pnpm --dir packages/app exec wrangler d1 export prick --remote --output backup.sql
```

Check `wrangler d1 export --help` for the flags your pinned version accepts.

Cloudflare also keeps a point-in-time history of D1 databases, which recovers
from an accidental delete without a file of your own — see Cloudflare's
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) and
[import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
documentation. It is a complement to your own export, not a replacement:
Time Travel is bounded in time and lives in the same account as the thing it is
protecting.

### What the export contains

Encrypted:

- Secret **values**, one row per version, as base64url envelopes.

Plaintext:

- Secret **key names** — `DATABASE_URL`, `STRIPE_SECRET_KEY`.
- Project and environment names, slugs and descriptions.
- Identity subjects: email addresses and service token common names.
- Grants, and the complete audit log.

That is a deliberate trade for queryability, and it is documented rather than
hidden — see [Threat model](/architecture/threat-model). The practical
consequence: **treat the export as sensitive**. It reveals your whole
organisational structure and who touched what, even though the values are safe.

Encrypt the file at rest.

## Restoring

1. Create a database if you are restoring into a new account:

   ```bash
   pnpm --dir packages/app exec wrangler d1 create prick
   ```

2. Put the returned `database_id` in `packages/app/wrangler.jsonc`.

3. Load the export:

   ```bash
   pnpm --dir packages/app exec wrangler d1 execute prick --remote --file backup.sql
   ```

4. Install the **same** `MASTER_KEY` the export was written under:

   ```bash
   pnpm --dir packages/app exec wrangler secret put MASTER_KEY
   ```

   If the data spans a rotation, install `MASTER_KEY_OLD` too. See
   [Key rotation](/guides/key-rotation).

5. Deploy, and verify:

   ```bash
   pnpm --dir packages/app exec wrangler deploy
   ```

6. Read a secret back and compare it against something you know. A restore you
   have not read a value out of is not a restore you have tested.

## Test the restore before you need it

Restore into a throwaway database and a throwaway Worker on a schedule you can
keep. The failure this catches is specific and common: the export ran for
months, and the key it was encrypted under was replaced at some point by someone
who did not update the backup.

Two things make the test cheap:

- The key id in every row tells you immediately whether the key you hold matches
  the data you restored.
- A decrypt failure is loud. Nothing in prick silently skips a row it cannot
  read, so "the restore worked but three values are missing" is not a state that
  can occur without an error.

## Deleting things

Deleting a project cascades to its environments, secrets and version history —
foreign keys are enforced, so it really is gone. The audit log is not touched:
audit rows deliberately carry no foreign key to the things they name, so history
survives the deletion of its subject.

There is no undelete. Restore from a backup.

## Next

- [Key rotation](/guides/key-rotation)
- [Encryption](/architecture/encryption)
- [Threat model](/architecture/threat-model)
