---
title: Authentication
description: The three ways to authenticate the prk CLI, plus Cloudflare Access service tokens for CI.
sidebar:
  order: 1
---

Read this before any other guide. Every prick command talks to a Worker that is
behind Cloudflare Access, so nothing works until the machine running the command
can present an Access credential.

:::note[The Worker has to exist first]
Authenticating is the second step, not the first. If you have not deployed the
Worker and attached an Access application to its hostname, start with the
[Quickstart](/getting-started/quickstart).
:::

There are two kinds of credential and three ways to supply the configuration
around them.

| Credential           | Who uses it                 | How it is obtained                                                         |
| -------------------- | --------------------------- | -------------------------------------------------------------------------- |
| Access SSO session   | People                      | `prk login <url>`, browser round trip                                      |
| Access service token | CI, cron, anything headless | Created in the Cloudflare dashboard, supplied as two environment variables |

prick issues no credentials of its own. There are no API keys to rotate and no
password to leak, because identity comes entirely from a verified Access JWT.

## 1. `prk login` — interactive sign-in

```bash
prk login https://prick.example.com
```

:::caution[Not implemented]
`prk login` is an argument definition in this build and exits with
`NOT_IMPLEMENTED`. The flow below is what the code is being written to do —
`crates/prick-auth/src/oauth.rs` carries the specification — but no socket is
opened yet.
:::

The intended handshake:

1. **Probe `/api/v1/health`.** Three outcomes, all handled:
   - `401` with a `WWW-Authenticate` header pointing at discovery — normal,
     continue.
   - `401` without it — Managed OAuth is not enabled on the Access application.
     The error names the dashboard path to enable it.
   - `200` with a JSON body to an unauthenticated caller — **a loud warning.**
     That means Access is not in front of this hostname and your secrets manager
     is open to the internet.
2. Discover the authorization server via RFC 8414 / RFC 9728 metadata.
3. Register a client dynamically for `http://127.0.0.1:<ephemeral>/callback`.
   The port is whatever the OS assigns, so two concurrent logins do not collide,
   and the address is the literal `127.0.0.1` rather than `localhost` because the
   redirect URI must match byte for byte.
4. PKCE with S256.
5. Open the browser, accept exactly one request on the loopback listener, and
   compare `state` in constant time.
6. Exchange the code and store the tokens.

Refresh is meant to be transparent, so the short Access session is invisible.

### Where the token is stored

```bash
prk login https://prick.example.com --storage file
```

| Backend   | Default | Notes                                                                                            |
| --------- | ------- | ------------------------------------------------------------------------------------------------ |
| `file`    | Yes     | A file with mode `0600` in a directory with mode `0700`. Works over SSH, in containers and in CI |
| `keyring` | No      | The OS keyring. Opt-in only                                                                      |

The keyring is not the default deliberately. Over SSH there is no session keyring
to talk to, and on macOS the Keychain ACL binds to the binary's code signature,
so every update re-prompts — which is unusable from inside `prk run`.

:::caution[Not implemented]
The token store is a skeleton: the backends and the file mode are fixed in
`crates/prick-auth/src/store.rs`, but nothing is written to disk yet.
:::

### Signing out

```bash
prk logout
```

Discards stored credentials. Also not implemented yet.

### Checking who the server thinks you are

```bash
prk whoami
```

Not implemented yet. When it is, this is the command to run when you get a
`403`: it prints the subject the server resolved, which is what an administrator
needs in order to grant you anything.

## 2. Environment variables

Variables are the right mechanism for CI, and they work for a shell session too.

### Service tokens

Two variables carry an Access service token. prick reads its own names first,
then falls back to the names `cloudflared` uses, so CI that already has the
Cloudflare pair set works with no changes.

| Variable                   | Fallback                  | Purpose                     |
| -------------------------- | ------------------------- | --------------------------- |
| `PRK_ACCESS_CLIENT_ID`     | `CF_ACCESS_CLIENT_ID`     | Service token client id     |
| `PRK_ACCESS_CLIENT_SECRET` | `CF_ACCESS_CLIENT_SECRET` | Service token client secret |

They are sent as the request headers `CF-Access-Client-Id` and
`CF-Access-Client-Secret`.

```bash
export PRK_ACCESS_CLIENT_ID="<client id>.access"
```

```bash
export PRK_ACCESS_CLIENT_SECRET="<client secret>"
```

:::caution[Defined, not yet consumed]
These names and the header spellings are fixed in
`crates/prick-auth/src/credential.rs` and covered by tests. The HTTP client that
attaches them is still a skeleton, so setting them has no effect in this build.
:::

### Everything else

| Variable      | Equivalent flag   | Meaning                   |
| ------------- | ----------------- | ------------------------- |
| `PRK_API_URL` | `--api-url`       | Base URL of the Worker    |
| `PRK_PROJECT` | `-P`, `--project` | Project to operate on     |
| `PRK_ENV`     | `-E`, `--env`     | Environment to operate on |

These three are wired through clap today, so they parse and resolve correctly
even though the commands that would use them do not run yet.

```bash
export PRK_API_URL=https://prick.example.com
```

## 3. Flags

Anything from the table above can be given on the command line instead. An
explicit flag wins over the environment variable of the same name.

```bash
prk secrets list --api-url https://prick.example.com --project api --env production
```

Note that the project and environment shorts are **uppercase**: `-P` and `-E`.
They are global arguments, and lowercase `-p`/`-e` would be consumed on every
subcommand — see [the CLI reference](/reference/cli#global-flags).

For CI, add `--no-input` so a missing credential fails immediately instead of
waiting on a prompt nobody can answer:

```bash
prk secrets download --no-input --format env --output .env
```

## Setting up a service token for CI

1. In the Cloudflare dashboard, go to **Zero Trust → Access → Service Auth** and
   create a service token. The client secret is shown once.
2. Add the service token to the Access policy for your prick application, so
   Access will let it through the edge.
3. Put the two values in your CI secret store and export them as
   `PRK_ACCESS_CLIENT_ID` / `PRK_ACCESS_CLIENT_SECRET`.
4. Run the job. Access lets it in; prick refuses it with `403`, because
   authentication is not authorization and the token has no grant yet.
5. Grant it. See [Access control](/guides/access-control) — a denied service
   token shows up in a "seen but not granted" list precisely so you do not have
   to copy an opaque identifier between two consoles.

A service token's identity is its `common_name`, which looks like
`e367826f93b8d71185e03fe518aff3b4.access`. Nobody maps that to "the staging
deploy job" from memory, which is why step 4 exists.

## What the verifier actually checks

Every request carries an Access JWT, in the `Cf-Access-Jwt-Assertion` header, or
the `CF_Authorization` cookie as a fallback. The Worker verifies it itself
rather than trusting that Access ran — see
`packages/app/src/lib/server/auth/access.ts`:

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

## Common failures

| Symptom                                                 | Cause                                         | Fix                                                               |
| ------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| `UNAUTHENTICATED`, exit 3                               | No credential, or an expired one              | `prk login <url>`, or set the service-token variables             |
| `FORBIDDEN`, exit 4                                     | Authenticated, but no grant covers this scope | Ask an admin for a grant; `prk whoami` shows the subject to grant |
| `NOT_A_PRICK_SERVER`, exit 7                            | The URL answered but is not this Worker       | Point `--api-url` at the Worker's hostname, not at a proxy        |
| `SERVICE_UNAVAILABLE` with `NO_ADMINS_CONFIGURED`       | Nobody can administer this install            | Set `BOOTSTRAP_ADMINS` and redeploy                               |
| Login warns that `/health` returned 200 unauthenticated | Access is not attached to the hostname        | Fix the Access application before storing anything                |

## Next

- [Access control](/guides/access-control) — grants, roles and scopes.
- [CLI reference](/reference/cli) — every flag and exit code.
- [Configuration](/reference/configuration) — the Worker side.
