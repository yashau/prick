---
title: Exit codes and errors
description: What every prk exit code and error code means, whether it is worth retrying, and what to do about it.
sidebar:
  order: 9
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

| Code                  | Exit | Retryable | Meaning                                                                                     |
| --------------------- | ---- | --------- | ------------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED`     | 3    | no        | No credentials, or they expired and could not be refreshed                                  |
| `FORBIDDEN`           | 4    | no        | Authenticated, but not granted the role this operation needs                                |
| `NOT_FOUND`           | 5    | no        | The project, environment, secret or version does not exist — or is not visible to you       |
| `CONFLICT`            | 6    | yes       | A concurrent writer won                                                                     |
| `PRECONDITION_FAILED` | 6    | no        | `--expected-rev` did not match                                                              |
| `VALIDATION_FAILED`   | 11   | no        | The payload was rejected                                                                    |
| `PAYLOAD_TOO_LARGE`   | 11   | no        | The environment would exceed its secret cap                                                 |
| `RATE_LIMITED`        | 10   | yes       | The server asked the client to slow down                                                    |
| `SERVER_ERROR`        | 8    | yes       | The server failed internally                                                                |
| `SERVICE_UNAVAILABLE` | 8    | yes       | Up but temporarily refusing work, or no admins configured yet                               |
| `UNREACHABLE`         | 7    | yes       | DNS, connection refused, or no route                                                        |
| `TLS_FAILURE`         | 7    | no        | The TLS handshake failed — typically a corporate proxy with a private certificate authority |
| `TIMEOUT`             | 7    | yes       | The request exceeded `--timeout`                                                            |
| `NOT_A_PRICK_SERVER`  | 7    | no        | Something answered, but it is not a prick server                                            |
| `UNKNOWN`             | 1    | no        | A status with no specific handling                                                          |

Codes the client raises itself, rather than reading off a response:

| Code                     | Exit     | Meaning                                                                              |
| ------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `UNREPRESENTABLE_OUTPUT` | 9        | A value contains a control character the chosen format cannot encode                 |
| `INVALID_SCOPE`          | 11       | A scope string could not be parsed                                                   |
| `UNSAFE_ENVIRONMENT`     | 11       | A secret's name is one the loader interprets, and `--allow-unsafe-env` was not given |
| `LAUNCH_FAILED`          | 126, 127 | `prk run` could not start the command                                                |

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

## Next steps

- [`prk doctor`](/reference/cli/sign-in#prk-doctor) — check everything at once.
- [Scripting with `--json`](/examples/scripting-with-json)
- [API reference](/reference/api) — the HTTP status codes behind these.
