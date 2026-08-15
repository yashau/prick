---
title: Introduction
description: What prick is, what it runs on, and the design decisions worth knowing before you adopt it.
sidebar:
  order: 1
---

prick stores secrets in a D1 database that only your Cloudflare account can
reach, and hands them to processes at runtime.

There are three moving parts:

| Part       | What it is                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------- |
| `prk`      | The command-line client. One static Rust binary, published as `@yashau/prick`                 |
| The Worker | One Cloudflare Worker serving a JSON API at `/api/*` and a SvelteKit admin UI everywhere else |
| D1         | The database. Secret values are stored encrypted; key names are not                           |

## How a request flows

```
prk / browser  ──▶  Cloudflare Access  ──▶  Worker  ──▶  D1
                    (SSO / service          (Hono +      (values encrypted,
                     tokens, at the edge)    SvelteKit)   AES-256-GCM + AAD)
```

Cloudflare Access authenticates at the edge, before the Worker runs. The Worker
then verifies the signed JWT itself to learn _who_ is calling, and consults its
own `grants` table to decide _what_ they may do. Authentication is Cloudflare's;
authorization is prick's.

## Decisions worth knowing

- **The CLI never talks to the Cloudflare API.** It is a pure HTTP client
  against your Worker. That is why it needs no Cloudflare credentials and why it
  ships as a single binary with no Node runtime.
- **Deployment is `wrangler deploy`.** There is no `prk init` and no
  provisioning command. Provisioning happens once per install, so it belongs to
  Cloudflare's own tooling.
- **Bulk writes are atomic.** An environment-wide write is one D1 `batch()`,
  which is a real transaction. There is no window in which an environment is
  half-written.
- **Nothing mutates without an audit row.** The audit insert is the last
  statement _inside_ the same transaction, so if the audit write fails the data
  write fails with it.
- **A decrypt failure is loud.** A row that will not decrypt fails the request or
  is marked unreadable. It is never quietly skipped, because a silently shorter
  `.env` is how a deploy goes out without `DATABASE_URL`.
- **`MASTER_KEY` is the whole ballgame.** Lose it and the data is unrecoverable.
  See [Backup and recovery](/guides/backup-and-recovery).

## What is built today

The security-critical layers exist and are tested: the encryption envelope and
its additional authenticated data, Access JWT verification, grant resolution and
the bootstrap path, plus the projects and environments domain logic.

What is not built yet: the secrets domain logic, the identities and grants
domain logic, the rekey job, every HTTP route except `/api/v1/health`, most of
the CLI, and the UI beyond a route skeleton.

Each page in this documentation marks the gap where it applies. Nothing here
describes behaviour that does not exist without saying so.

## Next

- [Quickstart](/getting-started/quickstart) — deploy the Worker.
- [Authentication](/guides/authentication) — get a machine authenticated.
- [Architecture overview](/architecture/overview) — how the pieces are wired.
