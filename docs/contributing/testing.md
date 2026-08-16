---
title: Testing
description: The four test suites, what miri can honestly prove, and how Access is exercised for real rather than mocked.
sidebar:
  order: 2
---

```bash
mise run test
```

That fans out to six suites. Playwright and miri are separate.

| Suite          | Runner                                        | Task                    |
| -------------- | --------------------------------------------- | ----------------------- |
| Rust           | `cargo nextest`                               | `mise run test:rust`    |
| Rust doc tests | `cargo test --doc`                            | `mise run test:doc`     |
| Worker         | Vitest with `@cloudflare/vitest-pool-workers` | `mise run test:js`      |
| Repo scripts   | `node --test`                                 | `mise run test:scripts` |
| GitHub Action  | `node --test`                                 | `mise run test:action`  |
| MCP server     | `node --test`                                 | `mise run test:mcp`     |
| End-to-end     | Playwright                                    | `mise run e2e`          |
| Purity proof   | `cargo miri nextest`                          | `mise run miri`         |

Doc tests get their own pass because nextest cannot run them. The action and the
MCP server run under plain Node rather than workerd, so they use `node:test`
rather than the Worker pool.

## The OpenAPI document cannot go stale

```bash
mise run openapi        # regenerate docs/openapi.json from the router
mise run openapi:check  # fail if it is stale
```

`openapi:check` runs in CI, and `packages/app/test/http/openapi.test.ts`
deep-compares the committed document against what the router actually serves. The
task exists separately so a stale document fails with one obvious message rather
than inside a suite.

## The Worker suite

Vitest runs the **real Hono app against a real D1** inside miniflare, offline.

`main` points at a Hono-only test entry
(`packages/app/src/lib/server/http/test-entry.ts`) rather than at the built
SvelteKit Worker, so the server suite never needs a UI build. The crypto and
write-path tests are the ones that must stay fast and always green; making them
wait on a UI build is how a suite stops being run.

:::note[API shape moved]
As of `@cloudflare/vitest-pool-workers` 0.21 the
`@cloudflare/vitest-pool-workers/config` subpath and `defineWorkersConfig()` no
longer exist. The pool is a Vite **plugin** now — `cloudflareTest(options)`,
taking what used to be `test.poolOptions.workers`. Every tutorial online still
shows the old shape. The package ships a codemod that performs the rewrite.
:::

### Access is exercised, not mocked

JWT verification is exactly where a security bug would live, so it is the last
thing that should be replaced with a stub.

The seam is `ACCESS_CERTS_URL` — a legitimate piece of Worker configuration, not
a code path. The harness generates a **real RS256 keypair** in setup and serves
it as JWKS, so the tests drive the real verifier end to end.

The harness is built on miniflare's `outboundService`, which runs in the Vitest
host process, rather than on a request-level fetch mock: the pinned pool does not
expose one. Key material and fetch counters therefore cross into workerd as JSON.

A **sentinel test** greps the entire shipped source tree for the harness origin,
imports from the test tree, `cloudflare:test`, `NODE_ENV` branches and
`import.meta.vitest` blocks. Nothing under `src/` may reference any of them, so
the test seam provably never ships. It runs over the whole tree rather than a
list somebody has to remember to extend.

### Negative cases the JWT suite must keep covering

Wrong audience, wrong issuer, expired, unknown key id, `alg: none`, RS256→HS256
confusion — and **`nbf` absent**, because service tokens do not carry one and a
verifier that requires it rejects every machine client.

## The crypto tamper suite

The specification for the encryption layer's behaviour is
`packages/app/test/crypto/`. Encrypt a value in environment A at version 3, then
assert that decryption **throws** for every one of:

- The same blob presented with `environment_id = B` — the cross-environment
  transplant.
- The key name changed.
- The version presented as 2 or as 4 — rollback and roll-forward replay.
- A flipped bit in the ciphertext, the tag, or the IV.
- A truncated envelope.
- An unknown format byte.
- An unknown key id.

Plus the length-prefix injectivity property: `{key: "AB", env: "C"}` and
`{key: "A", env: "BC"}` must produce different additional data. A separator
scheme fails exactly that, which is why the encoding is length-prefixed. See
[Encryption](/architecture/encryption).

## What miri can honestly do

`mise run miri` runs against **`prick-core` only**. It cannot touch the network,
`Command`/`exec`, or FFI — so the `unsafe` in `prick-exec`, where miri would be
most valuable, is exactly what it cannot reach. That is a reason to keep that
surface small, not a reason to claim coverage.

Since `prick-core` is `#![forbid(unsafe_code)]`, miri will find approximately
nothing there. Its value is **enforcement, not discovery**: a green run is a
machine-checked proof that the crate is genuinely pure, because it cannot pass if
someone adds a file read, a clock call or an FFI dependency.

The nightly toolchain it uses is date-pinned. A rolling nightly makes the job
flaky on unrelated pull requests.

## The write-path suite

`packages/app/test/core/secrets-atomicity.test.ts` is the specification for the
properties the write path exists to have. These all exist and must keep passing:

- **The partial-write regression test.** Seed 5 secrets, issue a full replace whose
  third row fails, and assert the environment still holds exactly the original 5 at
  the original revision, **with no audit row** — and that the original values still
  reveal afterwards. This is the test that proves the batch is a real transaction.
- **One `batch()`, whatever the size.** Exactly one `batch()` for a 40-key write
  despite chunking, and still one at 250 keys where chunking produces about 45
  statements. Asserted by counting through a binding proxy, not by inspection.
- **Both branches of the optimistic guard.** A matching `expected_rev` applies and
  the guard is a no-op rather than an insert; a stale one aborts with
  `PRECONDITION_FAILED` and changes nothing.
- **Per-key version races.** Retry once and win, leaving **no gap** in the version
  history; give up with `VERSION_CONFLICT` after losing twice, having written
  nothing.
- **The size cap**, counted against the **resulting** environment rather than the
  request, refusing rather than splitting the batch.

`packages/app/test/http/permissions.test.ts` drives the permission matrix per
operation per actor, and adds the cases that are easy to get wrong: a disabled
identity outranking a global admin grant, a role held **only** through a group,
a group holding no grants conferring nothing, an expired group grant lapsing
exactly like a direct one, and a service token going through the identical code
path.

`packages/app/test/core/keyring.test.ts` is **rekey correctness**, and the three
clauses are asserted together in one test because each alone is worthless:

- **A genuine two-key ring.** The rows are seeded under a separate single-key ring
  so they really predate the rotation, and the test asserts the active kid
  actually changed and the old one is now the retired one. Rotating a key in
  place would pass a weaker version of this.
- **Every value still decrypts.** The environment carries history and a tombstone
  — A@1, B@1, B@2, C@1 and a deleted C@2 — and every value row is decrypted
  individually against an expected `key|version → plaintext` map, with the value
  and tombstone counts both asserted so a silently skipped row cannot hide.
- **No version changed.** `(id, environmentId, key, version, op)` is captured for
  every row before and compared as a whole array after, so an appended, dropped
  or renumbered row fails too.

The suite also pins the properties the design turns on: `safeToRemoveOldKey` goes
false while a single row still references a retired kid, a rekey is one `batch()`
and a second run is a no-op, and a row that will not decrypt fails the page
rather than being skipped. That last one is the load-bearing case — a skipped row
still counts as gone, so the ring would report itself safe to prune while an
unreadable value remained.

## CLI tests

Each crate carries its own integration tests under `crates/*/tests/`:

| Crate        | Covers                                                            |
| ------------ | ----------------------------------------------------------------- |
| `prick-api`  | `ops.rs`, `responses.rs` — the error matrix and header behaviour  |
| `prick-auth` | `login.rs` — the OAuth handshake                                  |
| `prick-exec` | `launch.rs`, `unix_exec.rs`, `windows_batch.rs` — the launch path |

Unit tests live beside the code in `crates/prk/src/`, including the assertions
that a client secret never survives `Debug` formatting and that `--help` cannot
print an environment variable's value.

What the CLI suite must keep covering as it grows: the exit-code table; stderr
**byte-empty** on a `--json` success and stdout byte-empty on a `--json` failure;
no secret value on any error path; the output-format round-trips, with `shell`
output verified by actually evaluating it under `dash`, `bash`, `zsh` and
`busybox sh`; and `prk run` integration — argv preserved exactly, non-UTF-8 argv,
`SIGTERM` → 143, `SIGINT` → 130, `prk run -- yes | head -1` terminating, and
`npm.cmd --version` on Windows.

That `yes | head -1` case is not decoration. Rust sets `SIGPIPE` to `SIG_IGN` at
startup, and without resetting it to `SIG_DFL` before `exec` the pipeline hangs
forever.

## End-to-end

Playwright against a locally built Worker, with its own Access harness under
`e2e/harness/`. The specs:

| Spec                    | Asserts                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `secrets-table.spec.ts` | A value is absent from the DOM until Reveal completes; auto-mask     |
| `ssr-boundary.spec.ts`  | No value appears in a server-rendered page payload                   |
| `import-export.spec.ts` | The `.env` dry-run diff, and an export that round-trips              |
| `access.spec.ts`        | Grants and revocation from the UI                                    |
| `groups.spec.ts`        | A role reaching an identity through a group, and removal revoking it |
| `rbac-ui.spec.ts`       | The same, rendered: the screen names the decisive group              |
| `journey.spec.ts`       | The whole flow in one serial run, in a project of its own            |
| `api-flow.spec.ts`      | The API path the client-rendered subtree uses                        |
| `headers.spec.ts`       | `frame-ancestors 'none'` and `Cache-Control: no-store` where needed  |
| `keyboard.spec.ts`      | A keyboard-only walkthrough                                          |
| `accessibility.spec.ts` | An accessibility scan                                                |

### The browsers

`mise run e2e:install` downloads the browser binaries. It does **not** install
system libraries, and CI does not either: the ubuntu-24.04 runner image ships
Chrome, Chromium, Edge and Firefox as packages, so the shared libraries Chromium
links against are already present, and running `apt-get update` there once stalled
the job for twenty-four minutes against an unreachable mirror.

On a bare Linux box those libraries genuinely are missing. Run
`mise run e2e:install:deps` once — it needs root, which is the other reason it is
not folded into `e2e:install`. If you skip it and need it, Playwright refuses to
launch and names the packages.

## Before you open a pull request

```bash
mise run ci
```

It mirrors CI exactly. `ci-ok` is the only required status check in the
repository: with a paths filter, a skipped job reports "skipped", and a
_required_ check that is skipped blocks the pull request forever. `ci-ok` runs
with `if: always()` and treats skipped as pass.

## Next steps

- [Releasing](/contributing/releasing)
- [Development](/contributing/development)
