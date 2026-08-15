# Contributing

## TL;DR

```bash
winget install jdx.mise          # or: brew install mise / curl https://mise.run | sh
git clone https://github.com/yashau/prick && cd prick
mise trust
mise run bootstrap
mise run dev
```

## 1. Prerequisites

**Install mise and nothing else.** `mise.toml` pins exact versions of Rust, Node, pnpm and every dev
tool; a system-wide install of any of them will shadow the pinned one and you will debug a problem
nobody else has.

`mise trust` is required once per clone before `mise.toml`'s environment is applied.

**On Windows:** run `git config --global core.longpaths true`. A multi-crate Rust workspace under a
deep path routinely produces artefact paths over 260 characters.

No Cloudflare account is needed for local development — the Worker runs against miniflare.

## 2. Repository shape

```
crates/     Rust workspace. Binary is `prk`.
packages/   pnpm workspace. Worker + SvelteKit UI.
scripts/    Node ESM helpers (not bash — they must run on Windows).
```

The two workspaces never overlap: Cargo members are `crates/*`, pnpm packages are `packages/*`.

## 3. Everyday commands

`mise tasks` lists everything. The ones you will use:

| Task | Does |
|---|---|
| `mise run dev` | Worker + UI dev server |
| `mise run test` | Rust + Worker tests |
| `mise run lint` | clippy, oxlint, svelte-check, actionlint, typos |
| `mise run fmt` | format everything in place |
| `mise run e2e` | Playwright |
| `mise run ci` | **exact mirror of CI** — run before opening a PR |

## 4. Code style

Not debated: rustfmt, `clippy -D warnings`, prettier, oxlint. Hooks run automatically via lefthook.
`LEFTHOOK=0 git push` skips them; CI will still fail, so this only buys you a faster local loop.

### Two rules that are enforced by tooling, not review

**Nothing writes to stdout/stderr outside `crates/prk/src/output/`.** `print_stdout` and
`print_stderr` are denied workspace-wide. This is deliberate: it turns "a secret leaked into a log
line" from something a reviewer might catch into something the compiler rejects. If you need to
print, add a helper to `output`, don't widen the allow.

**No references to prior art.** This project stands on its own. CI greps the tree and fails the
build on any hit.

## 5. Testing

- **Rust** — `cargo-nextest`. Pure logic lives in `prick-core`.
- **miri** — runs against `prick-core` only. It cannot execute network calls, `Command`/`exec`, or
  FFI, so most of the CLI is out of reach. Its job here is *enforcement, not discovery*: a green miri
  run is a machine-checked proof that `prick-core` is genuinely pure — it cannot pass if someone adds
  a file read, a clock call, or an FFI dependency. Keep it that way.
- **Worker** — vitest with `@cloudflare/vitest-pool-workers`, against real D1 in miniflare, offline.
- **E2E** — Playwright against a locally built Worker.

If you add `unsafe`, it belongs in `prick-exec`, it needs a `// SAFETY:` comment, and it needs
integration tests — miri cannot check it.

## 6. Database migrations

Edit the Drizzle schema, then generate. Never hand-edit generated SQL.

**Migrations must be additive.** Deploy applies migrations *before* the new code ships, so a release
must tolerate the previous version's code running against the new schema. Destructive changes take
three releases: add nullable and backfill, then make it required, then drop the old column.

One gotcha: drizzle-kit emits `PRAGMA foreign_keys=OFF` for SQLite column changes. D1 rejects
mid-transaction pragma changes — rewrite it to `defer_foreign_keys`. Read every generated migration
before committing it.

## 7. Commits and PRs

Conventional Commits. We squash-merge, so **the PR title becomes the commit message** and is linted.
One logical change per PR.

## 8. Versioning

You never touch a version number. Every manifest reads `0.0.0-dev`; the git tag is the source of
truth and CI stamps it at build time. Versions are CalVer.

## 9. Adding a dependency

- **Rust:** `cargo deny check` must pass. No git dependencies. rustls, never OpenSSL.
- **JS:** a 3-day minimum release age applies. Anything wanting an install script needs an explicit
  allowlist entry.

## 10. Security

Do not open a public issue for a vulnerability — use a private advisory. See `.github/SECURITY.md`.
