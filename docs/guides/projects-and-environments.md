---
title: Projects and environments
description: How prick organises secrets, what a slug may contain, and why an environment can never be reparented.
sidebar:
  order: 2
---

:::note[Authenticate first]
Every command here needs an authenticated machine. Start with
[Authentication](/guides/authentication).
:::

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

Grants are scoped to a project or an environment, so the hierarchy is also the
unit of access control. See [Access control](/guides/access-control).

## Projects

```bash
prk projects list
```

```bash
prk projects get api
```

`list` is every project you can see, one line each. `get` is one project in
full — its id, its description, and how many environments it holds — and it is
addressed by slug, like every other command here.

`get` answers `NOT_FOUND` both for a project that does not exist and for one no
grant of yours covers, so it tells you whether _you_ can reach `api`, never
whether the slug is taken. Creating it is what settles that, with a `CONFLICT`
if it is.

```bash
prk projects create "API" --slug api
```

```bash
prk projects rename api "API service"
```

```bash
prk projects rm api
```

`prk projects rm` deletes the project **and everything in it**. Foreign keys are
enforced by D1, so `ON DELETE CASCADE` actually fires: environments, secrets,
version history and any grants scoped to them go with it. There is no
hand-rolled cascade to get half-way through.

Audit rows are the exception. They carry no foreign key to the identity or the
project they name, precisely so that history survives the thing it describes.

## Environments

```bash
prk env list --project api
```

```bash
prk env create production --project api
```

```bash
prk env rm staging --project api
```

There is no rename and no reparent. A rename of the _display name_ is a normal
update; changing which project an environment belongs to is not an operation
that exists.

:::note[Why there is no reparent]
`environments.id` and `environments.project_id` are contractually immutable.
`project_id` is deliberately **excluded** from the encryption AAD so that a
future reparent would not require decrypting and re-encrypting every value in
the project. The price of that choice is that the immutability has to hold. See
[Encryption](/architecture/encryption).
:::

## Naming rules

A project or environment has both a **slug** — the URL-safe identifier the CLI
and the API address it by — and a **name**, which is free text.

| Field       | Rule                                                                                                  | Source                              |
| ----------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Slug        | Lowercase letters and digits, single interior hyphens. No leading or trailing hyphen. 1–64 characters | `packages/shared/src/primitives.ts` |
| Name        | 1–128 characters, free text                                                                           | `packages/shared/src/primitives.ts` |
| Description | Up to 1024 characters, or null                                                                        | `packages/shared/src/limits.ts`     |

Slugs are unique: globally for projects, and within a project for environments.

The slug grammar excludes `/` and `:` on purpose. That is what lets the alias
routes `/p/:slug/e/:slug/…` and the CLI's `project:environment` scope syntax
both parse with no escaping.

Even so, the CLI's scope parser splits on the **first** colon only, so
`a:b:c` is project `a`, environment `b:c`. Splitting on every colon would
silently truncate an environment component and grant or deny access to the wrong
thing — the parser refuses to have that bug regardless of what the slug grammar
currently permits.

## Optimistic concurrency

Every environment carries a `rev` counter that is bumped on each mutation of its
secrets. A full-environment replace can be guarded against a concurrent change:

```bash
prk secrets upload .env --project api --env production --expected-rev 42
```

If the revision moved, the write is refused with `PRECONDITION_FAILED` (HTTP
412, CLI exit code 6) and the environment is left byte-for-byte unchanged. Read
the current revision, re-apply your change, and try again.

## Failure modes

| Symptom                                     | Meaning                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_FOUND` on a project you believe exists | It does not exist **or** it is not visible to you. The API deliberately does not distinguish the two, because a 403/404 split turns the API into an oracle for which names are in use |
| `CONFLICT` on create                        | The slug is already taken at that scope                                                                                                                                               |
| `PRECONDITION_FAILED`                       | `--expected-rev` did not match                                                                                                                                                        |
| `VALIDATION_FAILED`                         | The slug or name broke a rule in the table above                                                                                                                                      |

## Next

- [Secrets](/guides/secrets)
- [Access control](/guides/access-control)
