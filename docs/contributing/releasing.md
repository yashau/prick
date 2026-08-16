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

## Deploying the application Worker

**This repository does not deploy it.** prick is self-hosted: the application
Worker runs in _your_ Cloudflare account, and you deploy it yourself.

```bash
pnpm install
pnpm --filter @prick/app exec wrangler d1 migrations apply prick --remote
pnpm --filter @prick/app exec wrangler deploy
```

No workflow here deploys it, deliberately. Nobody's installation is this
repository's to keep running, and wiring one up would gate every merge on
Cloudflare credentials the project has no other use for.

CI does assert one thing about your config on every push: that `workers_dev`
and `preview_urls` are both `false`. A hostname Cloudflare Access is not
attached to serves every secret in the installation to the open internet, so it
is worth checking mechanically. The check needs no secrets.

The **documentation** site is the one exception, and is released from here --
it is public, holds nothing, and has no reason to live in your account. See
`docs-release.yml`, triggered by a `docs-v*` tag.

## Next steps

- [Development](/contributing/development)
- [Testing](/contributing/testing)
