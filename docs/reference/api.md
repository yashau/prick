---
title: API reference
description: The HTTP endpoints the Worker serves, the error envelope, and which routes are not mounted yet.
sidebar:
  order: 2
  label: API
---

The Worker serves a JSON API under `/api/*` and the SvelteKit admin UI
everywhere else. Both call the same in-process domain layer, so authorization is
written once rather than once per transport.

:::caution[One endpoint exists]
`GET /api/v1/health` is the only route mounted
(`packages/app/src/lib/server/http/app.ts`). Everything else in this reference is
marked as not implemented. The request schemas are written and validated
(`packages/shared/src/api.ts`); the routes that would use them are not.
:::

## Base path

```
https://prick.example.com/api/v1
```

Versioned from day one. The CLI is a separately released binary that users
upgrade on their own schedule, so a deployed Worker will always be serving some
older client.

Slug alias routes of the form `/p/:slug/e/:slug/…` are planned for CLI
ergonomics. They match **exactly**, never as a prefix.

## Authentication

Every route except `/health` requires a Cloudflare Access JWT.

| Source                           | Notes                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `Cf-Access-Jwt-Assertion` header | Primary                                                                           |
| `CF_Authorization` cookie        | Fallback. Cloudflare documents it as not guaranteed to be passed in every context |

Service tokens present `CF-Access-Client-Id` and `CF-Access-Client-Secret`;
Access exchanges those at the edge and the Worker sees the resulting JWT like any
other.

The Worker verifies the token itself rather than trusting that Access ran. See
[Authentication](/guides/authentication#what-the-verifier-actually-checks) for
the exact assertions.

## There is no CORS

There is no CORS middleware in this app and there must never be one. Omitting
`Access-Control-Allow-Origin` entirely is what stops any other site on the
internet from reading a response from this API in a victim's browser, and the
browser enforces it for free. The UI is same-origin, so it needs nothing.

## Request ids

Every response carries `X-Request-Id`. A client-supplied value is echoed back if
it matches `^[A-Za-z0-9._-]{1,64}$`; otherwise the Worker generates one.

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

Reveal and export responses are additionally specified to carry
`Cache-Control: no-store`, `Cloudflare-CDN-Cache-Control: no-store` and
`Vary: Cf-Access-Jwt-Assertion` — the last so a cached entry can never be served
across identities. The middleware exists; the routes it binds to do not.

## `GET /api/v1/health`

The only implemented endpoint. Unauthenticated by design.

```bash
curl https://prick.example.com/api/v1/health
```

```json
{ "status": "ok", "version": "0.0.0-dev" }
```

The version string is currently a literal in the handler, not the deployed
build's version.

:::danger[If this returns 200 to an unauthenticated caller, stop]
`prk login` probes this endpoint first, and an unauthenticated `200` means
Cloudflare Access is not in front of this hostname. Your secrets manager is open
to the internet. This handler must never grow a field that reveals anything
beyond "something is listening here".
:::

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
:::

An unrecognised throwable becomes a bare `INTERNAL` with the constant message
"An unexpected error occurred." The original text is not included, because
nothing has established what it contains.

### Codes and statuses

| Code                   | Status | Meaning                                                                  |
| ---------------------- | ------ | ------------------------------------------------------------------------ |
| `BAD_REQUEST`          | 400    | Malformed request                                                        |
| `UNAUTHENTICATED`      | 401    | No valid Access assertion                                                |
| `FORBIDDEN`            | 403    | Authenticated, but no grant covers this scope                            |
| `NOT_FOUND`            | 404    | Absent **or** invisible — deliberately indistinguishable                 |
| `CONFLICT`             | 409    | Uniqueness violation                                                     |
| `VERSION_CONFLICT`     | 409    | Lost a race on the version uniqueness constraint, twice                  |
| `LAST_ADMIN`           | 409    | Refusing to revoke the last global administrator                         |
| `PRECONDITION_FAILED`  | 412    | `expected_rev` did not match. The environment is byte-for-byte unchanged |
| `VALIDATION_FAILED`    | 422    | Schema rejection, including an unknown field                             |
| `PAYLOAD_TOO_LARGE`    | 413    | Over a configured byte or count limit                                    |
| `RATE_LIMITED`         | 429    | Slow down                                                                |
| `INTERNAL`             | 500    | Unclassified failure                                                     |
| `DECRYPT_FAILED`       | 500    | Authenticated decryption failed. Never swallowed                         |
| `UNKNOWN_KID`          | 500    | The envelope names a master key the ring does not hold                   |
| `SERVER_MISCONFIGURED` | 500    | Fail-closed configuration error, e.g. an invalid `MASTER_KEY`            |
| `NOT_IMPLEMENTED`      | 501    | The route exists but the behaviour does not                              |
| `NO_ADMINS_CONFIGURED` | 503    | Neither `BOOTSTRAP_ADMINS` nor a usable global admin grant exists        |

Source: `packages/app/src/lib/server/core/errors.ts`.

Two notes on that table:

- `SERVER_MISCONFIGURED` is 500 rather than 503 on purpose. A 503 says "come back
  later"; a `MASTER_KEY` that decodes to 31 bytes will never come good on its
  own, and a client that retries is waiting for something that cannot happen.
- `MISCONFIGURED` is a deprecated alias of `SERVER_MISCONFIGURED` with the same
  status. It is still constructed in the auth modules and can still appear on the
  wire in this build. Treat the two as the same condition.

`UNKNOWN_KID` is distinct from `DECRYPT_FAILED` because the two need opposite
responses: restore the retired key, versus investigate a compromise. The
`UNKNOWN_KID` message names the key id it wanted and lists the ones it holds.

## Validation rules

Two framework-level rules apply to every route:

1. **Every object schema is strict.** An unknown field is a 422, not something
   silently dropped. The failure this prevents is concrete: a client sending
   `{"expectedRev": 3}` instead of `{"expected_rev": 3}` would otherwise get a
   200 and a write with no concurrency guard — exactly the request it believed it
   was making, minus the safety.
2. **The error formatter never echoes input values.**

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

## Planned routes

None of these are mounted. They are listed so the intended surface is on record,
and because the request bodies they will take are already written and validated
in `@prick/shared`.

| Area         | Routes                                                         |
| ------------ | -------------------------------------------------------------- |
| Projects     | list, create, get, update, delete                              |
| Environments | list, create, get, delete                                      |
| Secrets      | list, reveal one, batch write, import (with `dry_run`), export |
| Versions     | list, rollback                                                 |
| Access       | identities, grants, `access/unknown-identities`                |
| Audit        | query with keyset pagination                                   |
| Admin        | `admin/rekey`                                                  |

### Request bodies that already exist

| Schema                  | Shape                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CreateProjectBody`     | `{ slug, name, description? }`                                                                             |
| `UpdateProjectBody`     | `{ name?, description? }`                                                                                  |
| `CreateEnvironmentBody` | `{ slug, name, description? }`                                                                             |
| `BatchBody`             | `{ mode: "merge" \| "replace", set?, delete?, expected_rev?, reason? }`                                    |
| `ImportBody`            | `{ format: "env" \| "json", content, mode, dry_run, expected_rev?, reason? }`                              |
| `RollbackBody`          | `{ key, to_version, reason? }`                                                                             |
| `RevealQuery`           | `{ reason: "reveal" \| "copy" \| "export" \| "run" }`                                                      |
| `CreateGrantBody`       | Discriminated on `scope_type`: `global`, `project` (+`project`), `environment` (+`project`, `environment`) |
| `UpdateIdentityBody`    | `{ display_name?, disabled? }`                                                                             |
| `AuditQuery`            | `{ project?, environment?, actor?, action?, outcome?, since?, until?, cursor?, limit }`                    |

Two of those carry design decisions worth stating:

- `BatchBody.mode` decides what happens to keys named in neither `set` nor
  `delete`: `merge` leaves them alone, `replace` deletes them. The whole body is
  applied in **one** D1 transaction, audit row included. There is no partial
  application.
- `CreateGrantBody` is a discriminated union rather than a flat object with
  optional fields, so scope fields are required exactly where they are meaningful
  and rejected where they are not. A flat object would accept
  `{scope_type: "global", project: "prod"}` and have to guess — which is how an
  over-broad grant gets created and nobody notices.

## Next

- [CLI reference](/reference/cli)
- [Authorization](/architecture/authorization)
