---
title: API reference
description: The HTTP endpoints the Worker serves, the error envelope, the authentication model, and the concurrency and caching contracts.
sidebar:
  order: 2
  label: API
---

The Worker serves a JSON API under `/api/*` and the SvelteKit admin UI
everywhere else. Both call the same in-process domain layer, so authorization is
written once rather than once per transport.

:::tip[The generated document is the source of truth]
This page summarises the surface and explains the contracts that cut across it.
For the exact shape of any single endpoint — every parameter, every schema, every
documented status — read the generated document instead. It is produced from the
router itself, so it cannot describe a route that does not exist.

| Path                   | What                                                |
| ---------------------- | --------------------------------------------------- |
| `/api/v1/docs`         | Scalar reference viewer, on your own deployment     |
| `/api/v1/openapi.json` | The OpenAPI 3.1 document, generated from the router |

The same document is committed at [`docs/openapi.json`](https://github.com/yashau/prick/blob/main/docs/openapi.json).
`mise run openapi` regenerates it, `mise run openapi:check` fails if it is stale,
and that check runs in CI — so the API surface shows up in a pull request diff even
when the change that produced it is three files away.
:::

Both routes are unauthenticated. The document describes the _shape_ of the API — it is
generated from the route table and from schemas that are already public in the
repository, and it contains no project slugs, no key names, no identities and no
data of any kind. Putting it behind Access would mean an operator cannot read the
reference in order to work out how to authenticate.

:::caution[`/api/v1/docs` executes third-party JavaScript]
The viewer is a shell that loads its bundle from jsDelivr. Two things are done
about that and one thing is not:

- The CDN URL is **pinned to an exact version**. Scalar's default is
  unversioned, which would make "whatever is latest when a browser asks" an
  ungoverned dependency of your deployment; jsDelivr serves versioned artefacts
  immutably, so a pinned URL is a fixed set of bytes.
- The route carries its own **content security policy**, whose important clause
  is `connect-src 'self'`. The page may fetch its own OpenAPI document and
  nothing else, so a compromised bundle has no egress. `form-action 'none'` and
  `base-uri 'none'` close the two ways a script gets data out without `fetch`.
- **Residual risk:** the bundle still runs on this origin, and a browser attaches
  the viewer's Access cookie to same-origin requests.

The complete fix is to self-host the bundle as a static asset. If you are
unwilling to accept the interim position, do not mount this route.
:::

## Base path

```
https://prick.example.com/api/v1
```

Versioned from day one. The CLI is a separately released binary that users
upgrade on their own schedule, so a deployed Worker will always be serving some
older client.

### Slug aliases

Every environment-scoped route is served at two paths:

```
/api/v1/projects/{project}/environments/{env}/…   canonical
/api/v1/p/{project}/e/{env}/…                     alias
```

Both mounts serve the same handlers — there is no second implementation to
drift. They match **exactly**, never as a prefix, and that is a property of the
slug grammar rather than of the router: a slug is lowercase alphanumerics with
single interior hyphens, which excludes `/` (so a slug cannot add a path segment)
and `:` (so the CLI's `project:environment` scope syntax has exactly one parse).

Only the canonical form appears in the OpenAPI document. Documenting both would
double it to say the same thing twice.

## Authentication

Every route except `/health`, `/openapi.json` and `/docs` requires a verified
Cloudflare Access assertion.

| Source                                            | Notes                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `Cf-Access-Jwt-Assertion` header                  | Primary                                                                           |
| `CF_Authorization` cookie                         | Fallback. Cloudflare documents it as not guaranteed to be passed in every context |
| `CF-Access-Client-Id` + `CF-Access-Client-Secret` | Service tokens. Exchanged at the edge; the Worker never sees these two headers    |

The Worker verifies the token itself rather than trusting that Access ran. See
[Authentication](/guides/authentication#what-the-verifier-actually-checks) for
the exact assertions.

Three things happen on every authenticated request, in this order:

1. The assertion is verified and classified. A non-empty `sub` with an `email`
   is a user; a `common_name` with an empty `sub` is a service token.
2. `503 NO_ADMINS_CONFIGURED` if neither `BOOTSTRAP_ADMINS` nor a usable global
   admin grant exists. Failing closed beats an installation that answers
   requests, denies every privileged action, and gives no indication why.
3. The identity row is created or its `last_seen_at` touched. This is what makes
   a denied service token grantable at all — Access issues the tokens, so the
   first request from one is the only introduction there will ever be.

:::note[Unknown endpoints answer 401, not 404]
Authentication is mounted ahead of routing, so an anonymous caller is refused
before the router decides whether a path exists. The alternative turns the status
code into a route oracle: 404 versus 401 would map the entire surface, including
endpoints added later, to an unauthenticated attacker.
:::

## There is no CORS

There is no CORS middleware in this app and there must never be one. Omitting
`Access-Control-Allow-Origin` entirely is what stops any other site on the
internet from reading a response from this API in a victim's browser, and the
browser enforces it for free. The UI is same-origin, so it needs nothing. A
client that wants cross-origin access wants a service token and a server-side
call, which is what the CLI and the MCP package do.

## Request ids

Every response carries `X-Request-Id`. A client-supplied value is echoed back if
it matches `^[A-Za-z0-9._-]{1,64}$`; otherwise the Worker generates a UUIDv7.

The id is stored on every audit row the request produces. That is the point: a
user pastes the id from an error toast into a support thread, and an
administrator finds the exact event instead of correlating on a timestamp.

## Response headers

Applied to Worker responses by `hono/secure-headers`:

```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

Static assets are served by the Workers assets runtime **without invoking the
Worker**, so no middleware can reach them. They get their headers from
`packages/app/_headers` instead.

### The two routes that return plaintext

`GET …/secrets/{key}` and `GET …/secrets:export` additionally carry:

```
Cache-Control: no-store, no-cache, must-revalidate, private
Cloudflare-CDN-Cache-Control: no-store
Vary: Cf-Access-Jwt-Assertion
```

All three are necessary. `Cache-Control` covers the browser and intermediaries;
Cloudflare's own edge cache does not necessarily honour it, so it is told
separately; and `Vary` is what stops a cached entry ever being served across
identities. They are applied by middleware bound to those two paths, above the
route table, rather than by each handler — so the next value-returning route that
forgets is a missing line somebody notices, not a convention somebody breaks.

## Concurrency: `ETag` and `If-Match`

`GET …/secrets` answers with a strong entity tag that **is** the environment's
revision:

```
ETag: "3"
```

Send it back on a write and the write becomes conditional:

```
If-Match: "3"
```

A mismatch is `412` and the environment is left byte-for-byte unchanged. The
guard is not `UPDATE … WHERE rev = ?` — D1 rolls a batch back when a statement
_errors_, not when it changes zero rows, so a non-matching update would be a
perfectly successful statement that affected nothing and the batch would commit
the write it was supposed to prevent. It is a deliberate constraint violation
inside the same transaction, whose failure mode _is_ the rollback.

| Value                    | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| absent                   | Unconditional write                                                |
| `*`                      | A guard on existence only                                          |
| `"3"` or `W/"3"`         | Write only if the environment is at revision 3                     |
| a list, or anything else | `400`. A malformed precondition is refused, never silently ignored |

`expected_rev` in the body means the same thing. Sending both is allowed only
when they agree; disagreement is a `400` rather than a precedence rule, because a
precedence rule means one of the two silently does nothing.

`If-Match` is evaluated by `secrets:batch` and `secrets:import`. On
`secrets:rename` and `secrets:rollback` it is **refused with 400**: the domain
layer exposes no revision guard on those, and a caller who sent a precondition
believes their write is conditional.

The read order matters and is deliberate: the revision is read _before_ the
listing, so a concurrent write produces an `ETag` that is merely stale rather
than one newer than the contents it labels. Fails closed in the only direction
that matters.

## Routes

### Meta

| Method | Path            | Notes                                                                     |
| ------ | --------------- | ------------------------------------------------------------------------- |
| `GET`  | `/health`       | Unauthenticated. `{ "service": "prick", "status": "ok", "version": "…" }` |
| `GET`  | `/whoami`       | The resolved identity and the caller's **global** role                    |
| `GET`  | `/openapi.json` | Unauthenticated. Describes shape; carries no data                         |
| `GET`  | `/docs`         | Unauthenticated. Scalar viewer                                            |

:::danger[If `/health` returns 200 to an unauthenticated caller, stop]
`prk login` probes this endpoint first, and an unauthenticated `200` means
Cloudflare Access is not in front of this hostname. Your secrets manager is open
to the internet. This handler must never grow a field that reveals anything
beyond "a prick server is listening here".
:::

`/health` answers `200` only once the fail-closed key ring middleware has
succeeded, which is what makes `ok` mean something: an installation whose
`MASTER_KEY` decodes to 31 bytes answers `500` here, not `200`.

### Projects

| Method   | Path                  | Requires              |
| -------- | --------------------- | --------------------- |
| `GET`    | `/projects`           | any identity (scoped) |
| `POST`   | `/projects`           | **global** writer     |
| `GET`    | `/projects/{project}` | reader (visibility)   |
| `PATCH`  | `/projects/{project}` | project writer        |
| `DELETE` | `/projects/{project}` | project admin         |

`GET /projects` is scoped in the query, not filtered afterwards, so an actor with
no grants receives `[]` rather than a refusal — and cannot infer the existence of
anything from a count or a page boundary. `POST` requires _global_ writer because
a project has no parent to be scoped to.

`DELETE` is one statement. D1 enforces foreign keys, so `ON DELETE CASCADE`
removes the environments, their secrets, the whole version history and every
grant scoped to them inside the same transaction.

### Environments

| Method   | Path                                     | Requires          |
| -------- | ---------------------------------------- | ----------------- |
| `GET`    | `/projects/{project}/environments`       | reader            |
| `POST`   | `/projects/{project}/environments`       | project writer    |
| `GET`    | `/projects/{project}/environments/{env}` | reader            |
| `DELETE` | `/projects/{project}/environments/{env}` | environment admin |

Listing re-checks visibility per environment: a project-scoped grant covers all
of them, an environment-scoped grant covers exactly one, and that caller reached
the endpoint through a project made visible _by_ that grant.

There is no reparent operation, and adding one is not a small change.
`environments.project_id` is contractually immutable because `project_id` is
excluded from the crypto AAD — a reparent that skipped re-encryption would appear
to work, because nothing in the AAD would have changed.

### Secrets

All under `/projects/{project}/environments/{env}` (or the `/p/…/e/…` alias).

| Method | Path                      | Requires | Returns values |
| ------ | ------------------------- | -------- | -------------- |
| `GET`  | `/secrets`                | reader   | no             |
| `POST` | `/secrets:batch`          | writer   | no             |
| `POST` | `/secrets:import`         | writer   | no             |
| `GET`  | `/secrets:export`         | reader   | **yes**        |
| `POST` | `/secrets:rename`         | writer   | no             |
| `POST` | `/secrets:rollback`       | writer   | no             |
| `GET`  | `/secrets/{key}`          | reader   | **yes**        |
| `GET`  | `/secrets/{key}:reveal`   | reader   | **yes**        |
| `GET`  | `/secrets/{key}/versions` | reader   | no             |

`GET /secrets/{key}` and `GET /secrets/{key}:reveal` are the same operation. Both
spellings exist because the browser client and the machine clients each guessed a
different one, and the parse is unambiguous: a secret key is a POSIX environment
variable name and cannot contain a colon, so the suffix is stripped by the path
schema rather than routed separately. Only the bare spelling appears in the
OpenAPI document, for the same reason only the canonical slug path does. The
response is `{ key, value }`.

`?reason=` accepts `reveal`, `copy`, `export` or `run` and defaults to `reveal`.
It is what makes the log answer "did anyone take this" rather than merely "did
anyone look at it": the UI sends `copy` for the copy button and `reveal` for the
eye toggle.

`GET /secrets` decrypts every row and discards the plaintext immediately. That
looks wasteful and is not: `unreadable` cannot be determined any other way, because
AES-GCM has no verify-without-decrypting operation — the tag check _is_ the
decryption. A row that fails comes back **marked**, never omitted. A list that
silently drops what it could not read turns a tamper attempt into a shorter `.env`
file, and a shorter `.env` file into a production deploy with no `DATABASE_URL`.

`GET /secrets:export` takes the opposite line for the same reason: a single
unreadable row fails the whole export, rather than handing the operator a file
that is silently missing a variable.

`POST /secrets:batch` applies the whole body in **one** D1 transaction — revision
bump, new versions, upserts, tombstones, deletes, audit row last. There is no
partial application. On a version race the losing batch writes nothing and is
retried once against freshly read state; a second loss is `409`.

`POST /secrets:import` with `dry_run: true` computes the diff without writing,
through the same planning function the write path uses. The diff carries key names
and change kinds only. `changed` means "this key already existed and is being
rewritten"; it does **not** mean the value differs, and it cannot — telling those
apart would require decrypting every existing value to compare, which is a silent
full-environment reveal performed by the screen whose purpose is to avoid one.

`POST /secrets:rollback` moves **forward**: version N is decrypted and
re-encrypted as `current + 1`. The old envelope is never resurrected, because its
AAD binds it to version N.

`POST /secrets:rename` decrypts under the old key's AAD and re-encrypts under the
new one, in a single batch. There is no cheap rename and there cannot be one.

### Access

| Method   | Path                                     | Requires                       |
| -------- | ---------------------------------------- | ------------------------------ |
| `GET`    | `/identities`                            | any admin, at any scope        |
| `PATCH`  | `/identities/{id}`                       | **global** admin               |
| `GET`    | `/identities/{id}/effective-permissions` | any admin, at any scope        |
| `GET`    | `/grants`                                | any admin, at any scope        |
| `POST`   | `/grants`                                | admin **at the scope granted** |
| `DELETE` | `/grants/{id}`                           | admin at the grant's scope     |
| `GET`    | `/access/unknown-identities`             | any admin, at any scope        |

`PATCH /identities/{id}` requires _global_ admin because `disabled` is a kill
switch that outranks every grant at every scope — including `BOOTSTRAP_ADMINS`.

`GET /identities/{id}/effective-permissions` answers "why does Bob have
production, and what do I remove to stop that". Each entry carries its `sources` —
the rows that confer the role, each naming the group it came through when it came
through one, with exactly one marked `decisive`. Only scopes that some grant
actually names appear, never the cross product of every project and environment,
so a global admin is one entry rather than one per project. A disabled identity
reports `role: null` on every entry with the sources still listed and nothing
decisive.

The view is narrowed to the scopes the caller administers. The `sources` inside a
visible entry are **not** narrowed: a project admin who can see that Bob has admin
on their project must be able to see that it came from a global grant on a group,
or the entry has a role and no explanation.

`POST /grants` requires admin at the scope being granted, which falls out of
scope inheritance and needs no special case. That is the point: the special case
is where privilege escalation lives. A duplicate is a `409`, not an upsert.

`DELETE /grants/{id}` refuses to remove the last usable global administrator while
`BOOTSTRAP_ADMINS` is empty (`409 LAST_ADMIN`). There is no recovery credential in
this design, so the only way back from an accidental lockout is editing a var and
redeploying — which is not a decision a confirmation dialog can make for you.

`GET /access/unknown-identities` is read out of the audit log. A service token's
`common_name` is `e367826f93b8d71185e03fe518aff3b4.access` and nobody maps that to
"staging deploy" by looking at it, so the denial _is_ the introduction. The rows
carry no id; match `subject` against `GET /identities` to obtain the `identity_id`
a grant needs.

### Groups

A group is a named set of identities that can hold grants. Membership alone
confers nothing.

| Method   | Path                                | Requires                       |
| -------- | ----------------------------------- | ------------------------------ |
| `GET`    | `/groups`                           | any admin, at any scope        |
| `POST`   | `/groups`                           | **global** admin               |
| `GET`    | `/groups/{id}`                      | any admin, at any scope        |
| `PATCH`  | `/groups/{id}`                      | **global** admin               |
| `DELETE` | `/groups/{id}`                      | **global** admin               |
| `GET`    | `/groups/{id}/members`              | any admin, at any scope        |
| `POST`   | `/groups/{id}/members`              | **global** admin               |
| `DELETE` | `/groups/{id}/members/{identityId}` | **global** admin               |
| `GET`    | `/groups/{id}/grants`               | any admin, at any scope        |
| `POST`   | `/groups/{id}/grants`               | admin **at the scope granted** |
| `DELETE` | `/groups/{id}/grants/{grantId}`     | admin at that grant's scope    |

**Two different rules live on this router, and the split is the security
argument.** The group itself — create, rename, delete, and every membership change
— needs global admin, because membership is the escalation surface: a project admin
who could edit the roster of a group that also holds admin elsewhere could add
themselves to it. Its **grants** need admin at the scope being granted, resolved by
the same code as granting an identity. Global authority curates who is on a roster;
each scope's admin decides what that roster may do there.

`POST /groups/{id}/grants` is not an escalation route for the granting admin even
when they are in the group, because the role they can confer is bounded by the role
they already hold there. Adding somebody _else_ is the operation that would widen
their reach, and that one is global-admin only.

Group grants are **purely additive**: effective role is the max over an identity's
own grants and its groups', so a group can only raise a role. There is no deny
rule.

`DELETE /groups/{id}/grants/{grantId}` is addressed through the group, so a
mismatched pair is a `404` rather than a revocation of a different group's grant
because a client paired the wrong two values.

`slug` is absent from `UpdateGroupBody`. A rename that silently repoints an
identifier somebody wrote down is a change nobody notices until it matters.

The `409 LAST_ADMIN` guard covers `DELETE /groups/{id}`, `DELETE
…/members/{identityId}` and `DELETE …/grants/{grantId}` as well as `DELETE
/grants/{id}` — each of them can remove the installation's last usable global
administrator, and two of them do it through an endpoint whose name does not
contain the word "grant".

Membership removal takes effect on the **next request**, with nothing to
invalidate: the authorization snapshot is cached per request, keyed on the
request's own context object, so there is no longer-lived cache for a revocation to
be missing from.

### Audit

| Method | Path     | Requires                |
| ------ | -------- | ----------------------- |
| `GET`  | `/audit` | any admin, at any scope |

Keyset-paginated on the UUIDv7 primary key, never on `OFFSET`. The log is
append-only and grows under the reader, so every insert between two `OFFSET` pages
shifts the window by one and makes the reader silently skip a row.

The line is **admin, at a scope** — not reader, not writer. An audit row carries no
secret value by construction, but it does carry the roster of people and service
tokens that touched a scope, when each of them did, and which subjects were
refused. "May read the secrets" and "may audit who read the secrets" are different
sentences.

| Caller            | Sees                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| global admin      | Every row, unfiltered                                                                   |
| project admin     | Rows carrying that project, **and** rows carrying one of its environments. Nothing else |
| environment admin | Rows carrying that environment. Not its siblings, and not the project's own rows        |
| anything below    | `403 FORBIDDEN`, audited like every other denial                                        |
| disabled identity | `403`. The kill switch outranks every grant                                             |

The environment half of a project admin's view is not redundant: a denial recorded
at an environment scope carries `environment_id` and a `NULL` `project_id`, so
filtering on `project_id` alone would drop exactly the rows they most need — the
refusals inside their own project.

Narrowing happens **in the query**, never as a filter afterwards. A post-filter over
"all events" has already loaded rows the actor may not see by the time it runs, and
the pagination is the immediate proof: a page of 50 trimmed to 3 would report a
cursor derived from rows the caller was never entitled to.

:::note[An unknown `?project=` is a 404, not an empty page]
A filter naming a project that does not exist and one naming a project this admin
may not audit both answer `404` — same status, same code, same hint. Splitting
them would make the filter an oracle for which project slugs are in use: an admin
of one small project could walk a dictionary and read the difference off an
organisation they have nothing to do with. The same applies to `?environment=`.

Only the unauthorized branch records a denial. There is nothing to be denied about
a project that does not exist, and auditing one would fill "seen but not granted"
with the noise of mistyped slugs.
:::

`?environment=` is never resolved as a bare `WHERE slug = ? LIMIT 1`. Environment
slugs are unique only _within_ a project, so a global lookup for `prod` would find
an arbitrary project's production environment. Paired with `?project=` it resolves
the pair exactly; unpaired it means "every environment by that name that you may
audit".

A `detail` blob written by an older build that this one cannot parse comes back as
`null` rather than failing the page. That is the one place in this system where
swallowing is right: the log is historical and append-only, and refusing a whole
page because one old row is odd would make it unreadable exactly when it is being
consulted.

### Admin

| Method | Path             | Requires     |
| ------ | ---------------- | ------------ |
| `GET`  | `/admin/keyring` | Global admin |
| `POST` | `/admin/rekey`   | Global admin |

`GET /admin/keyring` reports `safeToRemoveOldKey`, true only when every
non-active key id has zero rows remaining. Removing `MASTER_KEY_OLD` while rows
still reference a retired kid is the one irreversible mistake available in this
design, so the counts are taken live rather than read from a stored progress
figure, and they cover **history** as well as current versions — an earlier
version stranded under a retired kid is a rollback that stops working when the
key goes.

`POST /admin/rekey` re-encrypts one page onto the active key and returns
`{ rekeyed, remaining }`. **Nothing calls it on a schedule**: there is no cron
trigger, so a rotation advances only while something keeps calling it, and it is
finished when `remaining` reaches zero. A row that cannot be decrypted fails the
whole page instead of being skipped — a skipped row would still count as gone,
and the ring would then report itself safe to prune while an unreadable value
remained.

Both authorization checks are the first statement of the corresponding function
in `core`, not of the route, because authorization is written once.

## Error envelope

Every non-2xx response uses one shape:

```json
{
  "code": "FORBIDDEN",
  "message": "You do not have permission to perform this action.",
  "request_id": "0192f3c1-…",
  "hint": "An administrator can grant access from the Access screen.",
  "issues": [{ "path": "set.DATABASE_URL", "message": "must not be empty" }]
}
```

`hint` and `issues` are present only when they apply.

:::danger[`issues` never echoes input]
The zod error formatter reads `issue.path` and `issue.message` and nothing else.
`issue.input` is dropped on the floor. A `VALIDATION_FAILED` on a secret write is
by definition a request whose body contained a secret value — echoing the
rejected input would put that plaintext in the response, the Worker log and the
audit detail simultaneously.

The path _is_ kept, and for a secrets map the path segment is the secret's key
name. Key names are plaintext metadata: stored unencrypted, listed in the UI,
printed in the audit log. It is the sibling field that holds the value.
:::

An unrecognised throwable becomes a bare `INTERNAL` with the constant message
"An unexpected error occurred." The original text is not included, because
nothing has established what it contains.

### Codes and statuses

| Code                            | Status | Meaning                                                               |
| ------------------------------- | ------ | --------------------------------------------------------------------- |
| `BAD_REQUEST`                   | 400    | Malformed request, or a precondition this API cannot express          |
| `UNAUTHENTICATED`               | 401    | No valid Access assertion                                             |
| `FORBIDDEN`                     | 403    | Authenticated, but no grant covers this scope                         |
| `NOT_FOUND`                     | 404    | Absent **or** invisible — deliberately indistinguishable              |
| `CONFLICT`                      | 409    | Uniqueness violation                                                  |
| `VERSION_CONFLICT`              | 409    | Lost a race on the version uniqueness constraint, twice               |
| `LAST_ADMIN`                    | 409    | Refusing to revoke the last global administrator                      |
| `PRECONDITION_FAILED`           | 412    | `If-Match`/`expected_rev` did not match. The environment is unchanged |
| `PAYLOAD_TOO_LARGE`             | 413    | Over a configured byte or count limit                                 |
| `VALIDATION_FAILED`             | 422    | Schema rejection, including an unknown field                          |
| `RATE_LIMITED`                  | 429    | Slow down                                                             |
| `INTERNAL`                      | 500    | Unclassified failure                                                  |
| `DECRYPT_FAILED`                | 500    | Authenticated decryption failed. Never swallowed                      |
| `UNKNOWN_KID`                   | 500    | The envelope names a master key the ring does not hold                |
| `SERVER_MISCONFIGURED`          | 500    | Fail-closed configuration error, e.g. an invalid `MASTER_KEY`         |
| `NOT_IMPLEMENTED`               | 501    | The route exists but the behaviour does not                           |
| `NO_ADMINS_CONFIGURED`          | 503    | Neither `BOOTSTRAP_ADMINS` nor a usable global admin grant exists     |
| `IDENTITY_PROVIDER_UNAVAILABLE` | 503    | Cloudflare Access is unreachable or degraded right now                |

Source: `packages/app/src/lib/server/core/errors.ts`.

Three notes on that table:

- `SERVER_MISCONFIGURED` is 500 rather than 503 on purpose. A 503 says "come back
  later"; a `MASTER_KEY` that decodes to 31 bytes will never come good on its
  own, and a client that retries is waiting for something that cannot happen.
- `IDENTITY_PROVIDER_UNAVAILABLE` is the opposite case and is deliberately
  distinct: Access returning 502 for thirty seconds resolves on its own. Folding
  the two would tell a client to give up on a failure it should have retried.
- `UNKNOWN_KID` is distinct from `DECRYPT_FAILED` because the two need opposite
  responses: restore the retired key, versus investigate a compromise. The
  `UNKNOWN_KID` message names the key id it wanted and lists the ones it holds.

### 404 is used for absent and invisible alike

A resource you cannot see is reported exactly as one that does not exist — same
status, same code, same message, same hint. Returning 403 for one and 404 for the
other would make this API an oracle for which project names are in use in an
organisation the caller has no access to, and slugs are things like
`acme-payroll-migration`.

403 appears only where the caller has already been shown that the resource exists
by holding reader somewhere that covers it. There it leaks nothing they did not
already know.

## Validation rules

Two framework-level rules apply to every route:

1. **Every object schema is strict.** An unknown field is a 422, not something
   silently dropped. The failure this prevents is concrete: a client sending
   `{"expectedRev": 3}` instead of `{"expected_rev": 3}` would otherwise get a
   200 and a write with no concurrency guard — exactly the request it believed it
   was making, minus the safety. This applies to query strings and path
   parameters as well as bodies.
2. **The error formatter never echoes input values.**

Query strings are coerced at the transport (`?limit=50` arrives as text), and
nowhere else: the shared schemas stay the strict statement of what the domain
layer accepts.

### Limits

| Limit                   | Default                                               | Override           |
| ----------------------- | ----------------------------------------------------- | ------------------ |
| Secret value            | 65536 bytes of UTF-8                                  | `SECRET_MAX_BYTES` |
| Secrets per environment | 500                                                   | `ENV_MAX_SECRETS`  |
| Request body            | 1048576 bytes                                         | `BODY_MAX_BYTES`   |
| Secret key name         | 256 characters, POSIX env var name                    | —                  |
| Slug                    | 64 characters, lowercase with single interior hyphens | —                  |
| Description             | 1024 characters                                       | —                  |
| Audit `reason`          | 512 characters                                        | —                  |
| Rekey page              | 1 to 1000 rows                                        | —                  |

`ENV_MAX_SECRETS` is enforced against the **resulting** environment, not only
against the request: two merges of 300 keys each are individually under the cap
and together over it, and the second is refused. The cap exists because a full
replace must fit in one D1 batch — splitting it across batches would forfeit
atomicity, so an oversized write is refused rather than made non-atomic.

## Request bodies

| Schema                  | Shape                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateProjectBody`     | `{ slug, name, description? }`                                                                                                                       |
| `UpdateProjectBody`     | `{ name?, description? }`                                                                                                                            |
| `CreateEnvironmentBody` | `{ slug, name, description? }`                                                                                                                       |
| `BatchBody`             | `{ mode: "merge" \| "replace", set?, delete?, expected_rev?, reason? }`                                                                              |
| `ImportBody`            | `{ format: "env" \| "json", content, mode, dry_run, expected_rev?, reason? }`                                                                        |
| `RollbackBody`          | `{ key, to_version, reason? }`                                                                                                                       |
| `RenameBody`            | `{ from, to }`                                                                                                                                       |
| `RekeyBody`             | `{ limit }`                                                                                                                                          |
| `RevealQuery`           | `{ reason: "reveal" \| "copy" \| "export" \| "run" }`                                                                                                |
| `CreateGrantBody`       | Discriminated on `scope_type`: `global`, `project` (+`project`), `environment` (+`project`, `environment`). Plus `identity_id`, `role`, `expires_at` |
| `UpdateIdentityBody`    | `{ display_name?, disabled? }`                                                                                                                       |
| `CreateGroupBody`       | `{ slug, name, description? }`                                                                                                                       |
| `UpdateGroupBody`       | `{ name?, description? }` — no `slug`                                                                                                                |
| `AddGroupMemberBody`    | `{ identity_id }`                                                                                                                                    |
| `CreateGroupGrantBody`  | Discriminated on `scope_type`, as above, but with `role` and `expires_at` and **no** `identity_id`                                                   |
| `AuditQuery`            | `{ project?, environment?, actor?, action?, outcome?, since?, until?, cursor?, limit }`                                                              |

Most live in `@prick/shared`, so the browser bundle and the MCP package validate
against the same objects the Worker does. `RenameBody` and `RekeyBody` are
transport-local.

`expires_at` is an **absolute** epoch-millisecond timestamp, or `null` for a grant
that does not expire. The grant terms are factored out and shared between
`CreateGrantBody` and `CreateGroupGrantBody`, so a grant on a group and a grant on
an identity cannot drift in role vocabulary or expiry semantics — the day that
stops being true is the day "why does Bob have production?" stops having one
answer.

Two of them carry design decisions worth stating:

- `BatchBody.mode` decides what happens to keys named in neither `set` nor
  `delete`: `merge` leaves them alone, `replace` deletes them. A key named in
  **both** is a 422 — one order stores the value and the other tombstones it, and
  the request does not say which was meant.
- `CreateGrantBody` is a discriminated union rather than a flat object with
  optional fields, so scope fields are required exactly where they are meaningful
  and rejected where they are not. A flat object would accept
  `{scope_type: "global", project: "prod"}` and have to guess — which is how an
  over-broad grant gets created and nobody notices.

## Next

- [CLI reference](/reference/cli)
- [Authorization](/architecture/authorization)
