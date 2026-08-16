---
title: prk projects
description: Create, list, inspect, rename and delete projects.
sidebar:
  order: 3
---

A project is the outer container: it holds environments, and environments hold
secrets. Grants are scoped to a project or to one of its environments, so the
project is also the unit of access control.

```
prk projects list
prk projects get <PROJECT>
prk projects create <NAME> [--slug <SLUG>]
prk projects rename <PROJECT> <NAME>
prk projects rm <PROJECT>
```

Projects are addressed by **slug** everywhere — in these commands, in URLs, and
in `--scope`.

## `prk projects list`

Every project you can see, one line per project.

```bash
prk projects list
```

```
api	API service	3 environment(s)
billing	Billing	2 environment(s)
web	Marketing site	1 environment(s)
```

Columns are tab-separated: slug, name, environment count. With nothing to show:

```
No projects. Create one with `prk projects create <NAME>`.
```

```bash
prk projects list --json
```

```json
[
  {
    "id": "0198f3c2-7f0a-7a11-9d4c-2f9b1d5e8c30",
    "slug": "api",
    "name": "API service",
    "description": "Everything customer-facing",
    "environment_count": 3
  }
]
```

## `prk projects get`

One project in full, including the id and description that the listing leaves
out.

```bash
prk projects get api
```

```
api	API service
id	0198f3c2-7f0a-7a11-9d4c-2f9b1d5e8c30
description	Everything customer-facing
environments	3
```

A project with no description prints `none` in that row.

```bash
prk projects get api --json
```

```json
{
  "description": "Everything customer-facing",
  "environment_count": 3,
  "id": "0198f3c2-7f0a-7a11-9d4c-2f9b1d5e8c30",
  "name": "API service",
  "slug": "api",
  "updated_at": 1760000000000
}
```

The JSON document carries `updated_at` as well — epoch milliseconds, which is
why the human rendering leaves it out.

:::note[`NOT_FOUND` means "not visible to you"]
A project that does not exist and a project no grant of yours covers give the
same answer, down to the hint. So a slug missing from `list` or refused by `get`
is not a slug you can conclude is free — creating it is what settles that, with
a `CONFLICT` if it is taken.
:::

## `prk projects create`

```bash
prk projects create "API service" --slug api
```

```
Created project `API service` (api).
```

| Argument / flag | Meaning                                              |
| --------------- | ---------------------------------------------------- |
| `<NAME>`        | Display name, free text, 1–128 characters            |
| `--slug <SLUG>` | URL-safe identifier. Derived from `<NAME>` if absent |

Leave `--slug` off and it is derived from the name:

```bash
prk projects create "Billing EU"
```

```
Created project `Billing EU` (billing-eu).
```

A slug you pass explicitly is **validated, not mangled**, so a typo is reported
rather than silently turned into a different identifier:

```bash
prk projects create "Billing EU" --slug "Billing EU"
```

```
error: `Billing EU` is not a usable project name: it must be lowercase letters, digits and single hyphens, at most 64 characters. Did you mean `billing-eu`?
```

If nothing usable can be derived from the name, `prk` asks for a slug instead of
inventing one:

```bash
prk projects create "日本"
```

```
error: no project slug could be derived from `日本`; pass --slug <SLUG> with lowercase letters, digits and single hyphens
```

## `prk projects rename`

Changes the **display name**. The slug stays as it is.

```bash
prk projects rename api "Customer API"
```

```
Renamed project `Customer API` (api).
```

:::note[A slug is permanent]
The slug is how every script, grant and URL addresses the project, so it stays
fixed for the life of the project. Create a new project and move the
environments if you genuinely need a different identifier.
:::

## `prk projects rm`

Deletes the project **and everything in it** — environments, secrets, version
history, and any grants scoped to them.

```bash
prk projects rm web
```

```
Delete project `web`? [y/N]
```

Answer `y` or `yes` to go ahead:

```
Deleted project `web`.
```

Skip the prompt with `--yes`:

```bash
prk projects rm web --yes
```

Under `--no-input`, the command refuses rather than assuming an answer:

```bash
prk projects rm web --no-input
```

```
error: Delete project `web`? refusing to prompt because --no-input was given; pass --yes to confirm
```

:::caution[The cascade is real]
Foreign keys are enforced by D1, so `ON DELETE CASCADE` fires: environments,
secrets and version history go with the project. Audit rows are the exception —
they carry no foreign key to what they name, so the history of a deleted project
survives it.
:::

## Naming rules

| Field       | Rule                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Slug        | Lowercase letters and digits, single interior hyphens. No leading or trailing hyphen. 1–64 characters |
| Name        | 1–128 characters, free text                                                                           |
| Description | Up to 1024 characters, or null                                                                        |

Project slugs are unique across the whole server. Environment slugs are unique
within their project.

## Common errors

| Error               | Exit | What happened                                        |
| ------------------- | ---- | ---------------------------------------------------- |
| `NOT_FOUND`         | 5    | No such project, or no grant of yours covers it      |
| `CONFLICT`          | 6    | That slug is already taken                           |
| `FORBIDDEN`         | 4    | You are authenticated but not an admin at this scope |
| `VALIDATION_FAILED` | 11   | The name or slug broke one of the rules above        |

## Next steps

- [`prk env`](/reference/cli/env) — add environments to the project you just made.
- [Projects and environments](/guides/projects-and-environments) — the model behind these commands.
- [`prk access`](/reference/cli/access) — grant someone a role on the project.
