---
title: Overview
description: One Worker, two transports, one domain layer — and the data model constraints that carry the correctness.
sidebar:
  order: 1
---

```
┌────────────┐  Managed OAuth + PKCE   ┌──────────────────────────────┐
│  prk (Rust)│────────────────────────▶│  Cloudflare Access           │
│            │  or service-token hdrs  │  (authenticates at the edge) │
└────────────┘                         └──────────────┬───────────────┘
┌────────────┐  Access SSO                            │ signed JWT
│  Browser   │───────────────────────────────────────▶▼
│  SvelteKit │◀── static assets ──┌──────────────────────────────────┐
└────────────┘                    │  Worker                          │
                                  │  hooks.server.ts splits:         │
                                  │    /api/* → Hono                 │
                                  │    else   → SvelteKit SSR        │
                                  │  both call core/* in-process     │
                                  └──────────────┬───────────────────┘
                                                 ▼
                                        ┌──────────────────┐
                                        │  D1 (values      │
                                        │  encrypted+AAD)  │
                                        └──────────────────┘
```

## The decision everything hangs off

`packages/app/src/lib/server/core/*` takes `(db, actor, input)`, returns data or
throws a `PrickError`, and knows nothing about HTTP. The Hono routes and the
SvelteKit load functions are both thin transports over it.

That is not tidiness. It has two concrete consequences.

**No internal HTTP hop.** A SvelteKit server load calls `listProjects()`
in-process. It cannot usefully call its own `/api` instead: `event.fetch` does
not forward arbitrary headers, so `Cf-Access-Jwt-Assertion` could not be passed
through, and the `CF_Authorization` cookie is documented as not guaranteed to be
passed either. An internal hop would have to re-solve authentication, badly.

**Authorization is written once.** The bug class where one handler checks scope
and the handler next to it forgets is not something discipline prevents here —
it is unreachable, because both transports enter through the same function.

## Repository layout

```
crates/
  prk/          the binary: argument parsing, commands, rendering
  prick-core/   PURE: no I/O, no async, no unsafe
  prick-api/    HTTP client, typed models, error classification
  prick-auth/   OAuth + PKCE, service tokens, token storage
  prick-exec/   process launch, signals, job objects
packages/
  app/          THE deployed Worker: Hono API + SvelteKit UI
  shared/       zod schemas shared by the Worker and the UI
  npm/prick/    the published @yashau/prick launcher
scripts/        Node ESM helpers (version stamping, npm assembly, release)
e2e/            Playwright
xtask/          shell completions and man page generation
```

Cargo members are `crates/*`; pnpm packages are `packages/*`. Neither glob
crosses.

## Data model

Eight tables: `projects`, `environments`, `secrets`, `secret_versions`,
`identities`, `grants`, `audit_log`, `keyring_state`.

Conventions that hold throughout `packages/app/src/lib/server/db/schema.ts`:

- **IDs are UUIDv7 text.** Not `crypto.randomUUID()`, which is v4. v7 embeds a
  millisecond timestamp in its high bits and therefore sorts lexicographically in
  creation order, which is what makes `WHERE id > :cursor ORDER BY id` a correct,
  index-only keyset paginator for the audit log. With v4 ids the same query
  returns rows in arbitrary order and the cursor means nothing.
- **Timestamps are integer epoch milliseconds.** Never ISO-8601 text: that
  compares correctly only by accident of format, costs bytes, and forces a parse
  on every read.
- **Foreign keys are real.** D1 enforces them by default, so `ON DELETE CASCADE`
  actually fires and there is no hand-rolled cascade to get wrong.

### The constraints that are load-bearing

**`UNIQUE(environment_id, key, version)` on `secret_versions` is the concurrency
primitive.** There is no lock table anywhere in the schema because of it. Two
writers racing on the same key both read version N and both compute N+1; both
batches attempt the same insert. One commits, and the other trips the constraint
— which aborts its **entire** batch, because D1 rolls back on error. The loser
writes nothing at all: not a partial update, not an out-of-order version. It
retries once against the new state, and returns `409` if it loses again.

**`grants` uses partial unique indexes, one per scope type**, not one composite
index over `(identity_id, scope_type, project_id, environment_id)`. SQLite
follows the standard in treating `NULL`s as distinct for uniqueness, so in a
composite index two global grants — both `(id, 'global', NULL, NULL)` — would not
collide. The constraint would look correct, pass every casual test, and silently
permit unlimited duplicate global admin grants.

**There is no foreign key on `secret_versions.key`.** History is keyed by
`(environment_id, key)` rather than by `secrets.id`, so deleting a key and
recreating it continues the version sequence instead of restarting at 1. A
version number therefore never refers to two different values in one environment
— which matters, because the version is inside the data each ciphertext is bound
to.

**`audit_log` has no foreign key to `identities`.** An audit row must outlive the
identity it names, and a cascade would delete exactly the history you need after
revoking someone's access.

**`secret_versions` has nine columns, and the count is load-bearing.** D1 allows
100 bound parameters per query, so a multi-row insert fits 11 rows. Adding a
tenth column drops that to 10 and must be a deliberate decision.

## Atomic writes

A bulk write is:

1. **One read** for existing keys and versions. It serves the authenticated-data
   versions, the delete set, the audit diff and the revision check at once.
2. Compute in JavaScript, and encrypt each value against its next version.
3. **One `batch()`**: revision bump, multi-row insert into `secret_versions`,
   multi-row upsert into `secrets`, tombstones, deletes, and the **audit insert
   last**.

D1's `batch()` is a real transaction: if a statement fails, the whole sequence
rolls back. A 100-secret write is roughly 23 statements in one batch instead of
101 sequential round-trips.

The audit insert being *inside* the batch is what makes an un-audited mutation
unrepresentable rather than merely discouraged. If the audit write fails, the
data write fails with it.

### Why the environment cap exists

A full-environment replace must fit in one batch, because splitting it would
forfeit atomicity, and `batch()` has a documented 30-second ceiling. So there is
a hard cap — `ENV_MAX_SECRETS`, default 500 — and anything larger is a `413`.
That number is derived from an undocumented per-batch statement limit and needs
load-testing; if it does not hold, the fix is a lower cap, never a split batch.

### The optimistic-concurrency guard

`UPDATE … WHERE rev = ?` does **not** work as a guard. D1 rolls back on an
*error*, not on zero rows changed, so a non-matching update succeeds as a no-op
and the rest of the batch commits anyway.

The construct that works is a deliberate primary-key collision:

```sql
INSERT INTO environments SELECT * FROM environments WHERE id = ?1 AND rev != ?2
```

Zero rows — a harmless no-op — when the revision matches; one row, and therefore
a primary key violation that aborts the whole batch, when it does not. Mapped to
`412`.

## The UI

Screens with no secret values in them — projects, environments, access, audit —
use server-side rendering and server loads.

The **secrets subtree only** sets `ssr = false`. It is client-rendered, and
values are fetched from `/api/v1` in the browser. No server render means no
serialised page payload, which means there is nothing there to leak. Form actions
are used for projects, environments and grants only, never for anything that
returns a value, because SvelteKit serialises an action's return into page data.

This is enforced by a build-time check rather than by convention.

## Status

| Layer | State |
|---|---|
| Crypto (`crypto/`) | Implemented |
| Access verification and authorization (`auth/`) | Implemented |
| Projects, environments, audit helpers (`core/`) | Implemented |
| Secrets, identities, keyring (`core/`) | Stubs that throw `NOT_IMPLEMENTED` |
| Hono routes | `GET /api/v1/health` only |
| SvelteKit UI | Route skeleton |
| CLI | `version` and `completions` only |

## Next

- [Encryption](/architecture/encryption)
- [Authorization](/architecture/authorization)
- [Threat model](/architecture/threat-model)
