---
title: Examples
description: Complete, runnable walkthroughs for the jobs people actually do with prick.
sidebar:
  order: 1
  label: Overview
---

Each page here is a complete sequence you can run start to finish, with the
output you should see at each step. The [guides](/guides/authentication) explain
how a feature works; these show a whole job getting done.

## Before you begin

Every example assumes you have a deployed server and are signed in:

```bash
prk login https://prick.example.com
```

```bash
prk whoami
```

```
you@example.com (user)
role: admin (global)
```

If either of those does not work, start with the
[Quickstart](/getting-started/quickstart).

## The examples

| Example                                                     | You end up with                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Onboard a new service](/examples/onboard-a-service)        | A project, two environments, secrets loaded, and the app running       |
| [Migrate from a `.env` file](/examples/migrate-from-dotenv) | An existing repository's secrets moved in, with `.env` deleted         |
| [Give CI read-only access](/examples/ci-read-only)          | A service token that reads exactly one environment and nothing else    |
| [Respond to a leaked secret](/examples/rotate-a-leaked-key) | The leak closed, the blast radius known, and a record of what happened |
| [Script prk with `--json`](/examples/scripting-with-json)   | Reliable automation that fails loudly instead of silently              |

## Conventions on these pages

A block with no output is something to run:

```bash
prk projects list
```

A plain block after it is what you should see:

```
api	API service	3 environment(s)
```

Examples use `api` as the project and `production` as the environment. Set them
once and the flags disappear from every command:

```bash
export PRK_PROJECT=api
export PRK_ENV=production
```
