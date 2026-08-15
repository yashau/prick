---
title: Releasing
description: CalVer, how the version is stamped, and what the release workflows do in what order.
sidebar:
  order: 3
---

:::caution[No release has been cut]
Nothing is published to npm yet, and the one-time trusted-publishing bootstrap
described below has not been done. Treat this page as the procedure, not as a
history.
:::

## Two release lines, one mechanism

There are two things to release, and they work identically:

| Line          | Tasks    | Tag prefix | Workflow           | Ships                              |
| ------------- | -------- | ---------- | ------------------ | ---------------------------------- |
| The `prk` CLI | `cli:*`  | `v`        | `cli-release.yml`  | Eight binaries, ten npm packages   |
| The docs site | `docs:*` | `docs-v`   | `docs-release.yml` | The `prick-docs` Cloudflare Worker |

**Cutting the version is what releases it.** `cli:cut` and `docs:cut` compute the
next version, take a typed confirmation, then create an annotated tag and push
it. That push is the workflow trigger. Neither workflow computes a version, and
neither runs on a push to `main`.

The two prefixes count `N` independently, so cutting docs three times in a day
does not make the next CLI release `.3`. `v*` and `docs-v*` cannot cross: a tag
glob is anchored at the start of the ref name, and `docs-v2026.815.0` does not
begin with `v`. That is asserted in `scripts/version.test.mjs` rather than
assumed.

The ten npm packages are the eight per-platform binaries, the `@yashau/prick`
launcher, and the MCP server — all at the same version, all cut by the same tag.

:::note[`release:*` was renamed to `cli:*`]
"Release" stopped having an unambiguous subject once the documentation site had a
release line of its own. `mise tasks` lists the current names.
:::

## Versioning

`YYYY.MMDD.N` — for example `2026.815.0`.

| Part   | Rule                                                                             |
| ------ | -------------------------------------------------------------------------------- |
| `YYYY` | Year, UTC                                                                        |
| `MMDD` | Month and day with **no leading zeros**. 5 January is `105`, 1 October is `1001` |
| `N`    | Zero-based count of tags already taken today                                     |

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

**The tag is also the lock.** `*:cut` pushes the tag to claim `N`, and git refuses
a duplicate, so two people cutting in the same second cannot both take it. The
loser's push is rejected, and `scripts/version.mjs` recomputes `N` against the
tags that then exist rather than merely incrementing — the winner may have taken
more than one. There is no external mutex.

```bash
mise run version:plan
```

```bash
mise run version:check
```

`version:check` asserts every manifest carries the same version.

## Cutting a CLI release

| Task                  | Does                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `mise run cli:next`   | Print the version and tag the next release would take. Read-only, never prompts, works at zero tags         |
| `mise run cli:dry`    | Dispatch with `dry_run=true` — builds all eight binaries and stages the ten npm packages, publishes nothing |
| `mise run cli:cut`    | Tag and push, which builds, publishes to npm and creates the GitHub Release                                 |
| `mise run cli:status` | Follow the latest run. Read-only                                                                            |

```bash
mise run cli:next
```

```bash
mise run cli:dry
```

```bash
mise run cli:cut
```

`cli:cut` requires a typed confirmation of the **tag** — not "yes", so it cannot
be typed from muscle memory, and typing it means you read the version. Pass
`--yes` for non-interactive use. It prints the resolved version and all ten
package names before prompting.

The tag it pushes is the trigger. Nothing else starts a release: `cli-release.yml`
has no branch trigger, and its `workflow_dispatch` can only ever dry-run.

:::danger[It is not undoable]
npm versions are immutable. Recovery is limited to rolling the `latest` dist-tag
back and deprecating. The fix for a bad release is to roll **forward**:
`2026.815.1`. **Never** delete and re-push a tag.
:::

## Cutting a docs release

| Task                   | Does                                                                          |
| ---------------------- | ----------------------------------------------------------------------------- |
| `mise run docs:next`   | Print the version and tag the next docs release would take. Read-only         |
| `mise run docs:cut`    | Tag and push, which builds, deploys the Worker and creates the GitHub Release |
| `mise run docs:status` | Follow the latest run. Read-only                                              |

```bash
mise run docs:cut
```

Identical to `cli:cut`, on the `docs-v` prefix, with the same typed-tag
confirmation. The site therefore ships in exactly one way, every shipped state
has a version, and `git show docs-v2026.815.0` says who shipped it and when.

`docs-release.yml` does **not** run on a push to `main` or on a docs edit. Editing
Markdown changes nothing that is live until somebody cuts.

The deploy itself is reversible — fix the source and cut the next `N`. The tag is
not.

`docs:preview` is unrelated: it serves the built site locally, which is what
`preview` means in every JS toolchain. The version preview is `docs:next`.

## Local docs tasks

| Task                    | Does                                     |
| ----------------------- | ---------------------------------------- |
| `mise run docs:dev`     | Astro dev server with hot reload         |
| `mise run docs:build`   | Build the site from the `docs/` Markdown |
| `mise run docs:preview` | Serve the built output locally           |

## What cli-release.yml does

```
version → build (6 runner legs → 8 artefacts) → package → publish-npm → github-release
```

### version

Resolves the version. On a tag push it is the tag minus its `v`, validated
against the CalVer shape; on a dispatched dry run it is a read-only prediction
that claims nothing.

This job holds **no** write permission and persists no git credential. Nothing in
CI can move a ref — the claim already happened, locally, in `cli:cut`.

`publish-npm` and `github-release` are gated on the trigger being a tag push, so
a dispatched run cannot publish however its inputs are set.

### build

Six runner legs produce eight artefacts; macOS and Windows each build two targets
in one job.

| Target family | Targets                                  |
| ------------- | ---------------------------------------- |
| Linux         | x64-gnu, x64-musl, arm64-gnu, arm64-musl |
| macOS         | arm64, x64                               |
| Windows       | x64-msvc, arm64-msvc                     |

The matrix is hand-rolled, with no `cross`: free arm64 runners exist now, and
native builds remove Docker, qemu and image pinning. `+crt-static` on
windows-msvc removes the Visual C++ redistributable dependency.

Binaries are built with `cargo auditable`, which embeds the dependency list
**inside** the binary.

### package

Assembles the archives, checksums and the ten npm packages, generates SBOMs, and
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

Creates a draft release with the archives, checksums and SBOMs, then undrafts it
and marks it `--latest`.

The notes range is pinned to the previous `v*` tag rather than left to GitHub's
own "previous release" guess. Two release lines share this repository's releases,
and the guess is as likely to land on a docs release — which would generate a
changelog of Rust commits on a documentation release, or vice versa.

## What docs-release.yml does

```
deploy (build → verify → wrangler deploy) → release (GitHub Release for the tag)
```

Two jobs so that `contents: write` is scoped to the two `gh release` calls and is
nowhere near the Cloudflare credentials. The release runs **after** the deploy: a
release announcing a site that failed to publish would be a lie, and the tag alone
is enough to retry from.

The build output is verified before `wrangler deploy` runs. `wrangler deploy` on
an empty assets directory succeeds and replaces a working site with a blank one,
so an empty build has to fail here rather than be discovered by a reader.

Docs releases are created with `--latest=false`. They are not pre-releases —
nothing later supersedes them — but the repository's "Latest" badge belongs to the
newest `v*` release, which is what people come here to download.

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
published, and there are ten of them.

1. Publish once with a 1-day granular token.
2. Configure the trusted publisher for all ten packages.
3. Revoke the token.

After that no token exists to leak, and provenance is automatic — drop
`--provenance`.

## Deploying the Worker

`deploy.yml` is a separate workflow from the release, is not tied to a version,
and is **manual only**.

```yaml
on:
  workflow_dispatch:
    inputs:
      environment: # production | preview, default preview
```

There is no push trigger and no pull-request trigger. That is deliberate, and it
follows from what prick is: **self-hosted**. What matters is that a reader's own
`wrangler deploy` works, not that this repository keeps an instance running. An
automatic production deploy would gate every merge on Cloudflare credentials the
project does not need, and would make a red X on `main` mean "the maintainer's
instance is unhappy" rather than "the code is broken".

Preview is dispatch-only for a second, sharper reason: doing it on pull requests
safely would mean `pull_request_target`, which runs with full access to secrets
while checking out attacker-controlled code. There is no version of that which is
safe here, so the feature is absent rather than guarded. A dispatched preview uses
the commit SHA as its alias, which is the only identifier a manual run has.

| Job          | Runs when                        | Does                                                     |
| ------------ | -------------------------------- | -------------------------------------------------------- |
| `guard`      | Always, and blocks the other two | Asserts `workers_dev: false` and `preview_urls: false`   |
| `preview`    | `environment == 'preview'`       | Migrations, then `versions upload --preview-alias sha-…` |
| `production` | `environment == 'production'`    | Migrations, then `wrangler deploy`                       |

The **guard** needs no secrets. A hostname Access is not attached to is a complete
bypass of the authentication model, so it is checked mechanically before anything
reaches Cloudflare — and because it is the part worth running on every change, CI
runs it independently, with no secrets and no dispatch.

Migrations run **before** the deploy in both jobs, which is what makes "old code,
new schema" the only state that exists in the window between the two steps. That
is also why the migration policy is expand/contract only. A preview version shares
the production database, so the ordering matters there too.

Deploys serialise per environment and are **never cancelled**: interrupting one
between `d1 migrations apply` and `deploy` leaves the schema ahead of the code.

Toolchain caching is disabled entirely in the deploy workflow, in **both**
directions. Disabling only the save would still let a lower-privilege workflow
write a poisoned entry that this privileged job restores and publishes. A cold
install costs about 30 seconds; deploys are not a hot path.

## Next

- [Development](/contributing/development)
- [Testing](/contributing/testing)
