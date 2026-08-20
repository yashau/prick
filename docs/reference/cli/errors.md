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
    "code": "UNAUTHENTICATED",
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
| 2    | Usage error, emitted by the argument parser          |
| 3    | Not authenticated                                    |
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

| Code                  | Exit | Retryable | Meaning                                                                                      |
| --------------------- | ---- | --------- | -------------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED`     | 3    | no        | No credentials, or they expired and could not be refreshed                                   |
| `FORBIDDEN`           | 4    | no        | Authenticated, but not granted the role this operation needs                                 |
| `NOT_FOUND`           | 5    | no        | The project, environment, secret or version does not exist — or is not visible to you        |
| `CONFLICT`            | 6    | yes       | A concurrent writer won                                                                      |
| `PRECONDITION_FAILED` | 6    | no        | `--expected-rev` did not match                                                               |
| `VALIDATION_FAILED`   | 11   | no        | The payload was rejected                                                                     |
| `PAYLOAD_TOO_LARGE`   | 11   | no        | The environment would exceed its secret cap                                                  |
| `RATE_LIMITED`        | 10   | yes       | The server asked the client to slow down                                                     |
| `SERVER_ERROR`        | 8    | yes       | The server failed internally                                                                 |
| `SERVICE_UNAVAILABLE` | 8    | yes       | Up but temporarily refusing work, or no admins configured yet                                |
| `UNREACHABLE`         | 7    | yes       | DNS, connection refused, or no route                                                         |
| `TLS_FAILURE`         | 7    | no        | The TLS handshake failed — typically a corporate proxy with a private certificate authority  |
| `TIMEOUT`             | 7    | yes       | The request exceeded `--timeout`                                                             |
| `NOT_A_PRICK_SERVER`  | 7    | no        | Something answered, but it is not a prick server                                             |
| `MITIGATED`           | 7    | no        | A Cloudflare security product challenged or blocked the request before it reached the server |
| `RESPONSE_TOO_LARGE`  | 12   | no        | The server answered correctly and the answer is larger than the client will read             |
| `UNKNOWN`             | 1    | no        | A status with no specific handling                                                           |

Codes the client raises itself, rather than reading off a response:

| Code                     | Exit        | Meaning                                                                                                              |
| ------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `UNREPRESENTABLE_OUTPUT` | 9           | A value contains a control character the chosen format cannot encode                                                 |
| `TRUNCATED_OUTPUT`       | 13          | stdout would not take the whole answer, and what it took carried secret material                                     |
| `INVALID_SCOPE`          | 11          | A scope string could not be parsed                                                                                   |
| `REDIRECT_UNREADABLE`    | 11          | What was pasted to complete a login carried no authorization response                                                |
| `UNSAFE_ENVIRONMENT`     | 11          | A secret's name is one the loader interprets, and `--allow-unsafe-env` was not given                                 |
| `LAUNCH_FAILED`          | 1, 126, 127 | `prk run` could not start the command — **127** not found, **126** found but not executable, **1** for anything else |

"Retryable" means retrying the identical request could plausibly succeed. It is
deliberately conservative: a write that may have partially applied is not marked
retryable even where the server would tolerate a repeat.

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
`prk login` probes `/.well-known/` discovery paths before it uses `/api`, so a
rule that skips only `/api` lets the health probe through and leaves discovery
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

## Next steps

- [`prk doctor`](/reference/cli/sign-in#prk-doctor) — check everything at once.
- [Scripting with `--json`](/examples/scripting-with-json)
- [API reference](/reference/api) — the HTTP status codes behind these.
