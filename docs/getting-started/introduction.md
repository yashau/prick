---
title: Introduction
description: What prick is, what it runs on, and the design decisions worth knowing before you adopt it.
sidebar:
  order: 1
---

prick stores secrets in a D1 database that only your Cloudflare account can
reach, and hands them to processes at runtime.

## The three parts

| Part       | What it is                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------- |
| `prk`      | The command-line client. One static Rust binary, published as `@yashau/prick`                 |
| The Worker | One Cloudflare Worker serving a JSON API at `/api/*` and a SvelteKit admin UI everywhere else |
| D1         | The database. Secret values are stored encrypted; key names are stored in plaintext           |

That is the whole system. There is no separate control plane, no agent to run,
and no service to sign up for.

## How a request flows

```
prk / browser  ──▶  Cloudflare Access  ──▶  Worker  ──▶  D1
                    (SSO / service          (Hono +      (values encrypted,
                     tokens, at the edge)    SvelteKit)   AES-256-GCM + AAD)
```

Cloudflare Access authenticates at the edge, before the Worker runs. The Worker
then verifies the signed JWT itself to learn _who_ is calling, and consults its
own `grants` table to decide _what_ they may do.

**Authentication is Cloudflare's. Authorization is prick's.** Getting through
Access means you reached the Worker; it says nothing about what you can read.

## How you use it

Organise secrets into projects and environments:

```
project "api"
├── environment "production"
│   ├── DATABASE_URL
│   └── STRIPE_SECRET_KEY
└── environment "staging"
    ├── DATABASE_URL
    └── STRIPE_SECRET_KEY
```

Write one:

```bash
prk secrets set DATABASE_URL --project api --env production
```

Then hand the whole environment to a process:

```bash
prk run --project api --env production -- npm start
```

Grants are scoped to a project or one of its environments, so the same hierarchy
that organises your secrets is what controls access to them.

## Decisions worth knowing

- **The CLI talks only to your Worker.** It is a pure HTTP client, which is why
  it ships as a single binary with no Node runtime and needs no Cloudflare
  credentials of its own.
- **Deployment is `wrangler deploy`.** Provisioning happens once per install, so
  it belongs to Cloudflare's own tooling rather than to a `prk init` command.
- **Bulk writes are atomic.** An environment-wide write is one D1 `batch()`,
  which is a real transaction, so an environment is never half-written.
- **Every mutation carries an audit row.** The audit insert is the last statement
  _inside_ the same transaction, so a failed audit fails the write with it.
- **A decrypt failure is loud.** A row that will not decrypt fails the request,
  or is marked unreadable in a listing. A silently shorter `.env` is how a deploy
  goes out without `DATABASE_URL`.
- **`MASTER_KEY` is the whole ballgame.** Lose it and the data is unrecoverable.
  Read [Backup and recovery](/guides/backup-and-recovery) before you store
  anything.

## What is built

The security-critical layers exist and are tested: the encryption envelope and
its additional authenticated data, Access JWT verification, grant resolution
including groups, and the bootstrap path. The domain layer is written —
projects, environments, secrets, identities, grants, groups and the audit query
— and the whole HTTP surface is mounted on top of it. The `prk` CLI signs in,
stores its token, sends service-token headers and runs every subcommand.

**The rekey is operator-driven.** `GET /api/v1/admin/keyring` and
`POST /api/v1/admin/rekey` answer for real, a rotation advances one page per
call, and it is finished when `remaining` reaches zero. The settings screen has
a button, and that is the whole mechanism — there is no cron. See
[Key rotation](/guides/key-rotation).

## Next steps

- [Quickstart](/getting-started/quickstart) — deploy the Worker to your account.
- [Install the CLI](/getting-started/install)
- [Architecture overview](/architecture/overview) — how the pieces are wired.
