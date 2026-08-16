---
title: prk env
description: Create, list and delete the environments inside a project.
sidebar:
  order: 4
---

An environment holds secrets. `production`, `staging` and `preview` are the
usual three, but the model imposes nothing — an environment is whatever unit you
want to grant access to and deploy from.

```
prk env list
prk env create <NAME> [--slug <SLUG>]
prk env rm <SLUG>
```

Every command here operates inside one project, so it needs `--project` (or
`PRK_PROJECT`).

## `prk env list`

```bash
prk env list --project api
```

```
production	Production	rev 42	12 secret(s)
staging	Staging	rev 7	12 secret(s)
```

Columns are tab-separated: slug, name, revision, secret count. With nothing to
show:

```
No environments. Create one with `prk env create <NAME>`.
```

The **revision** is the optimistic-concurrency counter. It goes up on every
mutation of the environment's secrets, and it is what you pass to
[`prk secrets upload --expected-rev`](/reference/cli/secrets#guard-against-a-concurrent-change).

```bash
prk env list --project api --json
```

```json
[
  {
    "id": "0198f3c2-8a1b-7c22-b0d5-3e8a2c6f9d41",
    "project_id": "0198f3c2-7f0a-7a11-9d4c-2f9b1d5e8c30",
    "slug": "production",
    "name": "Production",
    "rev": 42,
    "secret_count": 12
  }
]
```

Read the current revision on its own:

```bash
prk env list --project api --json | jq -r '.[] | select(.slug == "production") | .rev'
```

```
42
```

## `prk env create`

```bash
prk env create Production --project api
```

```
Created environment `Production` (production).
```

| Argument / flag | Meaning                                              |
| --------------- | ---------------------------------------------------- |
| `<NAME>`        | Display name, free text                              |
| `--slug <SLUG>` | URL-safe identifier. Derived from `<NAME>` if absent |

Give the slug explicitly when the display name would not derive the one you
want:

```bash
prk env create "EU West" --slug eu-west --project api
```

```
Created environment `EU West` (eu-west).
```

:::note[Address environments by slug, not display name]
`eu-west` reaches the environment shown as "EU West". The two are separate
fields on the server, and only the slug appears in a URL, a `--scope` or an
`--env` flag.
:::

## `prk env rm`

Deletes the environment **and every secret in it**.

```bash
prk env rm staging --project api
```

```
Delete environment `staging` and all its secrets? [y/N]
```

```
Deleted environment `staging`.
```

Skip the prompt with `--yes`:

```bash
prk env rm staging --project api --yes
```

Under `--no-input`, the command refuses rather than assuming an answer:

```
error: Delete environment `staging` and all its secrets? refusing to prompt because --no-input was given; pass --yes to confirm
```

## What environments cannot do

There is no rename and no reparent. Renaming the _display name_ is an ordinary
update; changing which project an environment belongs to is not an operation
that exists.

:::note[Why reparenting is absent]
`environments.id` and `environments.project_id` are contractually immutable, and
`project_id` is deliberately excluded from the encryption AAD so that a
hypothetical reparent would not require decrypting and re-encrypting every value
in the project. The price of that choice is that the immutability has to hold.
See [Encryption](/architecture/encryption).
:::

## Common errors

| Error               | Exit | What happened                                               |
| ------------------- | ---- | ----------------------------------------------------------- |
| `NOT_FOUND`         | 5    | No such project or environment, or it is not visible to you |
| `CONFLICT`          | 6    | That slug is already taken in this project                  |
| `FORBIDDEN`         | 4    | You are not an admin at this scope                          |
| `VALIDATION_FAILED` | 11   | The name or slug broke a naming rule                        |

Missing the project entirely gives a local error before any request is made:

```
error: no project selected; pass --project <SLUG> or set PRK_PROJECT
```

## Next steps

- [`prk secrets`](/reference/cli/secrets) — put something in the environment you just created.
- [Projects and environments](/guides/projects-and-environments)
