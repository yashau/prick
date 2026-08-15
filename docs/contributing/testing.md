---
title: Testing
description: The four test suites, what miri can honestly prove, and how Access is exercised for real rather than mocked.
sidebar:
  order: 2
---

```bash
mise run test
```

That runs four suites: Rust unit and integration tests, Rust doc tests, the
Worker suite, and the `scripts/*.mjs` suite. Playwright is separate.

| Suite          | Runner                                        | Task                    |
| -------------- | --------------------------------------------- | ----------------------- |
| Rust           | `cargo nextest`                               | `mise run test:rust`    |
| Rust doc tests | `cargo test --doc`                            | `mise run test:doc`     |
| Worker         | Vitest with `@cloudflare/vitest-pool-workers` | `mise run test:js`      |
| Repo scripts   | `node --test`                                 | `mise run test:scripts` |
| End-to-end     | Playwright                                    | `mise run e2e`          |
| Purity proof   | `cargo miri nextest`                          | `mise run miri`         |

Doc tests get their own pass because nextest cannot run them.

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

## Writing tests for the write path

Write these **first**, before the code:

- **The partial-write regression test.** Seed 5 secrets, issue a full replace
  whose third row fails, and assert the environment still holds exactly the
  original 5 at the original revision, with no audit row. This is the test that
  proves the batch is a real transaction.
- **The version race.** Two concurrent writers on one key: one `200`, one `409`,
  and no gap in the version history.
- **The `expected_rev` abort.** A mismatch is `412` and the environment is
  byte-for-byte unchanged.
- **Every cell of the permission matrix**, plus expired grants, disabled
  identities and `NO_ADMINS_CONFIGURED`.
- **Rekey correctness.** A two-key ring, every value still decrypts, and no
  version changed.

## CLI tests

- `assert_cmd` for the exit-code table.
- Assert stderr is **byte-empty** on a `--json` success, and stdout byte-empty on
  a `--json` failure.
- Assert no secret value appears in stderr on any error path.
- `trycmd` snapshots for `--help`.
- `wiremock` for the error matrix and the OAuth handshake.
- Property tests for the output format round-trips, with `shell` output verified
  by actually evaluating it under `dash`, `bash`, `zsh` and `busybox sh`.
- `prk run` integration: exit codes, argv preserved exactly, non-UTF-8 argv,
  `SIGTERM` → 143, `SIGINT` → 130, `prk run -- yes | head -1` terminates, and
  `npm.cmd --version` on Windows.

That `yes | head -1` case is not decoration. Rust sets `SIGPIPE` to `SIG_IGN` at
startup, and without resetting it to `SIG_DFL` before `exec` the pipeline hangs
forever.

## End-to-end

Playwright against a locally built Worker. The security-relevant assertions:

- A secret's value is **absent from the DOM** until Reveal is clicked and a
  request completes.
- Auto-mask fires.
- The `.env` import dry-run diff, and an export that round-trips.
- The audit log contains `secret.reveal` and `secret.import` with the right
  actor.
- Revoke a grant, reload, get a `403`.
- `frame-ancestors 'none'` and `Cache-Control: no-store` are present on the
  responses that need them.
- A keyboard-only walkthrough, and an accessibility scan in both themes.

## Before you open a pull request

```bash
mise run ci
```

It mirrors CI exactly. `ci-ok` is the only required status check in the
repository: with a paths filter, a skipped job reports "skipped", and a
_required_ check that is skipped blocks the pull request forever. `ci-ok` runs
with `if: always()` and treats skipped as pass.

## Next

- [Releasing](/contributing/releasing)
- [Development](/contributing/development)
