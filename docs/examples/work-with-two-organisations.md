---
title: Work with two organisations
description: Two client deployments of the same application, one checkout, and every write reaching the deployment you meant.
sidebar:
  order: 7
---

You build `storefront` for two clients, Acme and Globex. Each client has its
own prick deployment, `prick.acme.example` and `prick.globex.example`, and
both sit behind your agency's Access organisation,
`northwind.cloudflareaccess.com`. The project is called `storefront` on both,
both have `staging` and `production`, and both hold a `STRIPE_SECRET_KEY`.
You are an administrator on both.

Nothing in a request tells those two deployments apart, so a write meant for
Globex that reaches Acme succeeds. By the end of this page it cannot: every
write names its server, the repository refuses any deployment it does not
list, and a profile pointed at the wrong deployment is refused before anything
is sent.

[Multiple servers](/guides/multiple-servers) explains each mechanism; this page
is the sequence.

## Before you begin

- Both deployments running a release that reports an instance id.
  `prk whoami` prints an `instance:` line when it does.
- One checkout of the `storefront` repository.

## 1. Sign in to both

Name the profiles after the clients:

```bash
prk login --profile acme https://prick.acme.example
```

```
Signing in to https://prick.acme.example as profile `acme`
Signed in to https://prick.acme.example (profile acme)
```

```bash
prk login --profile globex https://prick.globex.example
```

```
Signing in to https://prick.globex.example as profile `globex`
Signed in to https://prick.globex.example (profile globex)
```

Each sign-in pins the profile to the instance id its server reports, and to
the Access issuer it signed in through.

```bash
prk profile list
```

```
* acme    prick.acme.example    instance 3f9c01ab  signed in
  globex  prick.globex.example  instance a71e09d4  signed in
```

The first profile became the default. The issuer is the same for both, so
here it is the instance that separates them.

## 2. Tell the repository which deployments it belongs to

From the root of the checkout, record each deployment's instance:

```bash
prk profile pin --profile acme
```

```
Pinned instance 3f9c01ab (prick.acme.example) in /home/you/src/storefront/.prick.toml.
```

```bash
prk profile pin --profile globex
```

```
Pinned instance a71e09d4 (prick.globex.example) in /home/you/src/storefront/.prick.toml.
```

Add the project, so nobody types `-P` again:

```toml title=".prick.toml"
project = "storefront"

[[allow]]
instance = "3f9c01ab52e84d7a9b0c6e1f2a3b4c5d"

[[allow]]
instance = "a71e09d4c3b2a1f0e9d8c7b6a5f4e3d2"
```

Commit it. It holds no URL and no credential, only the two instance ids, so
it means the same thing on every colleague's machine whatever they named their
profiles. Because it lists two deployments, it does not choose between them.

## 3. Read from either

A read uses the default when nothing else chooses, and that is still checked
against the allow list:

```bash
prk secrets list -E production
```

To read Globex's, name it:

```bash
prk --profile globex secrets list -E production
```

## 4. Try a write without naming the server

```bash
prk secrets set STRIPE_SECRET_KEY -E production
```

```
error: this command changes data, and 2 profiles are configured; name the server with --profile (the default, `acme`, is not used for writes)
  help: `prk profile list` shows the profiles; a project's .prick.toml can also choose one.
```

Exit 2, and nothing was sent. With two profiles, the default is not enough to
write: it is whichever profile you chose last, perhaps for other work.

## 5. Write to the one you mean

```bash
prk --profile globex secrets set STRIPE_SECRET_KEY -E production
```

```
writing to prick.globex.example (profile globex, instance a71e09d4)
Value for STRIPE_SECRET_KEY:
```

```
Updated `STRIPE_SECRET_KEY` (rev 12).
```

The first line is printed before the value is asked for. Read it.

## 6. Settle on one client for a while

When a stretch of work is all Globex, let the checkout say so instead of
every command. Write a `.prick.local.toml`, and keep it out of git:

```bash
echo .prick.local.toml >> .gitignore
```

```bash
prk profile pin --local --profile globex
```

```
Pinned instance a71e09d4 (prick.globex.example) in /home/you/src/storefront/.prick.local.toml.
```

```bash
prk profile show
```

```
globex (selected from /home/you/src/storefront/.prick.local.toml)
  server:   https://prick.globex.example
  instance: a71e09d4c3b2a1f0e9d8c7b6a5f4e3d2
  access:   https://northwind.cloudflareaccess.com
  session:  signed in
```

Writes in this checkout now go to Globex without `--profile`, and the
destination line still names it on each one. `--profile acme` still works for
a one-off, and is still checked against the allow list. Delete the file to go
back to naming the profile.

`prk` refuses a `.prick.local.toml` that git would commit, because then it
would choose for everyone who clones the repository.

## 7. What the repository refuses

Later, you sign in to a personal deployment for experiments as `sandbox`. In
this checkout it is refused, because the repository does not list its
deployment:

```bash
prk --profile sandbox secrets list -E production
```

```
error: /home/you/src/storefront/.prick.toml does not allow instance 5b2d8e0f1a3c4b6d7e9f0a1b2c3d4e5f (prick.sandbox.example); nothing was sent
  help: Choose a profile for a deployment this project allows, or add the instance with `prk profile pin` if it belongs to the project.
```

Exit 3. The profile was pinned when you signed in, so this was decided without
a request.

## 8. What a repointed hostname looks like

Suppose Acme's hostname is moved to a fresh deployment, by mistake or by a
DNS change nobody told you about. The URL is the same, the Access organisation
is the same, and your credential is accepted. The instance id is not the same:

```bash
prk --profile acme secrets list -E production
```

```
error: prick.acme.example is a different deployment than profile `acme` is pinned to (expected instance 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d, it reports 77d0c41e9a8b4f2c8e1d6b3a5f7c9e0d); nothing was sent
  help: If this server was replaced on purpose, remove and re-add the profile: `prk profile remove <NAME>`, then `prk login <URL>`.
```

Exit 3. `prk` asked the server who it was before sending the command's own
request, so the server received nothing but the identity check. Find out why
before you remove and re-add the profile; a restored backup keeps its instance
id, so a restore does not do this.

## 9. Pin the deploy scripts

A deploy script for Acme should reach Acme whatever the profiles on the machine
are called. Pin it to the instance:

```bash
export PRK_EXPECT_INSTANCE=3f9c01ab52e84d7a9b0c6e1f2a3b4c5d
prk --profile acme run --no-input -E production -- ./deploy.sh
```

Pointed at Globex, the same script stops:

```bash
prk --profile globex --expect-instance 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d secrets list -E production
```

```
error: prick.globex.example reports instance a71e09d4c3b2a1f0e9d8c7b6a5f4e3d2, not the expected 3f9c01ab52e84d7a9b0c6e1f2a3b4c5d; nothing was sent
```

## What you have now

- Two profiles, each pinned to its own deployment's instance.
- A committed `.prick.toml` that lists both deployments and refuses any other.
- Writes that refuse to guess, and name their server on stderr when they run.
- Scripts that reach one deployment or nothing.

## Next steps

- [Multiple servers](/guides/multiple-servers) — every rule used above, and a
  troubleshooting entry for each refusal.
- [Give CI read-only access](/examples/ci-read-only) — one service token per
  deployment.
- [`prk profile`](/reference/cli/profile/)
