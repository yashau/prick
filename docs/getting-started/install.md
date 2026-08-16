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

## From a release tarball

Download the archive for your platform from the
[releases page](https://github.com/yashau/prick/releases), unpack it, and move
the binary onto your `PATH`:

```bash
tar xzf prk-x86_64-unknown-linux-gnu.tar.gz
```

```bash
sudo mv prk /usr/local/bin/prk
```

```bash
prk version
```

```
prk 2026.816.1
```

## Build from source

This is the route that works today.

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
ok   api            /api/v1/health answered, version 2026.816.1
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

One file, holding the session `prk login` created:

| Platform | Path                                           |
| -------- | ---------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/prick`, or `~/.config/prick` |
| macOS    | `~/Library/Application Support/prick`          |
| Windows  | `%APPDATA%\prick`                              |

It is called `credentials.json`, and it is created owner-only — mode `0600` in a
directory at `0700`, or on Windows a DACL with a single entry for you.

Set `PRK_CONFIG_DIR` to move it, which is how you keep sessions for two servers
apart:

```bash
PRK_CONFIG_DIR=~/.config/prick-staging prk login https://staging.prick.example.com
```

## Upgrading

```bash
npm update -g @yashau/prick
```

Or replace the binary. A client and a server on different versions is normal and
supported — the API is versioned at `/api/v1`, and `prk doctor` reports both.

## Uninstalling

```bash
prk logout
```

```bash
sudo rm /usr/local/bin/prk
```

`prk logout` discards the stored session first, so removing the binary does not
leave a credential file behind.

## Next steps

- [Quickstart](/getting-started/quickstart) — deploy the server this connects to.
- [Authentication](/guides/authentication) — service tokens and CI.
- [CLI reference](/reference/cli/)
