# AGENTS.md

Guidance for AI coding agents working in this repository. Humans should read `CONTRIBUTING.md`.

## What this is

A self-hosted secrets manager on Cloudflare. Two halves in one repo:

- `crates/` — Rust workspace, produces the `prk` CLI binary.
- `packages/app` — one Cloudflare Worker serving both a Hono JSON API (`/api/*`) and a SvelteKit
  admin UI (everything else).

Plus, around them: `packages/shared` (zod schemas both halves validate against), `packages/mcp` and
`packages/npm/prick` (published alongside the CLI), `packages/docs` (a **separate** Worker that
renders the root `docs/` Markdown in place), and `action/` (the composite GitHub Action).

## Setup

```bash
mise trust && mise run bootstrap
```

Install **only** mise. It pins Rust, Node, pnpm, Vite+ and every dev tool. A system-wide install of
any of them shadows the pinned version.

## Tasks

`mise run <task>` is the entry point for everything. Invoking `cargo`, `pnpm`, `vp` or `wrangler`
directly bypasses the pins and the `TZ=UTC` every task sets — reach for a task first, and add one if
none fits. `mise tasks` lists them all with descriptions.

Aggregates are pure fan-out and **every leaf is individually runnable.** Run the aggregate; when it
fails, narrow to the leaf rather than re-running the whole gate.

### Gates

`mise run ci` is all of them, in the order CI runs them. **Run it before declaring work done** — it
mirrors `ci.yml` exactly, so a green run here is a green run there.

| Gate            | Covers                                                                     | Narrow to                                                                                                     |
| --------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `bootstrap`     | Workspace dependencies + git hooks                                         | `bootstrap:js`, `bootstrap:hooks`                                                                             |
| `fmt:check`     | Fails if anything is unformatted                                           | `fmt:check:rust`, `fmt:check:js`                                                                              |
| `lint`          | clippy, Oxlint, svelte-check, actionlint, zizmor, pinact, typos, file size | `lint:rust`, `lint:js`, `lint:svelte`, `lint:actions`, `lint:zizmor`, `lint:pinact`, `lint:typos`, `lint:loc` |
| `typecheck`     | TypeScript across the workspace                                            | —                                                                                                             |
| `test`          | Rust, doc, Worker, script, action and MCP suites                           | `test:rust`, `test:doc`, `test:js`, `test:scripts`, `test:action`, `test:mcp`                                 |
| `openapi:check` | Fails if `docs/openapi.json` is stale                                      | regenerate with `openapi`                                                                                     |
| `deny`          | Licences, bans, advisories, the git-source ban                             | —                                                                                                             |
| `audit`         | Advisories against both dependency trees                                   | `audit:rust`, `audit:js`                                                                                      |
| `miri`          | The purity proof for `prick-core`                                          | —                                                                                                             |
| `build`         | CLI, Worker bundle and MCP server                                          | `build:rust`, `build:js`, `build:mcp`                                                                         |
| `e2e`           | Playwright; `e2e:install` fetches the browsers first                       | —                                                                                                             |
| `version:check` | Every manifest carries the same version                                    | —                                                                                                             |

`lint:js` splits further into `lint:js:app` and `lint:js:repo` — packages/app has to be linted from
inside itself, because SvelteKit's plugin resolves `src/app.html` relative to the working directory.

### Version and release

Never hand-edit a version; see the Conventions below for why the tag is the source of truth.

| Task                         | Does                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `version:plan`               | Compute today's CalVer and the tag that would claim it. Read-only                     |
| `version:check`              | Assert every manifest carries the same version. Read-only                             |
| `version:set`                | Stamp a version into every manifest. CI calls this immediately before compiling       |
| `cli:next` / `docs:next`     | Print the version and tag the next release would take. Read-only, never prompts       |
| `cli:dry`                    | Dispatch `cli-release.yml` with `dry_run=true` — stages everything, publishes nothing |
| `cli:cut` / `docs:cut`       | **Releases it.** Tags and pushes; that push is the only trigger                       |
| `cli:status` / `docs:status` | Follow the most recent run. Read-only                                                 |

`*:cut` demands a typed confirmation of the **tag**, so it cannot be answered from muscle memory.
`--yes` skips it, for automation only.

**Do not cut a release unless you were asked to cut one.** npm versions are immutable and a tag is
never deleted and re-pushed — the fix for a bad release is to roll forward to the next `N`. The
read-only tasks (`*:next`, `version:plan`) answer "what would this take?" without claiming anything.

`build:auditable`, `build:dist` and `audit:bin` exist for the release workflow — per-target builds,
and the RustSec check that reads a built binary's embedded dependency list. You rarely run them.

### Local development

| Task                          | Does                                                |
| ----------------------------- | --------------------------------------------------- |
| `dev`                         | Worker + SvelteKit dev server                       |
| `docs:dev`                    | Documentation site with hot reload                  |
| `docs:build` / `docs:preview` | Build the docs site / serve the built output        |
| `openapi`                     | Regenerate `docs/openapi.json` from the Hono router |
| `fmt`                         | Format everything in place                          |
| `clean`                       | Remove build outputs and installed dependencies     |

`dev`, `docs:dev` and `docs:preview` are servers: they do not exit. Do not block a turn on one.

## Rules that are enforced by tooling

Breaking these fails the build, not review.

1. **No writes to stdout/stderr outside `crates/prk/src/output/`.** `print_stdout` and
   `print_stderr` are denied workspace-wide. This exists so that leaking a secret into a log line is
   a compile error. Add a helper to `output`; never widen the allow.
2. **`prick-core` is pure** — no I/O, no async, no `unsafe`, no FFI. `cargo miri test -p prick-core`
   is a machine-checked proof of that; it cannot pass if you add a file read, a clock call, or an FFI
   dependency. Put impure code in `prick-api` / `prick-auth` / `prick-exec` instead.

## Rules that are not mechanically enforced — you must hold these yourself

1. **Never log, print, or embed a secret value.** Error messages name the _key_, never the value.
   Values are `SecretString`; do not `{:?}` your way around the redacted `Debug`.
2. **Do not describe this project by comparison to another.** It stands alone, so a reader has no
   referent for "what X did". State the property and the hazard on their own terms — "a decrypt
   failure must be loud, because a silently skipped row becomes a `.env` that deploys production
   without `DATABASE_URL`" carries the whole argument and needs no absent other. Nothing checks
   this; it is yours to hold.
3. **Never return a secret value from a SvelteKit `+*.server.ts` load or form action.** SvelteKit
   serialises those into the page payload. Secret values reach the browser only via a client-side
   `fetch` to `/api/*`, from the `ssr = false` subtree.
4. **Never widen an AAD.** Ciphertexts are bound to `(purpose, environment_id, key, version)`. If a
   mutation changes any of those, you must decrypt and re-encrypt — never copy a ciphertext blob
   between rows. There is no cheap rename.
5. **Never write a mutation without an audit row in the same `batch()`.** The audit insert is the
   last statement in the transaction so that an un-audited mutation is impossible.
6. **Never split a bulk write across multiple `batch()` calls.** That destroys atomicity. If it does
   not fit, reject it with 413.
7. **Never swallow a decrypt failure.** A tamper attempt must be the loudest thing in the system.

## Conventions

- Migrations are **additive only**; they apply before the new code deploys. Destructive changes take
  three releases (add nullable + backfill → require → drop).
- Versions are CalVer and machine-managed. Every manifest reads `0.0.0-dev`; the git tag is the
  source of truth. **Never hand-edit a version.**
- Two release lines, one mechanism: `cli:*` on the `v` tag prefix and `docs:*` on `docs-v`.
  **Cutting the version is what releases it** — `mise run cli:cut` / `docs:cut` push the tag, and
  that push is the only trigger for `cli-release.yml` / `docs-release.yml`. Neither workflow
  computes a version, and nothing in CI moves a ref. See `docs/contributing/releasing.md`.
- Conventional Commits. We squash-merge, so the PR title becomes the commit message.
- `unsafe` belongs only in `prick-exec`, needs a `// SAFETY:` comment, and needs integration tests —
  miri cannot reach it.

## Where things live

| Concern                                    | Path                                       |
| ------------------------------------------ | ------------------------------------------ |
| Pure logic (parsing, formatting, escaping) | `crates/prick-core/`                       |
| HTTP client, error classification          | `crates/prick-api/`                        |
| Access OAuth, token storage                | `crates/prick-auth/`                       |
| Process spawn, signals                     | `crates/prick-exec/`                       |
| CLI commands and rendering                 | `crates/prk/`                              |
| Domain logic, transport-agnostic           | `packages/app/src/lib/server/core/`        |
| Crypto (envelope, AAD, keyring)            | `packages/app/src/lib/server/crypto/`      |
| Access JWT verification                    | `packages/app/src/lib/server/auth/`        |
| Hono route mounting and middleware         | `packages/app/src/lib/server/http/`        |
| Drizzle schema                             | `packages/app/src/lib/server/db/schema.ts` |
| UI routes                                  | `packages/app/src/routes/`                 |
| Prose documentation                        | `docs/` (root, not `packages/docs/`)       |

The domain layer takes `(db, actor, input)` and knows nothing about HTTP. Hono routes and SvelteKit
loads are both thin transports over it — so authorization is written once, in `core`.

`docs/openapi.json` is **generated** from the Hono router by `mise run openapi`, and
`mise run openapi:check` fails if it is stale. Never hand-edit it; if you changed a route,
regenerate it in the same commit. It is the source of truth for the HTTP surface, and
`docs/reference/api.md` summarises it rather than duplicating it.

## UI

Components come from the **shadcn-svelte registry** (`pnpm dlx shadcn-svelte@latest add <name>`).
Do not hand-roll a component the registry provides. Svelte 5 runes only — `$props()`, `$state`,
`$derived`; `$effect` for genuine side effects, never derived data.
