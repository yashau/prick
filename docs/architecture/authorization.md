---
title: Authorization
description: How an Access JWT becomes an actor, how grants resolve to an effective role, and why there is no god mode.
sidebar:
  order: 3
---

Authentication answers "who is this". Authorization answers "may they do this".
Cloudflare Access owns the first; prick owns the second, from its own tables.

Source: `packages/app/src/lib/server/auth/`. This layer is implemented and tested.
The routes that would call it are not mounted yet.

## From token to actor

A verified Access JWT is classified into exactly one of two identities:

```
sub !== "" && email        → { kind: "user",    subject: email.toLowerCase() }
common_name && sub === ""  → { kind: "service", subject: common_name }
```

Two shapes are **rejected rather than guessed at**:

- Both `email` and `common_name`. Access does not issue such a token. Picking one
  would mean an attacker able to influence either claim chooses which identity
  the request is authorized as.
- Neither. There is nothing to key a grant on, and an identity of `""` is one
  every future subject would collide with.

Mismatched pairs — an `email` with an empty `sub`, a `common_name` with a
non-empty `sub` — fall through to the same rejection, for the same reason.

:::note[Service tokens are shaped differently, and it matters]
A service token payload has **no `email`, no `nbf`, and `sub` is the empty
string**. A verifier written against the human token shape — requiring `nbf`, or
a non-empty `sub`, or an `email` — rejects every machine client with a message
that explains nothing. That is an explicit negative test, not a footnote.
:::

## Resolution

The actor's identity row and every grant attached to it are loaded in **one
query**, a left join, so that an identity with no grants still produces a
snapshot. That case is the normal one for a service token pointed at the Worker
for the first time, and it has to produce a snapshot so the denial can be audited
and the subject can appear in the "seen but not granted" list.

The snapshot is memoised per request in a `WeakMap` keyed by the context object —
not stored as a field on the context, so it cannot outlive the request and cannot
be serialised into anything. The in-flight _promise_ is what is cached, so two
concurrent checks on one request share a single query rather than racing to issue
two.

A 200-secret operation therefore performs one authorization query, not two
hundred.

### The algorithm

1. If the identity is **disabled**, resolve to nothing. Full stop.
2. Compute the effective global role: the maximum of any global grant and, if the
   subject is named in `BOOTSTRAP_ADMINS`, `admin`.
3. For a project scope, take the maximum of the global role and any grant on that
   project.
4. For an environment scope, take the maximum of the global role, any grant on
   the environment's project, and any grant on the environment itself.

Grants inherit **downwards only**. An environment admin is not a project admin.

Expiry is compared against the request's injected clock rather than
`Date.now()`, so a grant cannot be live for one check and expired for the next
within the same request.

The environment's project is needed to resolve step 4. Callers that already
loaded the environment pass it and save a query; callers that did not omit it,
and it is looked up once and memoised per request.

## There is no god mode

Nothing in the resolution branches on `actor.kind`. A global administrator is an
ordinary `grants` row with `scope_type = 'global'` — same query, same audit
trail, same revocation.

The shortcut this replaces is a real bug class: `if (actor.kind === 'user')
return true` means every human credential bypasses every scope check in the
system, and it reads as an optimisation on the way in.

## Denials are recorded

`assertCan` writes an audit row with `outcome: 'denied'` **before** it throws.
The action is recorded as `authz.<scope-type>.<required-role>`.

That is what populates the "seen but not granted" screen, and it is the only way
an operator ever learns that a particular service token exists — `common_name` is
an opaque hex string, and nobody maps
`e367826f93b8d71185e03fe518aff3b4.access` to "staging deploy" by looking at it.
The denial row is the introduction.

The denial audit is deliberately **best-effort**: an audit failure must not
convert a `403` into a `500`, because that would let a caller distinguish "denied"
from "denied and the log broke". Mutations are the opposite — their audit row
rides inside the same transaction, and a failed audit fails the write.

## Absent and invisible are the same answer

A reader with one environment-scoped grant asking for a project they cannot see
gets exactly what they get for a project that does not exist: `404`.

Returning `403` for the first and `404` for the second turns the API into an
oracle for which project names are in use, which is information the actor was
denied by design. The helper that constructs the error takes no argument that
could distinguish the two cases — the shape is the enforcement, so a handler
cannot leak the difference by picking the wrong overload under time pressure. It
names the _kind_ of thing ("project") and never the identifier that was looked
up.

## Bootstrap

`BOOTSTRAP_ADMINS` is a comma-separated `vars` entry of email addresses,
lower-cased and de-duplicated, evaluated **live** on every request. Removing an
address and redeploying takes effect on the next request: there is no cached copy
to invalidate and no seeded row to hunt down.

The justification is that the real root of trust is already "whoever can run
`wrangler deploy`". That person can read `MASTER_KEY` and decrypt everything
regardless of what any grant says, so anchoring the bootstrap to the same
authority adds no exposure — and unlike a one-time token, there is no window in
which a printed credential is valid and unrevoked.

On the first authenticated request from a listed address, the implicit admin
self-heals into a real `grants` row, and the grant insert and its audit row ride
in the same transaction. The grant is recorded as created by the _system_, not by
the person it promotes: "alice@example.com granted alice@example.com global
admin" would be a false account of how that row came to exist.

The insert is `ON CONFLICT DO NOTHING` against the partial unique index, so two
concurrent first requests cannot produce two global grants. Under that race both
may write an audit row while only one writes a grant — an append-only log
recording two attempts is an honest account of what happened, and strictly better
than moving the audit outside the transaction so it could be made conditional.

### The two guards

| Condition                                                     | Response                   |
| ------------------------------------------------------------- | -------------------------- |
| `BOOTSTRAP_ADMINS` empty **and** no usable global admin grant | `503 NO_ADMINS_CONFIGURED` |
| Revoking the last global admin grant while the var is empty   | `409 LAST_ADMIN`           |

"Usable" excludes grants belonging to disabled identities and grants that have
expired. Counting them would report an install as administrable when nobody can
actually log in and fix it.

If the var _is_ set, revoking the last grant is allowed, because the recovery
path exists: edit the var and redeploy.

### Disabled outranks everything

A disabled identity resolves to nothing even when it is named in
`BOOTSTRAP_ADMINS`. Letting the var override the flag would mean an operator who
disables an identity gets no guarantee that it stopped working, which makes the
kill switch worthless exactly when it is being used in anger.

Recovery from disabling your only bootstrap admin is a `wrangler d1 execute`,
which is available to the same person who can edit the var.

## Next

- [Access control](/guides/access-control) — the operator-facing guide.
- [Threat model](/architecture/threat-model)
