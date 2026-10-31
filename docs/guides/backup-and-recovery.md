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

:::note[Before you begin]
The CLI commands here need an authenticated machine. The `wrangler` commands
need Cloudflare credentials instead. Start with
[Authentication](/guides/authentication).
:::

## There are two things to back up

| Thing                                   | Where it lives  | Backed up how                         |
| --------------------------------------- | --------------- | ------------------------------------- |
| `MASTER_KEY` (and any `MASTER_KEY_OLD`) | A Worker secret | By you, at the moment you generate it |
| The D1 database                         | Cloudflare      | `wrangler d1 export`                  |

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

6. Read a secret back and compare it against something you know:

   ```bash
   prk secrets list --project api --env production
   ```

   ```
   DATABASE_URL	v4	you@example.com	none
   STRIPE_SECRET_KEY	v2	deploy@example.com	none
   ```

   ```bash
   prk secrets get DATABASE_URL --project api --env production
   ```

   A listing proves the rows are there; only a `get` proves they decrypt. A
   restore you have not read a value out of is not a restore you have tested.

## The instance id follows the database

Every deployment has an **instance id**: 32 random hex characters, generated by
the migration that creates the database's tables and stored in D1 alongside
your data. Authenticated responses carry it in the `Prick-Instance` header, and
`prk` pins it in each profile so that a profile only ever talks to the
deployment it was created against.

Because the id is a row in the database, it moves with the data. That has
three consequences:

- **Restoring a backup keeps it.** An export taken after the migration that
  created the `instance` row (`0004_instance_row.sql`) contains that row, so the
  restored database answers with the id it had, and profiles that point at its
  hostname keep working.
- **A backup from before that migration does not have one.** Restoring it and
  applying the migrations generates a new id, and every command from a profile
  pinned to the old id fails with `INSTANCE_MISMATCH` until the profile is
  re-added (below).
- **A database loaded from another one's export shares its id.** A restore
  test, or a staging copy seeded from production, answers with production's id
  until you give it its own. A profile, a project's `[[allow]]` list or
  `--expect-instance` pinned to production then accepts the copy. Give every
  copy you keep running its own id:

  ```bash
  pnpm --dir packages/app exec wrangler d1 execute <COPY_DATABASE> --remote     --command "UPDATE instance SET id = lower(hex(randomblob(16)));"
  ```

  Then redeploy the copy's Worker. Each Worker isolate reads the id once and
  keeps it, so a running isolate goes on reporting the old id until it is
  replaced.

A database built by running the migrations against an empty D1 also gets its
own id. Put it behind a hostname that profiles already point at, and those
profiles refuse to talk to it: the data behind that URL is no longer the data
the profile was created against.

### Do not roll the Worker back past the instance id

A Worker deployed from a release before the instance id existed reports no id
at all, and every command from a pinned profile then fails with
`INSTANCE_UNVERIFIED`. Fix forward instead: redeploy the current release, whose
migrations are additive and leave the instance row in place, and the pinned
profiles work again with nothing to do on any client. If the older Worker has
to stay, every client re-adds its profile against it, as below, and re-adds it
again once the newer Worker returns with its id.

To point a profile at a database with a new id, remove it and log in again:

```bash
prk profile remove production
prk login https://prick.example.com
```

## Test the restore before you need it

Restore into a throwaway database and a throwaway Worker on a schedule you can
keep. The throwaway answers with production's instance id; give it its own id
as above if it stays up longer than the test. The failure this catches is specific and common: the export ran for
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

## Next steps

- [Key rotation](/guides/key-rotation)
- [Encryption](/architecture/encryption)
- [Threat model](/architecture/threat-model)
