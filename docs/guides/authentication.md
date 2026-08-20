---
title: Authentication
description: Sign a person in with prk login, authenticate a machine with an Access service token, and understand what the Worker verifies.
sidebar:
  order: 1
---

Read this before any other guide. Every prick command talks to a Worker behind
Cloudflare Access, so nothing works until the machine running the command can
present an Access credential.

There are two kinds of credential:

| Credential           | Who uses it                 | How you get it                                                             |
| -------------------- | --------------------------- | -------------------------------------------------------------------------- |
| Access SSO session   | People                      | `prk login <url>`, browser round trip                                      |
| Access service token | CI, cron, anything headless | Created in the Cloudflare dashboard, supplied as two environment variables |

Identity comes entirely from a verified Access JWT: whichever of the two the
caller presents, the Worker reads the subject off the signed token rather than
from anything it stores.

:::note[Before you begin]
The Worker has to exist first. If you have not deployed it and attached an
Access application to its hostname, start with the
[Quickstart](/getting-started/quickstart).
:::

## Sign in as a person

```bash
prk login https://prick.example.com
```

```
Signing in to https://prick.example.com
Signed in to https://prick.example.com
```

Your browser opens, you complete the Access sign-in, and the token lands on
disk. `prk login` records which server it signed in to, so later commands need
neither `--api-url` nor `PRK_API_URL`.

Confirm the server agrees about who you are:

```bash
prk whoami
```

```
you@example.com (user)
role: admin (global)
```

**This is the command to run when you get a `403`.** The subject it prints is
what an administrator needs in order to grant you anything. The role line is
your **global** role, and only that — a project-scoped admin prints no role here
and is still an admin of that project.

### What the handshake does

1. **Probe `/api/v1/health`.** Three outcomes, all handled:
   - `401` with a `WWW-Authenticate` header pointing at discovery — normal,
     continue.
   - `401` without it — managed OAuth is not enabled on the Access application.
     The error names the dashboard path that enables it.
   - `200` with a JSON body to an unauthenticated caller — **a loud warning**,
     because Access is not in front of this hostname.
2. Discover the authorization server via RFC 8414 / RFC 9728 metadata, and with
   it the RFC 8707 `resource` indicator naming what the token is for. Access
   refuses an authorization request that omits it, and the refusal arrives at
   the loopback callback as `invalid_target` rather than in the browser.
3. Register a client dynamically for `http://127.0.0.1:<ephemeral>/callback`.
   The port is whatever the OS assigns, so two concurrent logins do not collide,
   and the address is the literal `127.0.0.1` because the redirect URI must
   match byte for byte.
4. PKCE with S256.
5. Open the browser, accept exactly one request on the loopback listener, and
   compare `state` in constant time.
6. Exchange the code and store the tokens.

Refresh is transparent: a token within a minute of expiring is renewed before
the request goes out, and the renewal is written back — so a short Access
session is invisible and the next invocation does not repeat the work.

### On a machine with no browser

```bash
prk login https://prick.example.com --no-browser
```

`prk` prints the authorization URL instead of opening one. The loopback listener
still receives the redirect, provided the port is reachable — which it is over a
forwarding SSH session.

### Where the token is stored

| Backend   | Default | Notes                                                                                        |
| --------- | ------- | -------------------------------------------------------------------------------------------- |
| `file`    | Yes     | A file at mode `0600` in a directory at mode `0700`. Works over SSH, in containers and in CI |
| `keyring` | No      | The OS keyring. Opt-in only                                                                  |

The file is written **atomically** — to a temporary file, then renamed — and
created at mode `0600` on Unix, so there is never a window in which a token file
exists world-readable. On Windows the DACL is replaced with a single entry for
the current user.

The keyring is opt-in because over SSH there is no session keyring to talk to,
and on macOS the Keychain ACL binds to the binary's code signature, so every
update re-prompts — which is unusable from inside `prk run`.

Paths, and the `PRK_CONFIG_DIR` override, are in
[Install](/getting-started/install#where-prk-keeps-its-files).

### Signing out

```bash
prk logout
```

```
Signed out.
```

This revokes the session at the authorization server and then deletes the local
credential. Both halves matter: a refresh token stays valid until it expires or
is revoked, so deleting the file alone would leave a working credential behind
on a machine you thought you had signed out of.

The file is deleted whether or not the revocation succeeded, and a revocation
that did not happen is warned about rather than passed over silently. See
[`prk logout`](/reference/cli/sign-in#prk-logout) for the failure cases and for
`--no-revoke`.

## Authenticate a machine

CI uses an Access **service token**, not `prk login`.

### 1. Create the token

In the Cloudflare dashboard, go to **Zero Trust → Access → Service Auth** and
create a service token. The client secret is shown once; the client id ends in
`.access`.

### 2. Let it through Access

Add the service token to the Access policy for your prick application — an
**include** rule of type **Service Auth**, with the policy's action set to
**Service Auth** rather than Allow. A policy listing only human identities
rejects the token at the edge, before prick ever sees the request.

### 3. Give it to the job

```bash
export PRK_ACCESS_CLIENT_ID="<client id>.access"
```

```bash
export PRK_ACCESS_CLIENT_SECRET="<client secret>"
```

| Variable                   | Fallback                  | Purpose                     |
| -------------------------- | ------------------------- | --------------------------- |
| `PRK_ACCESS_CLIENT_ID`     | `CF_ACCESS_CLIENT_ID`     | Service token client id     |
| `PRK_ACCESS_CLIENT_SECRET` | `CF_ACCESS_CLIENT_SECRET` | Service token client secret |

They are sent as the `CF-Access-Client-Id` and `CF-Access-Client-Secret` request
headers. The `CF_*` fallbacks mean a pipeline already configured for
`cloudflared access` works with no changes.

:::caution[Both halves must come from the same place]
A `PRK_ACCESS_CLIENT_ID` paired with a `CF_ACCESS_CLIENT_SECRET` is not a
credential. Mixing them is how a job authenticates as an identity nobody
intended, so it is refused.
:::

### 4. Run the job, and expect a `403`

Access lets it in; prick refuses it, because authentication is not authorization
and the token has no grant yet. That denial is **recorded**, which is how the
token introduces itself:

```bash
prk access identities --denied
```

```
e367826f93b8d71185e03fe518aff3b4.access	service	1 attempt(s)
```

### 5. Grant it

```bash
prk access grant e367826f93b8d71185e03fe518aff3b4.access --role reader --scope api:production
```

A service token's identity is its `common_name`, and nobody maps that string to
"the staging deploy job" from memory — which is why step 4 exists, and why you
should name it straight away:

```bash
prk access rename e367826f93b8d71185e03fe518aff3b4.access "staging deploy job"
```

The full walkthrough, including the GitHub Actions workflow, is
[Give CI read-only access](/examples/ci-read-only).

### Keeping the secret out of `ps`

```bash
prk secrets list --access-client-id "<id>.access" --access-client-secret-file /run/token
```

`--access-client-secret` exists for pipelines that have nothing else, but a
value passed there appears in `ps` output for every user on the machine and in
your shell history. `--access-client-secret-file` reads the secret from a file —
or from stdin when the path is `-` — and strips one trailing newline, so a file
written by `echo` works.

A file is treated as an explicit act: it takes precedence over both the flag and
`PRK_ACCESS_CLIENT_SECRET`, and it **refuses to fall back** to the `CF_*` pair
for the client id. Authenticating as somebody other than the identity whose
secret was just read off disk is the failure mode that rule designs out.

## Pointing at a server

| Variable      | Equivalent flag   | Meaning                   |
| ------------- | ----------------- | ------------------------- |
| `PRK_API_URL` | `--api-url`       | Base URL of the Worker    |
| `PRK_PROJECT` | `-P`, `--project` | Project to operate on     |
| `PRK_ENV`     | `-E`, `--env`     | Environment to operate on |

```bash
export PRK_API_URL=https://prick.example.com
```

`PRK_API_URL` is only needed when you have not run `prk login`. An explicit flag
wins over the environment variable of the same name.

The project and environment shorts are **uppercase**: `-P` and `-E`. See
[Global flags](/reference/cli/#global-flags).

For CI, add `--no-input` so a missing credential fails immediately rather than
waiting on a prompt nobody can answer:

```bash
prk secrets download --no-input --format env --output .env
```

## What the verifier checks

Every request carries an Access JWT, in the `Cf-Access-Jwt-Assertion` header or
the `CF_Authorization` cookie as a fallback. The Worker verifies it itself
rather than trusting that Access ran:

- The signing algorithm comes from the **JWKS entry matched by `kid`**, never
  from the token header. This is what rejects `alg: none` and RS256→HS256
  confusion.
- `iss` must equal `https://<ACCESS_TEAM>.cloudflareaccess.com` exactly.
- `aud` is an **array**; the check is `.includes(ACCESS_AUD)`.
- `exp` is required and is checked with no skew allowance.
- `nbf` is checked **only if present**. Service tokens do not carry one, and a
  verifier that requires it rejects every machine client.
- `iat` is checked only if present, with a 30-second skew allowance.

Claims then resolve to an identity:

| Claims                                    | Identity                                    |
| ----------------------------------------- | ------------------------------------------- |
| `sub` non-empty **and** `email` present   | `user`, subject is the lower-cased email    |
| `common_name` present **and** `sub` empty | `service`, subject is the `common_name`     |
| Both `email` and `common_name`            | Rejected — Access does not issue that shape |
| Neither                                   | Rejected — nothing to key a grant on        |

## When something goes wrong

Run this first — it checks the whole chain at once:

```bash
prk doctor
```

| Symptom                                                 | Cause                                         | Fix                                                               |
| ------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| `UNAUTHENTICATED`, exit 3                               | No credential, or an expired one              | `prk login <url>`, or set the service-token variables             |
| `FORBIDDEN`, exit 4                                     | Authenticated, but no grant covers this scope | Ask an admin for a grant; `prk whoami` shows the subject to grant |
| `NOT_A_PRICK_SERVER`, exit 7                            | The URL answered but is not this Worker       | Point `--api-url` at the Worker's hostname, not at a proxy        |
| `SERVICE_UNAVAILABLE` with `NO_ADMINS_CONFIGURED`       | Nobody can administer this install            | Set `BOOTSTRAP_ADMINS` and redeploy                               |
| Login warns that `/health` returned 200 unauthenticated | Access is not attached to the hostname        | Fix the Access application before storing anything                |

Every code, and what to do about it, is in
[Exit codes and errors](/reference/cli/errors).

## Next steps

- [Access control](/guides/access-control) — grants, roles and scopes.
- [Give CI read-only access](/examples/ci-read-only)
- [Configuration](/reference/configuration) — the server side.
