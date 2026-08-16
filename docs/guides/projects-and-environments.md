---
title: Projects and environments
description: How prick organises secrets, what a slug may contain, and how optimistic concurrency protects a bulk write.
sidebar:
  order: 2
---

Secrets live in an environment. Environments belong to a project. That is the
whole hierarchy.

```
project "api"
├── environment "production"
│   ├── DATABASE_URL
│   └── STRIPE_SECRET_KEY
└── environment "staging"
    ├── DATABASE_URL
    └── STRIPE_SECRET_KEY
```

Grants are scoped to a project or to one of its environments, so the same
hierarchy that organises your secrets is what controls access to them. See
[Access control](/guides/access-control).

:::note[Before you begin]
Every command here needs an authenticated machine. Start with
[Authentication](/guides/authentication).
:::

## Slugs and names

Every project and environment has two identifiers:

| Field | What it is                                                 |
| ----- | ---------------------------------------------------------- |
| Slug  | The URL-safe identifier that commands, URLs and scopes use |
| Name  | Free text, for people to read                              |

`eu-west` is a slug; "EU West" is a name. Commands take the slug.

```bash
prk env create "EU West" --slug eu-west --project api
```

Leave `--slug` off and it is derived from the name. A slug you pass explicitly
is validated rather than mangled, so a typo is reported instead of silently
becoming a different identifier.

| Field       | Rule                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Slug        | Lowercase letters and digits, single interior hyphens. No leading or trailing hyphen. 1–64 characters |
| Name        | 1–128 characters, free text                                                                           |
| Description | Up to 1024 characters, or null                                                                        |

Project slugs are unique across the server; environment slugs are unique within
their project.

The slug grammar excludes `/` and `:` on purpose. That is what lets the alias
routes `/p/:slug/e/:slug/…` and the `project:environment` scope syntax both
parse with no escaping.

Even so, the scope parser splits on the **first** colon only, so `a:b:c` is
project `a`, environment `b:c`. Splitting on every colon would silently truncate
an environment component and grant or deny access to the wrong thing — the
parser refuses to have that bug regardless of what the slug grammar currently
permits.

## Working with projects

```bash
prk projects list
```

```
api	API service	3 environment(s)
billing	Billing	2 environment(s)
```

```bash
prk projects get api
```

`list` is every project you can see, one line each. `get` is one project in full
— its id, its description, and how many environments it holds.

`get` answers `NOT_FOUND` both for a project that does not exist and for one no
grant of yours covers, so it tells you whether **you** can reach `api`, never
whether the slug is taken. Creating it is what settles that, with a `CONFLICT`
if it is.

Full flags: [`prk projects`](/reference/cli/projects).

:::caution[Deleting a project takes everything with it]
`prk projects rm api` deletes the project **and everything in it**. Foreign keys
are enforced by D1, so `ON DELETE CASCADE` actually fires: environments,
secrets, version history and any grants scoped to them go with it.

Audit rows are the exception. They carry no foreign key to the identity or the
project they name, precisely so that history survives the thing it describes.
:::

## Working with environments

```bash
prk env list --project api
```

```
production	Production	rev 42	12 secret(s)
staging	Staging	rev 7	12 secret(s)
```

Full flags: [`prk env`](/reference/cli/env).

There is no rename and no reparent. Renaming the _display name_ is an ordinary
update; changing which project an environment belongs to is not an operation
that exists.

:::note[Why reparenting is absent]
`environments.id` and `environments.project_id` are contractually immutable.
`project_id` is deliberately **excluded** from the encryption AAD so that a
future reparent would not require decrypting and re-encrypting every value in
the project. The price of that choice is that the immutability has to hold. See
[Encryption](/architecture/encryption).
:::

## Optimistic concurrency

Every environment carries a `rev` counter, bumped on each mutation of its
secrets. It is the third column of `prk env list`.

Use it to make a full-environment replace safe against a concurrent change:

```bash
rev=$(prk env list --project api --json | jq -r '.[] | select(.slug == "production") | .rev')
```

```bash
prk secrets upload .env --project api --env production --expected-rev "$rev"
```

If the revision moved between those two commands, the write is refused with
`PRECONDITION_FAILED` (HTTP 412, exit code 6) and the environment is left
byte-for-byte unchanged. Read the current revision, re-apply your change, and
try again.

## When something goes wrong

| Symptom                                     | Meaning                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_FOUND` on a project you believe exists | It does not exist **or** it is not visible to you. The API deliberately does not distinguish the two, because a 403/404 split turns the API into an oracle for which names are in use |
| `CONFLICT` on create                        | The slug is already taken at that scope                                                                                                                                               |
| `PRECONDITION_FAILED`                       | `--expected-rev` did not match                                                                                                                                                        |
| `VALIDATION_FAILED`                         | The slug or name broke a rule in the table above                                                                                                                                      |

## Next steps

- [Secrets](/guides/secrets) — put something in an environment.
- [Onboard a new service](/examples/onboard-a-service) — the whole sequence, worked through.
- [Access control](/guides/access-control)
