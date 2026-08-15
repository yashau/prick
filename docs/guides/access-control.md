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

## Nothing is granted implicitly

An authenticated Access identity that holds no grant gets **nothing**. There is
no default role, no "authenticated means reader", and no fallback for the first
person through the door. Access decides who reaches the Worker; it says nothing
about what they may do once they are there, and prick does not infer one from the
other.

The consequences are worth stating plainly, because they are what a new operator
runs into first:

- `GET /projects` returns `[]`. Not a `403` — the list is scoped in the query, so
  a caller with no grants is shown an empty world rather than refused one.
- Any resource-addressed route answers **`404`**, not `403`. A project you cannot
  see is reported exactly as one that does not exist. See
  [below](#why-you-get-a-404-and-not-a-403).
- The refusal is audited, so the subject appears under "seen but not granted" and
  can be granted from there.

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

`prk access list` shows live grants only — an expired grant is not a grant, so it
is excluded rather than listed as inert. A scoped admin sees the grants that touch
what they administer, not the rest of the organisation's access graph.

## Groups

A group is a **named set of identities** and nothing else. There is no role and no
scope on a group itself: creating one grants nobody anything, and a group with
members but no grants confers exactly nothing. Membership is never a permission.

Groups have no `prk` subcommand yet. They are managed through the API and the web
UI:

| Operation                       | Route                                  | Requires                                  |
| ------------------------------- | -------------------------------------- | ----------------------------------------- |
| List, get                       | `GET /groups`, `GET /groups/{id}`      | any admin, at any scope                   |
| Create, rename, delete          | `POST`/`PATCH`/`DELETE /groups[/{id}]` | **global** admin                          |
| List, add, remove members       | `…/groups/{id}/members`                | list: any admin; change: **global** admin |
| List, create, revoke its grants | `…/groups/{id}/grants`                 | admin **at the scope granted**            |

**The split between those last two rows is the whole security argument.** A
project admin may decide what a roster is allowed to do inside their project;
they may not decide who is on it. If they could do both, an admin of `billing`
could add themselves to a group that also holds admin on `payments` and walk out
with access to a project they have nothing to do with. So global authority curates
membership, and each scope's admin decides what a roster may do there.

Group grants are **purely additive**. Your effective role is the maximum over your
own grants and those of every group you belong to, so a group can only ever raise a
role and never lower one. There is no deny rule — removal is what revocation is
for. Resolution is still a single query: the two halves are combined with
`UNION ALL` rather than joined, so adding groups did not add a round trip.

A group's `slug` cannot be changed. It is how humans and scripts address the
group, and a rename that silently repoints an identifier somebody else wrote down
is a change nobody notices until it matters. Delete and recreate instead, which is
loud and takes the grants with it.

### Why does Bob have production?

```bash
prk access explain bob@example.com
```

```
GET /api/v1/identities/{id}/effective-permissions
```

"What is Bob's role" is not the question an access review asks. "Why does Bob have
production, and what do I remove to stop that" is — and with groups in the model
the answer can be a grant on the environment, a grant on its project, a global
grant, any of those held by a group Bob is in, or `BOOTSTRAP_ADMINS`, none of
which are visible from Bob's own row.

So each entry names its `sources`: the rows that confer the role, each naming the
group it came through when it came through one, with exactly one marked
`decisive`. Only scopes some grant actually names appear — never the cross product
of every project and environment — so a global admin is one entry saying so rather
than one entry per project.

A **disabled** identity reports `role: null` on every entry, with the sources still
listed and nothing decisive. The kill switch outranks every grant, so the honest
answer is "nothing, and here is what re-enabling would restore".

`prk access explain` renders that: one line per scope naming the role and the
source that conferred it, then every source underneath with `->` against the
decisive one. See [`prk access`](/reference/cli/#prk-access).

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

| Condition                                                       | Response                                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP_ADMINS` empty **and** no usable global admin grant   | `503 NO_ADMINS_CONFIGURED` on the affected requests. Failing closed and loudly beats serving an install nobody can administer |
| Removing the last usable global administrator while it is empty | `409 LAST_ADMIN`. There is no recovery credential by design, so an irreversible lockout is refused rather than confirmed      |

"Usable" is doing work in that first row: a grant belonging to a disabled
identity, or one that has expired, cannot administer anything, so it is not
counted.

The `LAST_ADMIN` guard covers **every route that can remove the last one**, not
just `DELETE /grants/{id}`: revoking a group's grant, removing a member from the
group that holds it, and deleting that group all lock the installation out just as
thoroughly, through an endpoint whose name does not contain the word "grant".

If the var _is_ set, removing the last grant is allowed — the recovery path
exists, and it is "edit the var and redeploy".

## Reading the audit log

```
GET /api/v1/audit
```

The line is **admin, at a scope** — not reader, not writer. An audit row carries no
secret value, but it does carry the roster of people and service tokens that
touched a scope, when each of them did, and which subjects were refused. "May read
the secrets" and "may audit who read the secrets" are different sentences, and only
the second is a statement about other people.

| Caller            | Sees                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| global admin      | Every row, unfiltered                                                                   |
| project admin     | Rows carrying that project, **and** rows carrying one of its environments. Nothing else |
| environment admin | Rows carrying that environment. Not its siblings, and not the project's own rows        |
| anything below    | `403`, audited like any other denial                                                    |
| disabled identity | `403`. The kill switch outranks every grant                                             |

The narrowing happens **in the query**, not as a filter afterwards, so a page of 50
is 50 rows the caller is entitled to rather than 50 rows trimmed down to 3 with a
cursor derived from the ones they were not.

A `?project=` filter naming a project that does not exist, and one naming a project
this admin may not audit, both answer **`404`** — same status, same code, same hint.
Splitting them would make the filter an oracle: an admin of one small project could
walk a slug dictionary and read the difference off an organisation they have nothing
to do with. Only the unauthorized case records a denial; there is nothing to be
denied about a project that does not exist, and auditing one would fill "seen but not
granted" with the noise of mistyped slugs.

## Why you get a 404 and not a 403

Asking for a project you cannot see returns exactly what asking for a project
that does not exist returns. Splitting those into `403` and `404` would turn the
API into an oracle for which project names are in use, which is information the
caller was denied by design.

## Next

- [Authorization](/architecture/authorization) — the resolution algorithm in detail.
- [Authentication](/guides/authentication)
