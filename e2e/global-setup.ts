/**
 * Cold start, every run.
 *
 * Nothing about this suite assumes prepared state. It builds the Worker, makes
 * a keypair and a certificate, starts a mock Access origin, writes a Wrangler
 * configuration derived from the real one, creates an empty D1, migrates it,
 * seeds it, boots `wrangler dev`, mints a token per role, PROVES each token is
 * accepted, and only then lets a spec run.
 *
 * ---------------------------------------------------------------------------
 * THE HARD PART, AND HOW IT IS SOLVED
 * ---------------------------------------------------------------------------
 * There is no Cloudflare Access in front of `wrangler dev`, and the application
 * has no bypass -- correctly, because a "skip verification locally" flag is a
 * code path in the shipped Worker whose purpose is to accept an unverified
 * identity.
 *
 * So the harness supplies the real thing. `ACCESS_CERTS_URL` is configuration
 * (that is its whole reason for existing), so:
 *
 *   1. generate a genuine RS256 keypair;
 *   2. serve its public half as a real JWKS from a real HTTPS origin;
 *   3. point `ACCESS_CERTS_URL` at that origin;
 *   4. make `workerd` trust the origin's certificate, and nothing else, by
 *      setting `SSL_CERT_FILE` on the `wrangler dev` child;
 *   5. mint genuine Access-shaped JWTs with the private half.
 *
 * `verifyAccessJwt` then runs completely unmodified: it fetches the JWKS over
 * the network, selects the key by `kid`, pins the algorithm from the JWKS entry
 * rather than the token header, checks the signature and asserts every claim.
 * The suite authenticates because the verifier works, not because it was told
 * to stand aside.
 *
 * Step 4 is the only platform-dependent piece. BoringSSL honours `SSL_CERT_FILE`
 * as an override for the default verify paths, and `workerd` builds its outbound
 * TLS trust from those; the assertion at the end of this file fails loudly if
 * that ever stops being true, naming the JWKS hit count, rather than presenting
 * as forty unexplained 401s.
 */

import type { FullConfig } from "@playwright/test";
import { writeFile } from "node:fs/promises";

import { generateAccessKey, mintServiceToken, mintUserToken } from "./harness/access";
import { ApiClient, environmentPath, type Whoami } from "./harness/api";
import { assertUsable, createSelfSignedCertificate } from "./harness/certificate";
import {
  MASTER_KEY,
  ROLES,
  SEED,
  SEEDED_SECRETS,
  STAGING_SECRETS,
  SUBJECTS,
  TOKEN_EMAILS,
  ASSERTION_COOKIE,
  type Role,
} from "./harness/constants";
import { writeHandoff, type Handoff } from "./harness/handoff";
import { startJwksOrigin } from "./harness/jwks-origin";
import { PATHS, storageStatePath } from "./harness/paths";
import {
  applyMigrations,
  applySeed,
  buildWorker,
  findFreePort,
  killTree,
  resetWorkDirectory,
  startDevServer,
} from "./harness/processes";
import { buildDevVars, buildWorkerConfig } from "./harness/worker-config";

function note(message: string): void {
  process.stdout.write(`[e2e] ${message}\n`);
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const started = Date.now();

  await resetWorkDirectory();

  /*
   * The build is not optional.
   *
   * `wrangler dev` serves `.svelte-kit/cloudflare`, so a suite that reused
   * whatever was on disk would be testing an arbitrary previous commit. The
   * escape hatch exists for the inner loop only, and is named so that its use
   * is visible in a failure report.
   */
  if (process.env["PRICK_E2E_SKIP_BUILD"] === "1") {
    note("skipping the build (PRICK_E2E_SKIP_BUILD=1) — this is not a cold start");
  } else {
    note("building packages/app …");
    await buildWorker();
  }

  // --- The mock Access origin ---------------------------------------------
  const certificate = createSelfSignedCertificate();
  await assertUsable(certificate);
  await writeFile(PATHS.certificate, certificate.certificatePem, "utf8");
  await writeFile(PATHS.certificateKey, certificate.privateKeyPem, "utf8");

  const accessKey = await generateAccessKey();
  const jwks = await startJwksOrigin(certificate, accessKey.jwksDocument);
  note(`mock Access JWKS at ${jwks.certsUrl}`);

  // --- Worker configuration, derived from the deployed one -----------------
  await writeFile(PATHS.workerConfig, await buildWorkerConfig({ certsUrl: jwks.certsUrl }), "utf8");
  await writeFile(PATHS.devVars, buildDevVars(MASTER_KEY), "utf8");

  // --- An empty D1, migrated and seeded, BEFORE anything opens it ----------
  note("applying migrations …");
  await applyMigrations();
  note("applying e2e/seed.sql …");
  await applySeed();

  // --- The Worker ----------------------------------------------------------
  const port = await findFreePort();
  note(`starting wrangler dev on port ${String(port)} …`);
  const { server, child } = await startDevServer({
    port,
    certificatePath: PATHS.certificate,
  });

  const teardown = async (): Promise<void> => {
    await killTree(server.pid);
    child.kill();
    await jwks.close();
  };

  try {
    // --- Tokens, one per role ---------------------------------------------
    const tokens = {} as Record<Role, string>;
    const storageState = {} as Record<Role, string>;

    for (const role of ROLES) {
      tokens[role] =
        role === "service"
          ? await mintServiceToken(accessKey, SUBJECTS.service)
          : await mintUserToken(accessKey, TOKEN_EMAILS[role]);

      /*
       * Storage state, so `test.use({ storageState })` selects a role.
       *
       * The cookie is what a browser presents; the header is what the API
       * client and the CLI present. Both paths reach the same verifier, and
       * both are exercised -- the browser specs through this file, the API
       * specs through `ApiClient`.
       *
       * `httpOnly` and `sameSite: Lax` mirror what Access actually sets, and
       * `secure` is false because the dev server is plain HTTP; a `secure`
       * cookie would simply never be sent and every browser spec would 401.
       */
      const path = storageStatePath(role);
      await writeFile(
        path,
        `${JSON.stringify(
          {
            cookies: [
              {
                name: ASSERTION_COOKIE,
                value: tokens[role],
                domain: "127.0.0.1",
                path: "/",
                expires: Math.floor(Date.now() / 1000) + 3600,
                httpOnly: true,
                secure: false,
                sameSite: "Lax",
              },
            ],
            origins: [],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      storageState[role] = path;
    }

    // --- PROVE the tokens are accepted, before a single spec runs ----------
    for (const role of ROLES) {
      const client = new ApiClient(server.baseUrl, tokens[role]);
      const whoami = await verifyRole(client, role);

      if (whoami.subject !== SUBJECTS[role]) {
        throw new Error(
          `The ${role} token authenticated as "${whoami.subject}", expected "${SUBJECTS[role]}".`,
        );
      }
    }

    if (jwks.hits() === 0) {
      throw new Error(
        "Four tokens verified without the mock Access origin being fetched once. " +
          "That cannot happen if the real verifier is running, so something is stubbing it out.",
      );
    }
    note(`Access verified end to end (${String(jwks.hits())} JWKS fetch(es))`);

    // --- Readable secrets, written through the API so they are real --------
    const admin = new ApiClient(server.baseUrl, tokens.admin);

    await admin.request(`${environmentPath(SEED.project, SEED.production)}/secrets:batch`, {
      method: "POST",
      body: { mode: "merge", set: SEEDED_SECRETS, reason: "e2e fixture" },
    });
    await admin.request(`${environmentPath(SEED.project, SEED.staging)}/secrets:batch`, {
      method: "POST",
      body: { mode: "merge", set: STAGING_SECRETS, reason: "e2e fixture" },
    });

    const handoff: Handoff = {
      baseUrl: server.baseUrl,
      tokens,
      storageState,
      certsUrl: jwks.certsUrl,
    };
    writeHandoff(handoff);

    note(`ready in ${String(Math.round((Date.now() - started) / 1000))}s — ${server.baseUrl}`);
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;
}

/**
 * `/whoami` as one role, retrying only what the application itself calls
 * transient.
 *
 * The very first authenticated request of a run is also the first time
 * `jwks.ts` reaches the mock Access origin, and it does so from a `workerd` that
 * started a few hundred milliseconds ago. On a loaded machine that connection
 * can lose the race, and with no cached key set to fall back on the verifier
 * answers 503 `IDENTITY_PROVIDER_UNAVAILABLE` -- which is the correct answer,
 * and which the CLI would retry.
 *
 * So this retries the same thing, and ONLY that: a 401 is not retried, because
 * a token that failed verification will fail it again and hiding that behind
 * three attempts would turn a broken harness into a slow one.
 */
async function verifyRole(client: ApiClient, role: Role): Promise<Whoami> {
  const attempts = 5;

  for (let attempt = 1; ; attempt += 1) {
    const response = await client.raw("/whoami");

    if (response.status === 200) return response.body as Whoami;

    const code = (response.body as { code?: string } | undefined)?.code;
    const transient = response.status === 503 && code === "IDENTITY_PROVIDER_UNAVAILABLE";

    if (!transient || attempt === attempts) {
      throw new Error(
        `The ${role} token was refused with ${String(response.status)} ${code ?? "?"} after ` +
          `${String(attempt)} attempt(s): ${response.text.slice(0, 300)}`,
      );
    }

    note(
      `the ${role} token got a transient ${code}; retrying (${String(attempt)}/${String(attempts)})`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
}
