---
title: prk completions and prk version
description: Shell completion scripts, and reporting the version.
sidebar:
  order: 9
  label: completions and version
---

Two small commands: one sets up tab completion, the other reports which build
you are running.

## `prk completions`

```
prk completions <SHELL>
```

Writes a completion script to stdout.

| Shell      | Value        |
| ---------- | ------------ |
| Bash       | `bash`       |
| Zsh        | `zsh`        |
| Fish       | `fish`       |
| Elvish     | `elvish`     |
| PowerShell | `powershell` |

Run `prk completions --help` for the exact list your build accepts.

The script is generated from the same parser definition the binary uses, so
completion can only ever describe commands that exist.

### Bash

```bash
prk completions bash > /etc/bash_completion.d/prk
```

Without root, write it somewhere you own and source it from `~/.bashrc`:

```bash
prk completions bash > ~/.local/share/bash-completion/completions/prk
```

### Zsh

```bash
prk completions zsh > "${fpath[1]}/_prk"
```

Then start a new shell, or `compinit` again.

### Fish

```bash
prk completions fish > ~/.config/fish/completions/prk.fish
```

Fish picks it up on the next prompt.

### PowerShell

```bash
prk completions powershell >> $PROFILE
```

### Elvish

```bash
prk completions elvish > ~/.config/elvish/lib/prk.elv
```

## `prk version`

```
prk version
```

```bash
prk version
```

```
prk 2026.819.0
```

`prk --version` prints the same thing.

Versions are CalVer — `YYYY.MMDD.N`, where `N` counts releases within that day.

:::note[In-repository builds report `0.0.0-dev`]
Every manifest in the repository reads `0.0.0-dev`; the git tag is the source of
truth, and a release stamps the real version into every manifest immediately
before compiling. So the binary, the tag and every published package always
carry the same literal.

The consequence worth knowing: `git checkout <tag> && cargo build` reports
`0.0.0-dev` unless you stamp the version first.
:::

The server reports its own version independently:

```bash
prk doctor
```

```
ok   api            /api/v1/health answered, version 2026.819.0
```

A client and a server on different versions is normal and supported — the API is
versioned at `/api/v1`.

## Next steps

- [CLI overview](/reference/cli/) — global flags and the full command table.
- [Install the CLI](/getting-started/install)
