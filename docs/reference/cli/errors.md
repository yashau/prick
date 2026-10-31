---
title: Exit codes and errors
description: What every prk exit code and error code means, whether it is worth retrying, and what to do about it.
sidebar:
  order: 10
---

Every failure carries three things: a message, an exit code a script can branch
on, and a stable machine-readable code.

Without `--json`, a failure looks like this on stderr:

```
error: no project selected; pass --project <SLUG> or set PRK_PROJECT
```

With a next step, when there is one:

```
error: no credentials were found for https://prick.example.com
  help: Run `prk login <url>`, or set PRK_ACCESS_CLIENT_ID and PRK_ACCESS_CLIENT_SECRET for a service token.
```

Under `--json`, the same failure is one envelope on stderr, with stdout empty:

```json
{
  "error": {
    "code": "NO_CREDENTIAL",
    "message": "no credentials were found for https://prick.example.com",
    "hint": "Run `prk login <url>`, or set PRK_ACCESS_CLIENT_ID and PRK_ACCESS_CLIENT_SECRET for a service token."
  }
}
```

`hint` is present only when the failure has an actionable next step.

## Exit codes

Scripts branch on these, so a value keeps its meaning for good.

| Code | Meaning                                              |
| ---- | ---------------------------------------------------- |
| 0    | Success                                              |
| 1    | Unclassified failure                                 |
| 2    | Usage error, or a server selection to fix            |
| 3    | Not authenticated, or not the expected deployment    |
| 4    | Not authorized                                       |
| 5    | Not found                                            |
| 6    | Conflict or failed precondition                      |
| 7    | Cannot reach the server                              |
| 8    | Server error                                         |
| 9    | Output cannot be represented in the requested format |
| 10   | Rate limited                                         |
| 11   | Request rejected as invalid                          |
| 12   | The response is too large to read                    |
| 13   | Output could not be written to stdout in full        |

[`prk run`](/reference/cli/run) adds two more, matching what a shell uses for
the same conditions: **127** when the command was not found, **126** when it was
found but could not be executed.

### Branching on one

```bash
if prk secrets get DATABASE_URL -P api -E production > /dev/null 2>&1; then
  echo "present"
else
  case $? in
    3) echo "sign in first" ;;
    4) echo "ask for a grant" ;;
    5) echo "no such secret" ;;
    *) echo "something else went wrong" ;;
  esac
fi
```

## Error codes

The stable codes emitted under `--json`.

| Code                     | Exit | Retryable | Meaning                                                                                      |
| ------------------------ | ---- | --------- | -------------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED`        | 3    | no        | The server answered 401                                                                      |
| `FORBIDDEN`              | 4    | no        | Authenticated, but not granted the role this operation needs                                 |
| `NOT_FOUND`              | 5    | no        | The project, environment, secret or version does not exist — or is not visible to you        |
| `CONFLICT`               | 6    | yes       | A concurrent writer won                                                                      |
| `PRECONDITION_FAILED`    | 6    | no        | `--expected-rev` did not match                                                               |
| `VALIDATION_FAILED`      | 11   | no        | The payload was rejected                                                                     |
| `PAYLOAD_TOO_LARGE`      | 11   | no        | The environment would exceed its secret cap                                                  |
| `UNSUPPORTED_MEDIA_TYPE` | 11   | no        | A request body was not declared `application/json`                                           |
| `RATE_LIMITED`           | 10   | yes       | The server asked the client to slow down                                                     |
| `SERVER_ERROR`           | 8    | yes       | The server failed internally                                                                 |
| `SERVICE_UNAVAILABLE`    | 8    | yes       | Up but temporarily refusing work, or no admins configured yet                                |
| `UNREACHABLE`            | 7    | yes       | DNS, connection refused, or no route                                                         |
| `TLS_FAILURE`            | 7    | no        | The TLS handshake failed — typically a corporate proxy with a private certificate authority  |
| `TIMEOUT`                | 7    | yes       | The request exceeded `--timeout`                                                             |
| `NOT_A_PRICK_SERVER`     | 7    | no        | Something answered, but it is not a prick server                                             |
| `MITIGATED`              | 7    | no        | A Cloudflare security product challenged or blocked the request before it reached the server |
| `RESPONSE_TOO_LARGE`     | 12   | no        | The server answered correctly and the answer is larger than the client will read             |
| `UNKNOWN`                | 1    | no        | A status with no specific handling                                                           |

Codes the client raises itself, rather than reading off a response:

| Code                     | Exit        | Meaning                                                                                                                                       |
| ------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNREPRESENTABLE_OUTPUT` | 9           | A value contains a control character the chosen format cannot encode                                                                          |
| `TRUNCATED_OUTPUT`       | 13          | stdout would not take the whole answer: a reader closed early on secret material, or the write failed for any reason other than a closed pipe |
| `INVALID_SCOPE`          | 11          | A scope string could not be parsed                                                                                                            |
| `REDIRECT_UNREADABLE`    | 11          | What was pasted to complete a login carried no authorization response                                                                         |
| `UNSAFE_ENVIRONMENT`     | 11          | A secret's name is one the loader interprets, and `--allow-unsafe-env` was not given                                                          |
| `LAUNCH_FAILED`          | 1, 126, 127 | `prk run` could not start the command — **127** not found, **126** found but not executable, **1** for anything else                          |
| `NOT_IMPLEMENTED`        | 1           | The command exists in the CLI but is not available in this build                                                                              |
| `ERROR`                  | 1           | Any other local failure, such as no project selected                                                                                          |

Codes raised while signing in or loading credentials:

| Code                     | Exit | Retryable | Meaning                                                                          |
| ------------------------ | ---- | --------- | -------------------------------------------------------------------------------- |
| `NO_CREDENTIAL`          | 3    | no        | No credentials were found for this server                                        |
| `AUTH_EXPIRED`           | 3    | no        | The stored session expired and could not be refreshed                            |
| `LOGIN_DENIED`           | 3    | no        | The authorization server refused the login                                       |
| `STATE_MISMATCH`         | 4    | no        | The redirect belongs to a different login: a stale browser tab, or a forgery     |
| `DISCOVERY_FAILED`       | 7    | no        | The server's OAuth discovery documents could not be read                         |
| `REGISTRATION_FAILED`    | 7    | no        | Dynamic client registration was refused                                          |
| `LOGIN_TIMEOUT`          | 7    | yes       | The browser did not complete the login in time                                   |
| `MANAGED_OAUTH_DISABLED` | 8    | yes       | The server is behind Access, but managed OAuth is not enabled on its application |
| `STORAGE_UNAVAILABLE`    | 8    | yes       | The requested credential storage backend is not available in this build          |
| `BROWSER_FAILED`         | 1    | no        | The browser could not be opened                                                  |
| `TOKEN_STORE_FAILED`     | 1    | no        | The credentials file could not be read or written                                |
| `IO_ERROR`               | 1    | no        | Any other I/O failure during sign-in                                             |

"Retryable" means retrying the identical request could plausibly succeed. It is
deliberately conservative: a write that may have partially applied is not marked
retryable even where the server would tolerate a repeat.

### Profile and server selection

Codes raised while choosing the server and proving it is the right
deployment. None is retryable: each is a decision for you to make, and the
ones at exit 3 mean the server at that URL is not the deployment it must be.
**Every one of them is raised before the command sends a request of its
own**; the instance checks send only `/api/v1/whoami`, which carries no
secret.

| Code                    | Exit | Meaning                                                                                                                                    |
| ----------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `NO_SERVER`             | 1    | Nothing selects a server: no flag, no variable, no project file, no default profile                                                        |
| `SELECTION_CONFLICT`    | 2    | `--profile` and `--api-url` are both set, or `PRK_PROFILE` and `PRK_API_URL` are                                                           |
| `PROFILE_UNKNOWN`       | 2    | The name selects no profile, or is not a valid profile name                                                                                |
| `PROFILE_RENAMED`       | 2    | The name belonged to a profile that was renamed; the message names the current one                                                         |
| `PROFILE_AMBIGUOUS`     | 2    | A URL or an instance matches several profiles, or a `.prick.local.toml` names an instance no profile is pinned to                          |
| `PROFILE_REQUIRED`      | 2    | A command that changes data, with two or more profiles, was aimed only by the default profile                                              |
| `SERVICE_TOKEN_REFUSED` | 2    | A service token, with two or more profiles, met a server chosen by a project file or the default; or the profile expects another client id |
| `PROFILE_EDIT_REFUSED`  | 2    | A change to the profiles was refused: a name taken, tombstoned, unknown or invalid, or a different URL for an existing profile             |
| `PROJECT_FILE_INVALID`  | 2    | `.prick.toml` or `.prick.local.toml` does not parse or breaks a rule, or `.prick.local.toml` is not ignored by git                         |
| `INVALID_URL`           | 2    | A server URL is not `https://` (or `http://` to loopback), carries `user@`, or is not a URL                                                |
| `INVALID_INSTANCE`      | 2    | `--expect-instance` or `PRK_EXPECT_INSTANCE` is not 32 lowercase hex digits                                                                |
| `INSTANCE_MISMATCH`     | 3    | The server reports a different instance than the profile's pin or `--expect-instance`                                                      |
| `INSTANCE_UNVERIFIED`   | 3    | The server reports no instance id, and a pin, `--expect-instance` or a project file requires one                                           |
| `INSTANCE_NOT_ALLOWED`  | 3    | The server's instance is not in the project's `.prick.toml` allow list                                                                     |
| `ISSUER_MISMATCH`       | 3    | The sign-in went through a different Access organisation than the profile or the project file requires                                     |
| `PROFILE_STORE_FAILED`  | 1    | `config.toml` could not be read, parsed or written, or failed validation                                                                   |

### Retrying the retryable ones

```bash
for attempt in 1 2 3; do
  if prk secrets download --json -o secrets.json -P api -E production; then
    break
  fi
  code=$?
  case $code in
    6|8|10) sleep $((attempt * 2)) ;;
    *) exit $code ;;
  esac
done
```

## Working through a failure

### `UNAUTHENTICATED` (exit 3)

You have no credential, or it expired beyond renewal.

```bash
prk login https://prick.example.com
```

In CI, check both halves of the service token are set and come from the same
prefix — a `PRK_` id with a `CF_` secret is not a credential.

### `FORBIDDEN` (exit 4)

You got through Cloudflare Access, and prick has no grant for you at this scope.
Find out who the server thinks you are:

```bash
prk whoami
```

```
deploy@example.com (user)
```

Then have an administrator grant that subject a role:

```bash
prk access grant deploy@example.com --role reader --scope api:production
```

### `NOT_FOUND` (exit 5)

The thing does not exist, **or** no grant of yours covers it. Those two answer
identically on purpose — a `403`/`404` split would turn the API into an oracle
for which project names are in use.

```bash
prk projects list
prk env list --project api
```

### `NOT_A_PRICK_SERVER` (exit 7)

Something answered at that URL, and it is not your Worker — usually a proxy, a
parked domain, or a typo in the hostname.

```bash
prk doctor
```

Status is classified **before** the response body is parsed, which is what turns
a proxy's HTML error page into this message rather than an unreadable decoding
error.

### `MITIGATED` (exit 7)

Cloudflare intercepted the request at the edge, so it never reached your Worker.
The message names the mitigation it applied:

```
error: Cloudflare intercepted this request with a `challenge` mitigation, so it never reached the server
  help: Cloudflare challenged this request before it reached the server, which bot scoring does to datacenter IPs and non-browser clients. Skip Super Bot Fight Mode for this client with a WAF custom rule; plain Bot Fight Mode cannot be skipped and has to be turned off.
```

This is read off the `cf-mitigated` response header rather than the status,
because the status is a bare `403` — identical to Access refusing your
identity. The distinction matters: `FORBIDDEN` is fixed with a grant, and no
grant will ever fix this one. Nothing about your credential is wrong, and
retrying is pointless until something changes at the edge.

It is common on a server or a CI runner and rare on a laptop, because bot scoring
reacts to datacenter IP ranges and non-browser clients — which is exactly what
`prk` on a VPS looks like.

A partial exception produces this too, and later than you would expect.
`prk login` probes `/api/v1/health` and then the `/.well-known/` discovery
paths, so a rule that skips only `/api` lets the health probe through and leaves discovery
challenged — the login then fails on a path nobody scoped.

See [Cloudflare protections](/guides/cloudflare-protections) for the fix.

### `RESPONSE_TOO_LARGE` (exit 12)

The request reached the server and the server answered correctly. The answer is
simply bigger than `prk` will read into memory, so none of it was parsed.

In practice this is one environment holding more secret data than a single
response can carry. Writes to it keep succeeding — the server sizes each secret
on its own — while `prk secrets download` and `prk run` cannot read the whole
set back.

Reading one secret at a time still works, and so does the listing, so you can
find and remove the offender:

```bash
prk secrets list -P api -E production
```

```bash
prk secrets rm BLOB_ONE -P api -E production
```

The ceiling is derived from the server's own `SECRET_MAX_BYTES` and
`ENV_MAX_SECRETS`, so a default deployment cannot reach it. Raising either of
those above its default is what puts an environment beyond what a client will
read.

It is deliberately neither `UNREACHABLE` nor `NOT_A_PRICK_SERVER`, which both
exit 7: nothing is wrong with `--api-url`, with DNS, or with any proxy in
between, and an exit code that said otherwise would send you to look.

### `SERVICE_UNAVAILABLE` with `NO_ADMINS_CONFIGURED`

Nobody can administer this install yet. Set `BOOTSTRAP_ADMINS` in
`wrangler.jsonc` and redeploy — see
[Access control](/guides/access-control).

### `TLS_FAILURE` (exit 7)

The handshake failed, which on a corporate network usually means a proxy
presenting a private certificate authority. Install that CA into the system
trust store; `prk` uses the platform's store.

### `UNSUPPORTED_MEDIA_TYPE` (exit 11)

The server refuses a state-changing request whose body is not declared
`application/json` — see
[Writes are same-origin and JSON](/reference/api#writes-are-same-origin-and-json).

A working `prk` cannot produce this. It sets `Content-Type: application/json` on
every API call it makes, so seeing it means something rewrote or stripped the
header in transit, which in practice is an intercepting proxy — the same kind of
network to suspect as for `TLS_FAILURE`, and the same thing to check.

It is exit 11 alongside `VALIDATION_FAILED` — both are a request the server
would not act on — but it keeps its own code, because the fix is one header
rather than a field in the payload.

### `UNREPRESENTABLE_OUTPUT` (exit 9)

A value contains a control character the chosen format cannot encode.

```bash
prk secrets download --format json -P api -E production
```

Both `json` and `yaml` can represent any value.

### `TRUNCATED_OUTPUT` (exit 13)

stdout stopped taking bytes part way through the answer — the reader of a pipe
closed early, or a redirect ran out of disk. Whatever is on the other side is
**incomplete**, however plausible it looks:

```bash
prk secrets download -P api -E production | head -20
```

```
error: stdout would not take the whole answer, so what it received is truncated: The pipe has been ended. (os error 109)
  help: Whatever read this got part of the answer. Write to a file with `prk secrets download --output <FILE>` instead of piping, and treat anything already written as incomplete.
```

Its quiet twin is not an error at all. A reader that closes on ordinary output —
`prk completions bash | head -2`, or `prk secrets list | head` — has seen what it
asked for, so the run **exits 0 and says nothing**. Only a truncated value, or a
write that failed for a reason no reader chose, gets this code.

Nothing else in the taxonomy changes number when a pipe breaks. Its two
neighbours are both about something else: exit 9 is a value that cannot be
encoded, and exit 12 is a response too large to read — a size problem at the
other end of the run, on the way in rather than on the way out.

### `REDIRECT_UNREADABLE` (exit 11)

What was pasted to complete a [login your browser could not reach](/reference/cli/sign-in)
holds no authorization response — no `code` and no `error` in it.

```
error: that does not carry an authorization response: no `code` or `error` in it
  help: Copy the whole address the browser was redirected to, including everything after `?`, and paste that. The code on its own cannot be used: the `state` beside it is what proves the redirect belongs to this login.
```

Usually the address was copied without its query string, or the code was copied
on its own. Paste the whole thing:

```
http://127.0.0.1:54321/callback?code=…&state=…
```

The authorization code alone is refused deliberately, and no flag relaxes it.
`state` is the only thing binding a redirect to the login that started it, so
accepting a bare code would be accepting a redirect nothing can check.

Distinct from `STATE_MISMATCH`, which is a redirect that **is** an authorization
response but belongs to a different login — a stale browser tab, or a forgery.
Run `prk login` again for either.

### `NO_SERVER` (exit 1)

Nothing chose a server:

```
error: no server is selected; pass --profile <NAME> or --api-url <URL>, set PRK_PROFILE or PRK_API_URL, or run `prk login <URL>` once
  help: Run `prk login <URL>` once, or pass --api-url <URL> / set PRK_API_URL.
```

On a machine with no profiles, sign in once. On a machine with profiles and no
default, which is the state after the default profile was removed, the hint
asks you to choose one:

```bash
prk profile use acme
```

### `SELECTION_CONFLICT` (exit 2)

Two ways of naming the server at the same tier, which could disagree:

```
error: --profile and --api-url are both set; use one of them
```

Drop one. The same holds for `PRK_PROFILE` with `PRK_API_URL`. A flag outranks
any variable, so `--profile` with `PRK_API_URL` set is not a conflict: the
flag wins.

### `PROFILE_UNKNOWN`, `PROFILE_RENAMED` (exit 2)

The name matches no profile. A name never falls through to another server; it
fails:

```
error: there is no profile named `acmee` (profiles: acme, globex)
  help: `prk profile list` shows every profile.
```

A name that was renamed fails naming its successor:

```
error: profile `prod` was renamed to `acme`
  help: Use the new name. A script can pin its deployment with --expect-instance.
```

Use the new name. A script that has to reach one deployment whatever it is
called locally should pass `--expect-instance`, which no rename affects.

### `PROFILE_AMBIGUOUS` (exit 2)

More than one profile could be meant. By URL:

```
error: 2 profiles are for https://prick.acme.example (acme, acme-admin); pick one with --profile
```

By instance, from a project file, when two profiles are pinned to the same
deployment, such as two identities on one server:

```
error: 2 profiles are pinned to instance 3f9c01ab3f9c01ab3f9c01ab3f9c01ab (acme, acme-admin); choose one with --profile or `profile = "..."` in /home/you/src/api/.prick.toml
```

Pass `--profile`, or set `profile` in `.prick.toml` (in a project that allows
one deployment) or in `.prick.local.toml`. The same code reports a
`.prick.local.toml` naming an instance no profile here is pinned to; sign in
to that deployment first.

### `PROFILE_REQUIRED` (exit 2)

A command that changes data, on a machine with two or more profiles, would
have gone to the default profile without anything naming it:

```
error: this command changes data, and 2 profiles are configured; name the server with --profile (the default, `acme`, is not used for writes)
  help: `prk profile list` shows the profiles; a project's .prick.toml can also choose one.
```

The default is whatever was chosen last, possibly for other work, so it never
aims a write alone. Name the server with `--profile`, `PRK_PROFILE`,
`--api-url` or `PRK_API_URL`, or run the command inside a project whose
`.prick.toml` selects it. Reads use the default as usual.

### `SERVICE_TOKEN_REFUSED` (exit 2)

A service token from the environment, and a server chosen by something else:

```
error: a service token is configured, and the server was chosen by the default profile; with 2 profiles, pass --profile or --api-url (or PRK_PROFILE / PRK_API_URL) so the token cannot reach the wrong one
```

With two or more profiles, a token pairs only with a server chosen where a
token comes from: a flag or a variable. Set `PRK_API_URL` or `PRK_PROFILE`
beside the token.

The same code covers a profile that names the client id it accepts, met by a
different one:

```
error: profile `acme` expects service token e367826f93b8d71185e03fe518aff3b4.access, but 0a1b2c3d4e5f60718293a4b5c6d7e8f9.access is configured
```

Nothing was sent. Fix the token, or change the expectation with
[`prk profile set --service-token-client-id`](/reference/cli/profile#prk-profile-set).

### `PROFILE_EDIT_REFUSED` (exit 2)

A change to the profiles broke one of their rules. The message says which:

```
error: profile `acme` is for https://prick.acme.example, not https://prick.globex.example; a profile's server never changes
```

```
error: `prod` was the name of a profile for another deployment (renamed to `acme`); reusing it could send a script written for that deployment to this one
```

A profile's server is fixed for its life; to point a name at another server,
[remove the profile](/reference/cli/profile#prk-profile-remove) and sign in
again. A name a rename left behind is freed by
[`prk profile forget`](/reference/cli/profile#prk-profile-forget), or reused
with `prk profile add --reuse-name`.

### `PROJECT_FILE_INVALID` (exit 2)

A project file does not parse, or breaks a rule. The message names the file
and the rule:

```
error: /home/you/src/api/.prick.toml lists no deployment; add an [[allow]] entry with the server's instance id (`prk profile pin` writes one)
```

The rules: at least one `[[allow]]`; every instance 32 lowercase hex digits;
`project` and `env` are slugs; no `profile` in a `.prick.toml` that allows
more than one deployment; a `.prick.local.toml` instance that `.prick.toml`
allows; and, inside a git repository, a `.prick.local.toml` that git ignores:

```
error: /home/you/src/api/.prick.local.toml is not ignored by git; add it to .gitignore so this checkout's choice is never committed
```

A file that does not parse at all, including one with a key the format does
not have such as `url`, is reported under this code too, with the parser's line
and column. See [the file formats](/reference/configuration#pricktoml).

### `INVALID_INSTANCE` (exit 2)

`--expect-instance` or `PRK_EXPECT_INSTANCE` is not an instance id:

```
error: `3f9c01ab` is not an instance id (32 lowercase hex digits)
```

Use the full id `prk whoami` prints, not the eight-character short form.

### `INSTANCE_MISMATCH` (exit 3)

The server at this URL is a different deployment from the one required:

```
error: prick.acme.example is a different deployment than profile `acme` is pinned to (expected instance 3f9c01ab3f9c01ab3f9c01ab3f9c01ab, it reports 7d2e44c07d2e44c07d2e44c07d2e44c0); nothing was sent
  help: If this server was replaced on purpose, remove and re-add the profile: `prk profile remove <NAME>`, then `prk login <URL>`.
```

Or, from `--expect-instance`:

```
error: prick.acme.example reports instance 3f9c01ab3f9c01ab3f9c01ab3f9c01ab, not the expected 7d2e44c07d2e44c07d2e44c07d2e44c0; nothing was sent
```

Treat it as the hostname pointing somewhere you did not intend until you know
otherwise. An instance id belongs to a deployment's database: restoring that
database keeps it, and a deployment rebuilt on a fresh database reports a new
one. If the rebuild was deliberate, re-add the profile as the hint says. See
[Backup and recovery](/guides/backup-and-recovery).

### `INSTANCE_UNVERIFIED` (exit 3)

The server reports no instance id, and something requires one: a profile
pinned to an instance, `--expect-instance`, or a project file.

```
error: prick.acme.example reports no instance id, so it cannot be verified against profile `acme`'s pin; nothing was sent
```

A pinned server that stops reporting its instance cannot be told apart from
another deployment, so it is refused rather than trusted.

### `INSTANCE_NOT_ALLOWED` (exit 3)

The command ran inside a project whose `.prick.toml` does not list the
selected server's instance:

```
error: /home/you/src/api/.prick.toml does not allow instance 3f9c01ab3f9c01ab3f9c01ab3f9c01ab (prick.acme.example); nothing was sent
  help: Choose a profile for a deployment this project allows, or add the instance with `prk profile pin` if it belongs to the project.
```

Whatever selected the server, a flag, a variable or the default, a project
file holds it to its allow list. Choose the right profile or, if the
deployment does belong to the project, add it:

```bash
prk profile pin --profile acme
```

### `ISSUER_MISMATCH` (exit 3)

The server signs in through a different Cloudflare Access organisation than
the profile was created against, or than the project's `[[allow]]` entry
names:

```
error: prick.acme.example now signs in through https://other.cloudflareaccess.com, but profile `acme` was created against https://acme.cloudflareaccess.com; nothing was saved
```

At `prk login` the fresh session is revoked and nothing is saved. If the
deployment moved to another Access organisation on purpose, remove and re-add
the profile.

### `PROFILE_STORE_FAILED` (exit 1)

`config.toml` could not be read, parsed or written, or failed validation. The message names the file and the problem.
Two are worth knowing:

```
error: /home/you/.config/prick/config.toml: the profile configuration is version 2, written by a newer prk (this build reads version 1); update prk
```

Update `prk`; the file stays as the newer build wrote it.

```
error: /home/you/.config/prick/config.toml.lock is locked by another prk; try again, or delete the lock file if no prk is running
```

A lock older than ten seconds is taken over automatically, so this clears
when the other `prk` finishes.

## Next steps

- [`prk doctor`](/reference/cli/sign-in#prk-doctor) — check everything at once.
- [Working with several servers](/guides/multiple-servers/) — the profile and instance rules behind these codes.
- [Scripting with `--json`](/examples/scripting-with-json)
- [API reference](/reference/api) — the HTTP status codes behind these.
