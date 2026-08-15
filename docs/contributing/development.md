---
title: Development
description: Setting up a clone, the task graph, and the rules that are enforced by tooling rather than by review.
sidebar:
  order: 1
---

## Setup

Install [mise](https://mise.jdx.dev) and nothing else.

```bash
git clone https://github.com/yashau/prick && cd prick
```

```bash
mise trust
```

```bash
mise run bootstrap
```

```bash
mise run dev
```

`mise.toml` pins exact versions of Rust, Node, pnpm, Vite+ and every dev tool. A
system-wide install of any of them shadows the pinned one, and you will spend an
afternoon debugging a problem nobody else has.

`mise trust` is required once per clone before the config's environment applies.

**On Windows**, run this once:

```bash
git config --global core.longpaths true
```

A multi-crate Rust workspace under a deep path routinely produces artefact paths
over 260 characters.

No Cloudflare account is needed for local development — the Worker runs against
miniflare.

## Repository shape

```
crates/     Rust workspace. The binary is `prk`.
packages/   pnpm workspace: app, shared, docs, mcp, npm/prick.
action/     The composite GitHub Action.
scripts/    Node ESM helpers. Not bash — they must run on Windows.
xtask/      Completion and man page generation.
e2e/        Playwright.
```

`packages/docs` is a renderer, not a copy of the documentation: the Markdown it
builds lives in the repository-root `docs/` directory and is read **in place** by
Astro's content loader. There is deliberately no symlink and no prebuild copy step,
so "the docs" has exactly one meaning.

The two workspaces never overlap: Cargo members are `crates/*`, pnpm packages are
`packages/*`.

Scripts are Node ESM rather than shell because a `.sh` would work in CI and fail
for a Windows contributor. Node is guaranteed present because mise installed it.

## Everyday tasks

`mise tasks` lists everything. The ones you will use:

| Task                     | Does                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| `mise run dev`           | Worker + UI dev server                                                        |
| `mise run fmt`           | Format everything in place                                                    |
| `mise run lint`          | clippy, `vp lint`, svelte-check, actionlint, zizmor, pinact, typos, file size |
| `mise run typecheck`     | TypeScript across the workspace                                               |
| `mise run test`          | Rust, doc, Worker, script, action and MCP suites                              |
| `mise run openapi`       | Regenerate `docs/openapi.json` from the Hono router                           |
| `mise run openapi:check` | Fail if `docs/openapi.json` is stale                                          |
| `mise run miri`          | The purity proof for `prick-core`                                             |
| `mise run e2e`           | Playwright                                                                    |
| `mise run build`         | CLI and Worker bundle                                                         |
| `mise run docs:dev`      | The documentation site, with hot reload                                       |
| `mise run deny`          | Licences, bans, advisories, the git-source ban                                |
| `mise run ci`            | **Exact mirror of CI.** Run before opening a pull request                     |

`depends` fans out in parallel, and `sources`/`outputs` give content-hash
skipping, so a repeat run is cheap.

## Who owns what

| Owns         | Scope                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------- |
| mise         | Rust, Node, pnpm, the Rust dev tools, and Vite+ itself. The only thing a contributor installs |
| Vite+ (`vp`) | The JS-side workflow for `packages/**` only                                                   |
| pnpm         | Package management. `vp` wraps whatever the lockfile indicates                                |

`vp env` is never used. mise pins Node, and two version managers fighting over it
is the exact failure mode mise was chosen to prevent.

Because Vite+ is built on Oxc, `vp lint` and `vp fmt` replace standalone linters
and formatters on the JS side. Keeping both would mean two configs that can
silently disagree.

## Rules enforced by tooling

Breaking any of these fails the build, not review.

### Nothing writes to stdout or stderr outside `crates/prk/src/output/`

`clippy::print_stdout` and `clippy::print_stderr` are denied workspace-wide, and
exactly one module lifts the ban. This turns "a secret leaked into a log line"
from something a reviewer might catch into something the compiler rejects.

If you need to print, add a helper to `output`. Do not widen the allow.

### No references to prior art

This project stands on its own. CI greps the tree and fails on any hit.

### `prick-core` is pure

No I/O, no async, no `unsafe`, no FFI. `cargo miri test -p prick-core` is a
machine-checked proof of that: it cannot pass if you add a file read, a clock
call, or a dependency with a C shim. Impure code belongs in `prick-api`,
`prick-auth` or `prick-exec`.

### Deployment guard

`workers_dev` and `preview_urls` must be explicitly `false` in the wrangler
config. The `guard` job in `.github/workflows/deploy.yml` greps for both and
blocks the preview and production jobs otherwise. It needs no secrets.

:::caution[It only runs on a deploy]
`deploy.yml` is `workflow_dispatch` only, and `ci.yml` does not run the guard
independently today. So the assertion fires when somebody deploys, not on every
push. Do not rely on a green pull request to tell you those two settings are still
`false`.
:::

## Rules you have to hold yourself

These are not mechanically checked.

1. **Never log, print or embed a secret value.** Error messages name the _key_,
   never the value.
2. **Never return a secret value from a SvelteKit `+*.server.ts` load or form
   action.** SvelteKit serialises those into the page payload. Values reach the
   browser only via a client-side fetch from the `ssr = false` subtree.
3. **Never widen an AAD.** Ciphertexts are bound to
   `(purpose, environment_id, key, version)`. If a mutation changes any of those,
   decrypt and re-encrypt. Never copy a ciphertext blob between rows.
4. **Never write a mutation without an audit row in the same `batch()`.**
5. **Never split a bulk write across multiple `batch()` calls.** That destroys
   atomicity. If it does not fit, reject it with `413`.
6. **Never swallow a decrypt failure.**

## Where things live

| Concern                                   | Path                                       |
| ----------------------------------------- | ------------------------------------------ |
| Pure logic: parsing, formatting, escaping | `crates/prick-core/`                       |
| HTTP client, error classification         | `crates/prick-api/`                        |
| Access OAuth, token storage               | `crates/prick-auth/`                       |
| Process spawn, signals                    | `crates/prick-exec/`                       |
| CLI commands and rendering                | `crates/prk/`                              |
| Domain logic, transport-agnostic          | `packages/app/src/lib/server/core/`        |
| Crypto: envelope, AAD, keyring            | `packages/app/src/lib/server/crypto/`      |
| Access JWT verification                   | `packages/app/src/lib/server/auth/`        |
| Drizzle schema                            | `packages/app/src/lib/server/db/schema.ts` |
| UI routes                                 | `packages/app/src/routes/`                 |

## Database migrations

Edit the Drizzle schema, then generate. Never hand-edit generated SQL.

```bash
pnpm --dir packages/app run db:generate
```

**Migrations are additive only.** They are applied _before_ the new code deploys,
so a release must tolerate the previous version's code running against the new
schema. A destructive change takes three releases: add nullable and backfill,
then require, then drop.

One gotcha that will bite on the first column change: drizzle-kit emits
`PRAGMA foreign_keys=OFF` around table rebuilds, and D1 rejects a pragma change
mid-transaction. Rewrite it to `defer_foreign_keys`. Read every generated
migration before committing it.

## Line endings

`.gitattributes` sets `* text=auto eol=lf`. The `eol` attribute overrides
`core.autocrlf`, so a Windows contributor on the Git-for-Windows default still
gets LF on disk. That cannot be got wrong per machine, which is why it is done
here rather than by asking people to set a git config.

It is load-bearing for this repository specifically: snapshot tests and embedded
fixtures compare byte for byte, so a CRLF checkout passes on Windows and fails on
Linux CI, and crypto test vectors with an injected CR silently change plaintext
length and produce baffling AEAD failures.

`.bat` and `.cmd` stay CRLF, because `cmd.exe`'s parser genuinely misbehaves on
LF.

## Adding a dependency

- **Rust:** `cargo deny check` must pass. No git dependencies —
  `allow-git = []` with `unknown-git = "deny"` makes it structurally impossible
  for one to reach a release binary. rustls, never OpenSSL; both `openssl` and
  `native-tls` are banned outright.
- **JS:** a 3-day minimum release age applies. Essentially every npm compromise
  of the last two years was caught inside 72 hours. Anything wanting an install
  script needs an explicit allowlist entry.

## Commits and pull requests

Conventional Commits. We squash-merge, so **the pull request title becomes the
commit message** and is linted. One logical change per pull request.

Hooks run via lefthook. `LEFTHOOK=0 git push` skips them; CI will still fail, so
that only buys a faster local loop.

## Versioning

You never touch a version number. Every manifest reads `0.0.0-dev`; the git tag
is the source of truth and CI stamps it at build time. See
[Releasing](/contributing/releasing).

## Security

Do not open a public issue for a vulnerability. Use a private advisory — see
`.github/SECURITY.md`.

## Next

- [Testing](/contributing/testing)
- [Releasing](/contributing/releasing)
