---
title: Access control
description: Identities, roles, scopes and grants, plus how the first administrator comes to exist.
sidebar:
  order: 5
---

:::note[Authenticate first]
Every command here needs an authenticated machine. Start with
[Authentication](/guides/authentication).
:::

Cloudflare Access decides **who** may reach the Worker. prick decides **what**
they may do, from its own `grants` table.

:::caution[Partly implemented]
Grant resolution, the bootstrap path and the denial audit are implemented and
tested (`packages/app/src/lib/server/auth/`). Listing, creating and revoking
grants are stubs (`.../core/identities.ts`), no route is mounted, and the
`prk access` commands are argument definitions only.
:::

## Identities

An identity is a subject prick has seen authenticate. There are exactly two
kinds, and neither is created by prick:

| Kind      | Subject                           | Comes from              |
| --------- | --------------------------------- | ----------------------- |
| `user`    | The lower-cased email address     | An Access SSO session   |
| `service` | The service token's `common_name` | An Access service token |

A service token subject looks like `e367826f93b8d71185e03fe518aff3b4.access`.
Give it a display name as soon as you grant it, because nobody maps that string
to "the staging deploy job" from memory.

Every identity has a `disabled` flag. It is a kill switch: it is checked before
grants are resolved, so disabling an identity is one write rather than a hunt
for its rows. A disabled identity resolves to **nothing** — including when it is
named in `BOOTSTRAP_ADMINS`, because a kill switch that a config variable can
override is worthless exactly when it is being used in anger.

## Roles

| Role     | Can                                         |
| -------- | ------------------------------------------- |
| `reader` | Read secret metadata and values             |
| `writer` | Everything a reader can, plus write secrets |
| `admin`  | Everything a writer can, plus manage grants |

They are totally ordered: `reader < writer < admin`.

## Scopes

| Scope         | Covers                           |
| ------------- | -------------------------------- |
| `global`      | Everything                       |
| `project`     | Every environment in one project |
| `environment` | One environment                  |

Grants inherit **downwards only**. A global grant covers every project; a project
grant covers every environment in it. An environment admin is not a project
admin.

Your effective role at a scope is the **maximum** over every matching,
non-expired grant, resolved once per request. A 200-secret operation performs one
authorization query, not two hundred.

### There is no god mode

A global administrator is an ordinary row in `grants` with
`scope_type = 'global'`. Same query, same audit trail, same revocation. There is
no branch anywhere that returns "allowed" for a class of caller — a special case
like that is the bug this design exists to prevent.

## Granting

```bash
prk access grant alice@example.com --role admin
```

```bash
prk access grant bob@example.com --role writer --scope api:production
```

```bash
prk access grant e367826f93b8d71185e03fe518aff3b4.access --role reader --scope api:production --expires-in 90
```

The scope is written `project:environment` and defaults to `*:*`, which is
global. `*` is a wildcard, so `api:*` is the whole `api` project.

The scope string is split on the **first** colon only, and the entire remainder
is the environment. Splitting on every colon would truncate an environment
component and grant access to the wrong thing.

`--expires-in` takes days. An expired grant is skipped during resolution — it
does not need to be cleaned up to stop working, and it stays in the table as a
record that it once existed.

An identity can hold at most one grant per scope. That is enforced by partial
unique indexes, one per scope type, rather than by a composite index: SQLite
treats `NULL`s as distinct for uniqueness, so a composite index would silently
permit unlimited duplicate global grants, and revoking "the" global admin grant
would leave the others in place.

## Revoking

```bash
prk access revoke bob@example.com --scope api:production
```

```bash
prk access list
```

## The service token flow

A new service token gets a `403` on its first request, because Access
authenticated it and no grant covers it yet. That denial is **recorded**, and it
is the introduction:

```bash
prk access identities --denied
```

The subject appears in a "seen but not granted" list, and you grant it from
there. The normal flow is: point CI at prick, watch it 403, grant it. No copying
opaque identifiers between two consoles.

Denials are audited best-effort, deliberately: an audit failure must not turn a
`403` into a `500`, because that would let a caller tell "denied" from "denied
and the log broke". Mutations are the opposite — their audit row rides inside the
same transaction and a failed audit fails the write.

## The first administrator

There is no bootstrap token and no printed credential. `BOOTSTRAP_ADMINS` is a
plain `vars` entry in `wrangler.jsonc` holding a comma-separated list of emails:

```jsonc title="packages/app/wrangler.jsonc"
"BOOTSTRAP_ADMINS": "alice@example.com,bob@example.com"
```

It is evaluated **live** on every request, lower-cased and de-duplicated. Editing
it and redeploying takes effect on the next request; there is no cached copy and
no seeded row to hunt down.

The justification is honest rather than clever: the real root of trust is already
"whoever can run `wrangler deploy`". That person can read `MASTER_KEY` and
decrypt every value in the database regardless of what any grant says. Anchoring
the bootstrap to the same authority therefore adds no exposure, and unlike a
one-time token there is no window in which a printed credential is valid and
unrevoked.

On the first authenticated request from a listed address, the implicit admin
**self-heals** into a real, revocable `grants` row, audited as created by the
system rather than by the person it promotes. The UI shows a banner for as long
as any admin is implicit.

Two guards sit either side of that:

| Condition                                                     | Response                                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP_ADMINS` empty **and** no usable global admin grant | `503 NO_ADMINS_CONFIGURED` on the affected requests. Failing closed and loudly beats serving an install nobody can administer |
| Revoking the last global admin grant while the var is empty   | `409 LAST_ADMIN`. There is no recovery credential by design, so an irreversible lockout is refused rather than confirmed      |

"Usable" is doing work in that first row: a grant belonging to a disabled
identity, or one that has expired, cannot administer anything, so it is not
counted.

If the var _is_ set, revoking the last grant is allowed — the recovery path
exists, and it is "edit the var and redeploy".

## Why you get a 404 and not a 403

Asking for a project you cannot see returns exactly what asking for a project
that does not exist returns. Splitting those into `403` and `404` would turn the
API into an oracle for which project names are in use, which is information the
caller was denied by design.

## Next

- [Authorization](/architecture/authorization) — the resolution algorithm in detail.
- [Authentication](/guides/authentication)
