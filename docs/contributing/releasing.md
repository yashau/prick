---
title: Releasing
description: CalVer, how the version is stamped, and what the release workflow does in what order.
sidebar:
  order: 3
---

:::caution[No release has been cut]
Nothing is published to npm yet, and the one-time trusted-publishing bootstrap
described below has not been done. Treat this page as the procedure, not as a
history.
:::

## Versioning

`YYYY.MMDD.N` — for example `2026.815.0`.

| Part | Rule |
|---|---|
| `YYYY` | Year, UTC |
| `MMDD` | Month and day with **no leading zeros**. 5 January is `105`, 1 October is `1001` |
| `N` | Zero-based count of tags already taken today |

It is valid semver, and it is strictly monotonic within a year:
`105 < 930 < 1001 < 1231`.

`N` is computed as the number of tags matching today, with no `+1`, so it is
self-describing: `.0` is the first release of the day.

**UTC is mandatory.** A maintainer in UTC+5 computing a version locally after
19:00 would be a day ahead of CI. `mise.toml` sets `TZ = "UTC"` for every task.

### The version lives in the tag, not in the tree

Every manifest in the repository reads `0.0.0-dev` — `Cargo.toml`, all nine
`package.json` files, `svelte.config.js`, the `/health` response. The **git tag
is the source of truth**, and `scripts/version.mjs set` stamps it into every
manifest immediately before compiling, so `env!("CARGO_PKG_VERSION")` is correct
by construction and there is no second representation to drift.

The documented trade-off: `git checkout v2026.815.0 && cargo build` reports
`0.0.0-dev` unless you stamp first. Committing the bump instead would buy
checkout reproducibility at the cost of a bot commit racing merges into a
protected branch. For CalVer, where the version carries no information, stamping
is the better trade.

**The tag is also the lock.** The `plan` job pushes the tag to claim `N`, and git
refuses a duplicate, so two racing runs cannot both take it. There is no external
mutex.

```bash
mise run version:plan
```

```bash
mise run version:check
```

`version:check` asserts every manifest carries the same version.

## Cutting a release

Releases are cut through mise tasks, which dispatch the release workflow with
`gh`. They must **not** create the tag locally: the workflow's `plan` job pushes
it, and a hand-made tag would collide with the lock it depends on.

| Task | Does |
|---|---|
| `mise run release:preview` | Print the version and tag the next release would take. Read-only, never prompts, works at zero tags |
| `mise run release:dry` | Dispatch with `dry_run=true` — builds all eight binaries and stages the nine npm packages, publishes nothing |
| `mise run release:cut` | Tag, build, publish, create the GitHub Release |
| `mise run release:status` | Follow the latest run. Read-only |

```bash
mise run release:preview
```

```bash
mise run release:dry
```

```bash
mise run release:cut
```

`release:cut` requires a typed confirmation — `--yes` for non-interactive use —
and prints the resolved version and all nine package names before prompting.

:::danger[It is not undoable]
npm versions are immutable. Recovery is limited to rolling the `latest` dist-tag
back and deprecating. The fix for a bad release is to roll **forward**:
`2026.815.1`. **Never** delete and re-push a tag.
:::

## What the workflow does

```
plan → build (6 runner legs → 8 artefacts) → package → publish-npm → github-release
```

### plan

Computes the version and pushes the tag, which claims it.

### build

Six runner legs produce eight artefacts; macOS and Windows each build two targets
in one job.

| Target family | Targets |
|---|---|
| Linux | x64-gnu, x64-musl, arm64-gnu, arm64-musl |
| macOS | arm64, x64 |
| Windows | x64-msvc, arm64-msvc |

The matrix is hand-rolled, with no `cross`: free arm64 runners exist now, and
native builds remove Docker, qemu and image pinning. `+crt-static` on
windows-msvc removes the Visual C++ redistributable dependency.

Binaries are built with `cargo auditable`, which embeds the dependency list
**inside** the binary.

### package

Assembles the archives, checksums and the nine npm packages, generates SBOMs, and
attests the artefacts.

The embedded audit data is verified here as a **hard failure gate**:

```bash
mise run audit:bin ./prk
```

`cargo audit bin` works on a downloaded artefact with no side-car SBOM, which for
a security tool is what lets anyone audit what they actually received rather than
what a manifest elsewhere claims. A silently empty audit section is worse than
none, because it reads as a clean report — so the check must run against the
**stripped** output, and if stripping removes the section, loosen `strip` rather
than ship a binary whose audit data is gone.

### publish-npm

npm versions are immutable; dist-tags are not. That asymmetry is the whole
strategy.

1. Everything publishes under `--tag next`.
2. Registry propagation is verified.
3. A real `npm install` and `prk --version` smoke test runs.
4. Only then does `latest` move — **parent last**.

A failure before the flip leaves `latest` on the previous good release. Publishes
are idempotent (an `npm view` check comes first), so re-running the same tag
resumes rather than starting over.

Use `npm publish`, not `pnpm publish`: pnpm 11 removed its npm CLI fallback and
its OIDC path regressed, so npm is the vendor-supported path.

### github-release

Creates a draft release with the archives, checksums and SBOMs, then undrafts it.

## Why not a single npm package with a postinstall

`cargo-dist`'s npm installer produces one package that downloads from GitHub
Releases in a `postinstall`. That is disqualifying for a secrets manager:

- It breaks under `--ignore-scripts`, which is exactly what a security-conscious
  user runs.
- It needs egress to `githubusercontent` at install time.
- The downloaded bytes are not covered by npm provenance.
- A corporate registry mirror cannot cache it.

The published launcher has **no `scripts` field at all**. The real binary arrives
as an ordinary `optionalDependencies` entry that the package manager resolves
from platform fields, so every byte is covered by the lockfile's integrity hash
and by provenance.

`detect-libc` is called by the launcher itself rather than relying on npm's
`libc` manifest field: pnpm honours that field, npm's support is partial, and on
npm a glibc host can end up with the musl package installed. Doing the detection
ourselves means the diagnosis is ours to make.

## One-time npm bootstrap

Trusted publishing (OIDC) cannot be configured for a package that has never been
published, and there are nine of them.

1. Publish once with a 1-day granular token.
2. Configure the trusted publisher for all nine packages.
3. Revoke the token.

After that no token exists to leak, and provenance is automatic — drop
`--provenance`.

## Deploying the Worker

Deployment is a separate workflow from the release, and it is not tied to a
version.

| Event | What happens |
|---|---|
| Push to `main` | Guard, migrations, production deploy |
| Pull request from the same repository | Guard, migrations, `versions upload` with a preview alias |
| Pull request from a fork | Guard only |

The **guard** job runs for every event, needs no secrets, and blocks both deploy
jobs. It asserts that `workers_dev` and `preview_urls` are explicitly `false` in
the wrangler config. A hostname Access is not attached to is a complete bypass of
the authentication model, so it is checked mechanically before anything reaches
Cloudflare.

Migrations run **before** the deploy in both jobs, which is what makes "old code,
new schema" the only state that exists in the window between the two steps. That
is also why the migration policy is expand/contract only.

Production deploys serialise and are never cancelled: interrupting one between
`d1 migrations apply` and `deploy` leaves the schema ahead of the code. Preview
deploys may supersede each other freely.

Toolchain caching is disabled entirely in the deploy workflow, in **both**
directions. Disabling only the save would still let a lower-privilege workflow
write a poisoned entry that this privileged job restores and publishes. A cold
install costs about 30 seconds; deploys are not a hot path.

## Next

- [Development](/contributing/development)
- [Testing](/contributing/testing)
