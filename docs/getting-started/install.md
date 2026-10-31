---
title: Install the CLI
description: Get the prk binary onto your machine, set up completions, and confirm it works.
sidebar:
  order: 3
---

`prk` is one static binary. Put it on your `PATH` and it works.

## From npm

```bash
npm install -g @yashau/prick
```

The package ships prebuilt binaries and picks the right one for your platform.

:::note[The npm shim costs you 30–40 ms per call]
Installing through npm routes every invocation through Node, and keeps a Node
parent alive for the child's lifetime during `prk run`. `prk doctor` tells you
when it detects this:

```
warn installation   running through the npm shim, which adds a Node process to every invocation; a direct install (cargo binstall, Homebrew, Scoop, or a release tarball) avoids it
```

It works fine. If you use `prk run` heavily, a direct install avoids it.
:::

## With mise

If you already use [mise](https://mise.jdx.dev) — which this repository does for
every tool it pins — let it own the install:

```bash
mise use -g npm:@yashau/prick
```

This is the same package through the same registry; what changes is who puts it
on your `PATH`.

npm's global prefix lives **inside the active Node's install directory**. Under
mise that is a version-stamped path, so a plain `npm install -g` puts `prk`
somewhere that is on your `PATH` only while mise is activated — and that stops
being the same directory the day mise bumps Node. The install does not break; it
becomes invisible, and `npm ls -g` comes back empty because it is reading a
different prefix.

mise's npm backend writes a `prk` shim into the shims directory that is already
on your `PATH`, and keeps it there across Node upgrades.

Pin a version the same way:

```bash
mise use -g npm:@yashau/prick@2026.819.0
```

The npm shim note above still applies: this is the npm package, so `prk doctor`
reports the Node hop. For `prk run` in a hot loop, use one of the direct installs
below.

## With Homebrew

```bash
brew install yashau/prick/prk
```

The tap holds one formula, generated from the same checksums the release page is
attested against. It covers macOS on Apple silicon and Intel, and Linux on x86-64
and arm64, and it installs the shell completions for you.

## With Scoop

```powershell
scoop bucket add prick https://github.com/yashau/scoop-bucket
```

```powershell
scoop install prick/prk
```

Both x64 and arm64 Windows are in the manifest, and `scoop update prk` follows
new releases on its own.

## With WinGet

```powershell
winget install yashau.prick
```

## With cargo

```bash
cargo binstall prk
```

`cargo binstall` downloads the same archive the release page serves, so this is
the compiled, attested binary rather than a local rebuild of it. Without
`cargo-binstall` installed, the source build is:

```bash
cargo install prk
```

That compiles `prk` and its four library crates from crates.io, which takes a few
minutes and needs a Rust toolchain.

## From a release tarball

Download the archive for your platform from the
[releases page](https://github.com/yashau/prick/releases), unpack it, and move
the binary onto your `PATH`:

```bash
tar xzf prk-<version>-x86_64-unknown-linux-gnu.tar.gz
```

```bash
sudo mv prk-<version>-x86_64-unknown-linux-gnu/prk /usr/local/bin/prk
```

The Windows assets are `.zip` rather than `.tar.gz` — unpack one and put
`prk.exe` in a directory that is already on `PATH`.

```bash
prk version
```

```
prk 2026.819.0
```

## Build from source

You need [mise](https://mise.jdx.dev), which pins Rust, Node, pnpm and every
other tool this repository uses. Install **only** mise — a system-wide install
of any pinned tool shadows the pinned version.

```bash
git clone https://github.com/yashau/prick && cd prick
```

```bash
mise trust && mise run bootstrap
```

```bash
mise run build:rust
```

The binary lands at `target/release/prk`. Put it somewhere on your `PATH`:

```bash
sudo install -m 755 target/release/prk /usr/local/bin/prk
```

On Windows the binary is `target\release\prk.exe`; copy it into a directory that
is already on `PATH`.

An in-repository build reports `0.0.0-dev` rather than a real version — the git
tag is the source of truth, and a release stamps it in at build time.

## Confirm it works

```bash
prk version
```

```
prk 0.0.0-dev
```

Then point it at your server:

```bash
prk login https://prick.example.com
```

```bash
prk doctor
```

```
ok   server url     https://prick.example.com (from the stored login)
ok   token storage  /home/you/.config/prick/credentials.json is owner-only
ok   api            /api/v1/health answered, version 0.0.0-dev
ok   access         Cloudflare Access with managed OAuth is in front of this server
ok   identity       you@example.com (user)
ok   installation   running as a native binary
```

If any line reads `FAIL`, [Exit codes and errors](/reference/cli/errors) covers
what each one means.

## Shell completions

```bash
prk completions bash > ~/.local/share/bash-completion/completions/prk
```

```bash
prk completions zsh > "${fpath[1]}/_prk"
```

```bash
prk completions fish > ~/.config/fish/completions/prk.fish
```

```bash
prk completions powershell >> $PROFILE
```

See [`prk completions`](/reference/cli/completions) for every supported shell.

## Where prk keeps its files

Everything lives in one directory:

| Platform | Path                                           |
| -------- | ---------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/prick`, or `~/.config/prick` |
| macOS    | `~/Library/Application Support/prick`          |
| Windows  | `%LOCALAPPDATA%\prick`                         |

| File                    | Holds                                                                       |
| ----------------------- | --------------------------------------------------------------------------- |
| `credentials.json`      | The session of your first profile, created by your first `prk login`        |
| `credentials/<id>.json` | The session of each further profile, one file per profile                   |
| `config.toml`           | The profiles: each one's server, pinned instance and defaults. Safe to read |

`config.toml` appears the first time there is something to record beyond a
single sign-in: a second server, a rename, or the instance id your server
reports. It is managed by `prk login` and `prk profile`, and a hand edit is
validated on the next run. [Multiple servers](/guides/multiple-servers)
covers what it holds.

Every credential file is created owner-only — mode `0600` in a directory at
`0700`, or on Windows a DACL with a single entry for you.

On Windows the session stays in the local half of your profile, which is never
copied to a file server by roaming profiles or folder redirection. A session
signed in under `%APPDATA%\prick` is moved there the first time `prk` reads it.

Set `PRK_CONFIG_DIR` to use another directory, for example to give a test run a
clean slate:

```bash
PRK_CONFIG_DIR=/tmp/prk-test prk profile list
```

## Updating

```bash
npm update -g @yashau/prick
```

Or replace the binary, through whichever channel you installed with. **Updating
keeps your sign-in and your server, and there is nothing to do afterwards.** An
install with a `credentials.json` and no `config.toml` is read as one profile,
`default`, for the server that session belongs to, and every command behaves as
it did. An older and a newer `prk` can be installed side by side and share the
same files.

A client and a server on different versions is normal and supported — the API
is versioned at `/api/v1`, and `prk doctor` reports both: the client's version,
and the version the Worker's `/health` reports (`0.0.0-dev` unless it was
deployed from a stamped `app-v` release).

## Uninstalling

```bash
prk logout --all
```

```bash
sudo rm /usr/local/bin/prk
```

`prk logout --all` revokes and discards the session of every profile first, so
removing the binary does not leave a credential file behind.

## Next steps

- [Quickstart](/getting-started/quickstart) — deploy the server this connects to.
- [Authentication](/guides/authentication) — service tokens and CI.
- [CLI reference](/reference/cli/)
