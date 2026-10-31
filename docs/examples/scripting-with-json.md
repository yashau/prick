---
title: Script prk with --json
description: The output contract that makes prk safe to automate, and recipes that use it.
sidebar:
  order: 6
---

`--json` is what makes `prk` safe to build on. This page covers the contract it
guarantees and the patterns that fall out of it.

## The contract

| Outcome | stdout            | stderr                  | Exit |
| ------- | ----------------- | ----------------------- | ---- |
| Success | one JSON document | **empty**               | 0    |
| Failure | **empty**         | one JSON error envelope | 1–13 |

Both halves are guaranteed, which is what lets you do this without checking
anything first:

```bash
prk secrets download --json --format json > secrets.json
```

If it fails, `secrets.json` is empty rather than a truncated document that still
parses.

## Reading a value

```bash
prk secrets get DATABASE_URL --json -P api -E production
```

```json
{ "key": "DATABASE_URL", "value": "postgres://app@db.example.com/app" }
```

```bash
DATABASE_URL="$(prk secrets get DATABASE_URL --json -P api -E production | jq -r .value)"
```

Without `--json`, `prk secrets get` prints the bare value, which is usually what
you want and needs no `jq` at all:

```bash
DATABASE_URL="$(prk secrets get DATABASE_URL -P api -E production)"
```

Reach for `--json` when you need a **failure** to be machine-readable too.

## Handling a failure

```bash
if ! output=$(prk secrets get MISSING_KEY --json -P api -E production 2>&1 >/dev/null); then
  code=$(printf '%s' "$output" | jq -r .error.code)
  echo "failed with $code"
fi
```

```
failed with NOT_FOUND
```

The envelope:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "…",
    "hint": "Check the spelling with `prk projects list` and `prk env list`. Names are case-sensitive and matched exactly."
  }
}
```

`code` is stable and safe to branch on. `message` is for humans and may change.
`hint` is present only when there is an actionable next step.

Branching on the exit code works just as well, and needs no parsing at all — see
[Exit codes](/reference/cli/errors#exit-codes).

## Always use `--no-input` in a script

```bash
prk secrets download --json --no-input -P api -E production
```

Without it, a command that wants confirmation blocks forever on a prompt nobody
will answer. With it, the same command fails immediately and says why:

```
error: Delete project `web`? refusing to prompt because --no-input was given; pass --yes to confirm
```

For a destructive command a script genuinely means to run, pass `--yes`:

```bash
prk env rm preview-1234 --project api --no-input --yes
```

## Pin the script to one deployment

A script that runs on a machine with several profiles should not depend on
what they are called or which one is the default. Name the deployment by its
instance id, which `prk whoami` prints:

```bash
export PRK_EXPECT_INSTANCE=3f9c01ab52e84d7a9b0c6e1f2a3b4c5d
```

Every `prk` in the script then reaches that deployment or nothing. A rename, a
changed default, or a profile name reused for another server fails with
`INSTANCE_MISMATCH` (exit 3) before the command sends its own first request:

```json
{
  "error": {
    "code": "INSTANCE_MISMATCH",
    "message": "prick.globex.example reports instance a71e09d4c3b2a1f0e9d8c7b6a5f4e3d2, not the expected 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d; nothing beyond the identity check was sent"
  }
}
```

The flag form is `--expect-instance <ID>`. A script that writes, on a machine
with two or more profiles, must also name its server with `--profile` or
`PRK_PROFILE`; the default alone is refused with `PROFILE_REQUIRED`.

## Where a write went

Every write's result document carries a `destination` object naming the server
it reached, the profile that chose it, and the instance the server reported:

```bash
printf '%s' "$KEY" | prk secrets set SESSION_SECRET --stdin --json --profile acme -P api -E production
```

```json
{
  "key": "SESSION_SECRET",
  "rev": 13,
  "created": true,
  "destination": {
    "server": "prick.acme.example",
    "profile": "acme",
    "instance": "3f9c01ab52e84d7a9b0c6e1f2a3b4c5d"
  }
}
```

`profile` is `null` when the server was named by URL and no profile is for it,
and `instance` is `null` when the server was not asked for one. A script can
assert on it:

```bash
printf '%s' "$KEY" | prk secrets set SESSION_SECRET --stdin --json --profile acme -P api -E production \
  | jq -e '.destination.instance == "3f9c01ab52e84d7a9b0c6e1f2a3b4c5d"' > /dev/null
```

Without `--json`, the same three facts are a `writing to …` line on stderr.

## Recipes

### Check whether a key exists

```bash
prk secrets list --json -P api -E production | jq -e '.[] | select(.key == "DATABASE_URL")' > /dev/null
```

`jq -e` exits non-zero when nothing matched, so this works directly in an `if`.

### Fail a deploy when a required key is missing

```bash
required=(DATABASE_URL STRIPE_SECRET_KEY REDIS_URL)
present=$(prk secrets list --json -P api -E production | jq -r '.[].key')

for key in "${required[@]}"; do
  if ! grep -qx "$key" <<< "$present"; then
    echo "missing: $key" >&2
    exit 1
  fi
done
```

### Refuse to deploy from an environment with an unreadable secret

```bash
unreadable=$(prk secrets list --json -P api -E production | jq '[.[] | select(.unreadable)] | length')

if [ "$unreadable" -gt 0 ]; then
  echo "$unreadable secret(s) will not decrypt — not deploying" >&2
  exit 1
fi
```

A row that will not decrypt is a data-integrity failure, not a display problem.
This check is worth having in any pipeline that deploys automatically.

### Read the current revision for an optimistic write

```bash
rev=$(prk env list --json -P api | jq -r '.[] | select(.slug == "production") | .rev')
prk secrets upload .env --expected-rev "$rev" --no-input -P api -E production
```

If anyone wrote to the environment between those two commands, the upload is
refused with exit 6 and nothing changes.

### Diff two environments by key

```bash
diff \
  <(prk secrets list --json -P api -E staging | jq -r '.[].key' | sort) \
  <(prk secrets list --json -P api -E production | jq -r '.[].key' | sort)
```

```
> LEGACY_FLAG
```

Names only — no values are involved, so this is safe to run in a shared shell.

### Copy an environment to another server

```bash
prk secrets download --profile old --format json -P api -E production > /tmp/copy.json
prk secrets upload /tmp/copy.json --profile new --dry-run -P api -E production
```

Each command names its own server; one invocation never talks to two. Without
profiles, `PRK_API_URL=https://old.example.com` and
`PRK_API_URL=https://new.example.com` do the same.

```bash
shred -u /tmp/copy.json
```

The `json` download format and the `.json` upload parser are the same shape, so
this round-trips exactly.

### Health check

```bash
prk doctor --json | jq -e '.ok' > /dev/null || echo "prick is unhealthy"
```

Under `--json`, `prk doctor` exits 0 even when a check failed — read the `ok`
field instead. That is deliberate, so a monitoring script gets the whole report
rather than only an exit code.

### Audit who last wrote each secret

```bash
prk secrets list --json -P api -E production \
  | jq -r '.[] | [.key, .updated_by, (.updated_at / 1000 | strftime("%Y-%m-%d"))] | @tsv'
```

```
DATABASE_URL	you@example.com	2026-08-14
STRIPE_SECRET_KEY	deploy@example.com	2026-07-02
```

Timestamps are epoch **milliseconds**, which is why they are divided by 1000
before formatting.

## Which commands emit what

| Command                          | `--json` produces                                                            |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `projects list`                  | Array of project objects                                                     |
| `projects get`                   | One project object, including `updated_at`                                   |
| `env list`                       | Array of environment objects, including `rev` and `secret_count`             |
| `secrets list`                   | Array of metadata objects, including `unreadable`                            |
| `secrets get`                    | `{ key, value }`                                                             |
| `secrets set`                    | `{ key, rev, created, destination }`                                         |
| `secrets upload`                 | `{ applied, added, changed, removed, warnings, destination }`                |
| `secrets download --format json` | The secrets themselves, sorted by key                                        |
| `secrets history`                | Array of version objects                                                     |
| `secrets rollback`               | `{ key, restored_from, version, rev, destination }`                          |
| `whoami`                         | `{ kind, subject, identity_id, role, bootstrap, server, profile, instance }` |
| `profile list`                   | Array of profile objects, with `server`, `instance` and `signed_in`          |
| `doctor`                         | `{ ok, checks }`                                                             |
| `access identities`              | Array of identity objects                                                    |
| `access explain`                 | The full permission explanation, with sources                                |

Every write — any command that changes data on the server — adds `destination`
to its result object.

## One thing to watch

`prk secrets download --format json` and `prk secrets download --json` are
different requests. `--format` chooses the **export encoding**; `--json` chooses
the **CLI's own** output mode. For a download you almost always want `--format
json`:

```bash
prk secrets download --format json -P api -E production
```

```json
{ "DATABASE_URL": "postgres://app@db.example.com/app" }
```

## Next steps

- [Exit codes and errors](/reference/cli/errors) — every code and whether to retry it.
- [CLI overview](/reference/cli/) — the full output contract.
- [Give CI read-only access](/examples/ci-read-only) — a credential for the script to use.
