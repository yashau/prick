/**
 * A signed-in, populated copy of the application, on demand.
 *
 * `mise run demo`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS NOT `mise run dev`
 * ---------------------------------------------------------------------------
 * `mise run dev` serves the application, and every request to it answers 401.
 * That is correct and deliberate: there is no Cloudflare Access in front of a
 * local server, and the Worker has no bypass, because a "skip verification
 * locally" flag would be a code path in the SHIPPED Worker whose entire purpose
 * is to accept an unverified identity. The application should not grow one.
 *
 * So this does what the e2e suite does, which is supply the real thing rather
 * than disable the check. `globalSetup` generates a genuine RS256 keypair,
 * serves its public half as a real JWKS from a real HTTPS origin, points
 * `ACCESS_CERTS_URL` at that origin, makes `workerd` trust its certificate, and
 * mints genuine Access-shaped JWTs. `verifyAccessJwt` then runs completely
 * unmodified. Nothing here weakens the application; the browser is simply
 * carrying a credential the Worker really does verify.
 *
 * The proxy below stands exactly where Access would, attaching the assertion to
 * each request, so a browser needs no cookie surgery to reach the UI.
 *
 * Everything is throwaway: a keypair made at startup, a D1 created at startup,
 * and tokens valid only against this process. It listens on loopback only.
 *
 * ---------------------------------------------------------------------------
 * The data is FAKE. Every value below is invented. Nothing here is a
 * credential, and nothing here should ever be pointed at a real server.
 *
 * Keep the values SHAPELESS. An invented value that still matches a provider's
 * pattern -- `sk_live_…`, `ghp_…`, `AKIA…` -- is indistinguishable from a real
 * leak to a scanner, and GitHub push protection rejected this file on exactly
 * that, correctly. Demo values name the provider in prose instead.
 * ---------------------------------------------------------------------------
 */

import { createServer, type IncomingMessage } from "node:http";

import globalSetup from "./global-setup";
import { readHandoff } from "./harness/handoff";
import type { Role } from "./harness/constants";

const PORT = Number(process.env["PRICK_DEMO_PORT"] ?? 7788);
const ROLE = (process.env["PRICK_DEMO_ROLE"] ?? "admin") as Role;

/**
 * Projects the demo shows. Environments deliberately differ from one another so
 * that a comparison between two of them has something to find.
 */
const PROJECTS = [
  {
    name: "Billing",
    slug: "billing",
    environments: [
      {
        slug: "production",
        name: "Production",
        reason: "initial import from the repo",
        secrets: {
          STRIPE_SECRET_KEY: "demo-stripe-live-4b1c8e2f9a7d0356",
          STRIPE_WEBHOOK_SECRET: "demo-stripe-webhook-9f3c1d7a4b2e",
          DATABASE_URL: "postgres://billing:hunter2@db.internal:5432/billing",
          SENTRY_DSN: "https://a1b2c3d4@o42.ingest.sentry.io/1337",
        },
        descriptions: {
          STRIPE_SECRET_KEY: "Live mode, rotates quarterly",
          DATABASE_URL: "Primary Postgres, read-write",
        },
      },
      {
        slug: "staging",
        name: "Staging",
        reason: "staging mirror",
        secrets: {
          STRIPE_SECRET_KEY: "demo-stripe-test-51a9c8d2e4f6b809",
          DATABASE_URL: "postgres://billing:hunter2@db.staging:5432/billing",
        },
      },
    ],
  },
  {
    name: "Web frontend",
    slug: "web",
    environments: [
      {
        slug: "production",
        name: "Production",
        reason: "initial import from the repo",
        secrets: {
          SESSION_SECRET: "f2a8c19d4e6b70351a9c8d2e4f6b8091",
          NEXTAUTH_SECRET: "7d1e93b5c0a24f68b1d3e5a7c9f02468",
          ANALYTICS_WRITE_KEY: "aw_5f8d2c1b9e3a7460",
        },
        descriptions: { SESSION_SECRET: "Rotating this logs everyone out" },
      },
      {
        slug: "preview",
        name: "Preview",
        reason: "preview environment",
        secrets: { SESSION_SECRET: "0a1b2c3d4e5f60718293a4b5c6d7e8f9" },
      },
    ],
  },
  {
    name: "Data pipeline",
    slug: "pipeline",
    environments: [
      {
        slug: "production",
        name: "Production",
        reason: "migrated off a .env file",
        secrets: {
          SNOWFLAKE_PASSWORD: "Sn0wPipe-demo-only",
          S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          S3_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          KAFKA_SASL_PASSWORD: "kafka-demo-8f2c19",
          AIRFLOW__CORE__FERNET_KEY: "zP4kQ9mR2tV7wY0aC3eF6hJ8lN1pS5uX",
        },
        descriptions: { S3_SECRET_ACCESS_KEY: "Scoped to the ingest bucket only" },
      },
    ],
  },
] as const;

/** Rotations applied after the initial import, so a history screen has versions. */
const ROTATIONS = ["demo-stripe-live-rotated-once-4b1c8e", "demo-stripe-live-rotated-twice-9d2f70"];

async function seed(baseUrl: string, token: string): Promise<void> {
  const call = async (path: string, init: RequestInit = {}): Promise<boolean> => {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      ...init,
      headers: {
        "Cf-Access-Jwt-Assertion": token,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      // A conflict means a previous run already created it, which is fine.
      if (response.status !== 409) {
        console.warn(`  ! ${String(response.status)} ${path}`);
      }
      return false;
    }
    return true;
  };

  for (const project of PROJECTS) {
    await call("/projects", {
      method: "POST",
      body: JSON.stringify({ name: project.name, slug: project.slug }),
    });

    for (const environment of project.environments) {
      await call(`/projects/${project.slug}/environments`, {
        method: "POST",
        body: JSON.stringify({ name: environment.name, slug: environment.slug }),
      });

      // Writes go through `secrets:batch`; there is no per-key PUT. The whole
      // set lands as one transaction with its audit row inside it.
      await call(`/projects/${project.slug}/environments/${environment.slug}/secrets:batch`, {
        method: "POST",
        body: JSON.stringify({
          mode: "merge",
          set: environment.secrets,
          ...("descriptions" in environment ? { descriptions: environment.descriptions } : {}),
          reason: environment.reason,
        }),
      });
    }

    console.log(`  ${project.slug}: ${String(project.environments.length)} environments`);
  }

  for (const value of ROTATIONS) {
    await call("/projects/billing/environments/production/secrets:batch", {
      method: "POST",
      body: JSON.stringify({
        mode: "merge",
        set: { STRIPE_SECRET_KEY: value },
        reason: "quarterly rotation",
      }),
    });
  }

  // One reveal and one export, so the audit log shows read reasons and not only
  // writes -- distinguishing "someone looked at it" from "someone took it" is
  // the point of recording them separately.
  await fetch(
    `${baseUrl}/api/v1/projects/billing/environments/production/secrets/DATABASE_URL?reveal=true`,
    { headers: { "Cf-Access-Jwt-Assertion": token } },
  );
  await fetch(
    `${baseUrl}/api/v1/projects/pipeline/environments/production/secrets:export?format=env`,
    { headers: { "Cf-Access-Jwt-Assertion": token } },
  );

  console.log("  audit: one reveal, one export");
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function startProxy(target: string, token: string): void {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        // The destination is pinned to `target`, never taken from the request.
        //
        // HTTP allows an absolute-form request target -- `GET http://elsewhere/
        // HTTP/1.1` -- which Node surfaces verbatim as `request.url`, and which
        // `new URL(url, base)` would honour OVER the base. This process attaches
        // a valid Access assertion to everything it forwards, so that would hand
        // the token to a host the caller chose. Take the path and query only.
        const requested = new URL(request.url ?? "/", "http://request.invalid");
        const url = new URL(`${requested.pathname}${requested.search}`, target);

        const headers = { ...request.headers } as Record<string, string>;
        delete headers["host"];
        // fetch decodes the response, so re-advertising an encoding would lie.
        delete headers["accept-encoding"];
        headers["cf-access-jwt-assertion"] = token;

        const method = request.method ?? "GET";
        const upstream = await fetch(url, {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : await readBody(request),
          redirect: "manual",
        });

        const out = Object.fromEntries(upstream.headers);
        delete out["content-encoding"];
        delete out["content-length"];

        response.writeHead(upstream.status, out);
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end(`proxy error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    })();
  });

  // Loopback only. This attaches a valid identity to every request it receives,
  // so it must not be reachable from anywhere but this machine.
  server.listen(PORT, "127.0.0.1");
}

const teardown = await globalSetup({} as never);
const handoff = readHandoff();
const token = handoff.tokens[ROLE];

console.log("seeding …");
await seed(handoff.baseUrl, handoff.tokens.admin);

startProxy(handoff.baseUrl, token);

console.log("");
console.log(`  prick is at  http://127.0.0.1:${String(PORT)}`);
console.log(`  signed in as ${ROLE}`);
console.log("");
console.log("  PRICK_DEMO_ROLE=reader|writer|admin changes who you are.");
console.log("  Ctrl-C stops it and deletes the database.");
console.log("");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void teardown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
