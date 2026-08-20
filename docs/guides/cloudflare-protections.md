---
title: Cloudflare protections
description: Why Cloudflare's bot products challenge prk from servers and CI runners, and how to make an exception without giving up the protection you want.
sidebar:
  order: 9
---

Access is not the only Cloudflare product in front of your Worker. The bot and
WAF layers run **before** Access, and they can stop a request that carries a
perfectly good credential — or, more often, the unauthenticated probe `prk login`
starts with.

When that happens, `prk` says so rather than guessing:

```
error: Cloudflare intercepted this request with a `challenge` mitigation, so it never reached the server
```

That is read off the `cf-mitigated` response header. The status underneath is a
bare `403`, indistinguishable from Access refusing your identity, which is why
this has its own error code — [`MITIGATED`](/reference/cli/errors) — instead of
`FORBIDDEN`. A grant cannot fix it, and neither can a different token.

## Why it happens to servers and not to laptops

Bot scoring reacts to two things `prk` cannot avoid being: a datacenter IP range,
and a client that is not a browser. On a workstation on a residential or office
network, the same binary sails through. Move it to a VPS, a container, or a CI
runner and it starts looking exactly like the traffic these products exist to
stop.

So the places this bites are the places you deploy to:

- A server running `prk run` to launch an application.
- A CI runner. GitHub-hosted runners are datacenter IPs, so
  [GitHub Actions](/guides/using-secrets/github-actions) is squarely in range.
- A container on any cloud host.

## Confirming it is the edge and not you

`prk doctor` reports the mitigation, and a bare `curl` confirms it independently:

```bash
curl -sI https://prick.example.com/api/v1/health | grep -i cf-mitigated
```

```
cf-mitigated: challenge
```

If that header is present, nothing about your credential, your grant or your
`--api-url` is wrong. The request never arrived.

## The fix depends on which product is enabled

Check **Security → Settings**, filtered to bot traffic, before writing any rule.
The two products have the same name to within one word and behave completely
differently.

:::note[You do not need to buy anything to write a rule]
Zone-level custom rules are on every plan, Free included — five of them on Free,
twenty on Pro. The dashboard also offers an **account-level WAF** add-on, which
is a different product: it applies one ruleset across every domain in the
account and requires Enterprise. It is not what any of this needs. Work inside
the zone for the hostname, not at the account level.
:::

### Super Bot Fight Mode (Pro and above)

This one runs on the Ruleset Engine, and custom rules are evaluated before it, so
a rule with the **Skip** action works. In **Security → WAF → Custom rules**,
create a rule, set the action to _Skip_, and select Super Bot Fight Mode as what
to skip.

Match the hostname. prick owns the whole host, and every path on it is behind
Access:

```
http.host eq "prick.example.com"
```

Tighter still, when the client is a server with a fixed address:

```
ip.src eq 203.0.113.10 and http.host eq "prick.example.com"
```

Order matters. The skip has to sit above any rule that would challenge the same
request.

:::caution[A rule scoped to `/api` is not enough]
`prk login` does not start at `/api`. It fetches RFC 9728 discovery documents
first, and those live under `/.well-known/` — the resource path is **appended**
to the well-known prefix, so
`/.well-known/oauth-protected-resource/api/v1/health` contains `/api` without
starting with it. A rule matching `starts_with(http.request.uri.path, "/api")`
lets the health probe through and leaves every discovery probe challenged, which
fails the login somewhere less obvious than where it started.

If you must scope by path rather than by host, cover both:

```
http.host eq "prick.example.com" and (starts_with(http.request.uri.path, "/api") or starts_with(http.request.uri.path, "/.well-known/"))
```

:::

### Bot Fight Mode (free)

**It cannot be skipped.** Not with a custom rule, not with a page rule. Bot Fight
Mode does not run on the Ruleset Engine, so `Skip`, `Bypass` and `Allow` have no
effect on it — this surprises nearly everyone who tries the rule above first and
watches it do nothing.

The options are to turn it off for the zone in **Security → Settings**, or to
move to a plan with Super Bot Fight Mode and use the rule above.

:::caution[Turning it off is a zone-wide decision]
Bot Fight Mode is all-or-nothing per zone. If the same zone serves a public site
that benefits from it, weigh that before disabling — a dedicated hostname for
prick on its own zone keeps the two decisions separate.
:::

## Skip the bot layer, not the whole WAF

It is tempting to write one broad rule that skips everything for `/api` and move
on. Don't.

prick implements **no rate limiting of its own**. As the
[threat model](/architecture/threat-model) says, the `RATE_LIMITED` code exists
for a response Cloudflare's own protections may produce, not because the Worker
enforces a quota. Cloudflare's edge is the entire denial-of-service story for
this deployment. Skip the bot product that is challenging you and leave rate
limiting alone.

## Does an exception weaken the authorization model?

No. Access is the authorization boundary, and it still runs. The threat model is
explicit that a misconfigured Access application bypasses everything — which is
another way of saying the bot layer was never what stood between a caller and
your secrets. A skip rule scoped to an Access-protected hostname changes who is
challenged, not who is allowed.

What it does change is exposure to unauthenticated volume: requests that would
have been challenged now reach Access instead. Access rejects them, cheaply, but
they arrive. That is the trade, and it is a small one at the scope described
above.

## After the change

```bash
prk doctor
```

Then sign in normally:

```bash
prk login https://prick.example.com
```

On a headless server there is no browser to open. `prk` prints the URL and keeps
waiting, so paste it into a browser on your own machine and the login completes
over the loopback listener. A [service token](/guides/authentication) is usually
the better fit for anything unattended.

## Next steps

- [Exit codes and errors](/reference/cli/errors)
- [Authentication](/guides/authentication)
- [Using secrets in GitHub Actions](/guides/using-secrets/github-actions)
