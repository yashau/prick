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
| Failure | **empty**         | one JSON error envelope | 1–11 |

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
PRK_API_URL=https://old.example.com prk secrets download --json --format json -P api -E production > /tmp/copy.json
PRK_API_URL=https://new.example.com prk secrets upload /tmp/copy.json --dry-run -P api -E production
```

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

| Command                          | `--json` produces                                                |
| -------------------------------- | ---------------------------------------------------------------- |
| `projects list`                  | Array of project objects                                         |
| `projects get`                   | One project object, including `updated_at`                       |
| `env list`                       | Array of environment objects, including `rev` and `secret_count` |
| `secrets list`                   | Array of metadata objects, including `unreadable`                |
| `secrets get`                    | `{ key, value }`                                                 |
| `secrets set`                    | `{ key, rev, created }`                                          |
| `secrets upload`                 | `{ applied, added, changed, removed, warnings }`                 |
| `secrets download --format json` | The secrets themselves, sorted by key                            |
| `secrets history`                | Array of version objects                                         |
| `secrets rollback`               | `{ key, restored_from, version, rev }`                           |
| `whoami`                         | `{ kind, subject, identity_id, role, bootstrap }`                |
| `doctor`                         | `{ ok, checks }`                                                 |
| `access identities`              | Array of identity objects                                        |
| `access explain`                 | The full permission explanation, with sources                    |

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
