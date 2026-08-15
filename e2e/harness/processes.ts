/**
 * Building, seeding and running the Worker.
 *
 * ---------------------------------------------------------------------------
 * WHAT RUNS THE APPLICATION
 * ---------------------------------------------------------------------------
 * `wrangler dev` against the real build output -- the same `workerd` and the
 * same `miniflare`-backed D1 the unit suite uses, with the SvelteKit half
 * present, which the unit suite deliberately does without. So this suite is the
 * only place the Hono API, the admin UI, the assets runtime, `static/_headers`
 * and the SvelteKit CSP are all in the same process at once.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER MATTERS
 * ---------------------------------------------------------------------------
 * Migrations and the SQL seed run BEFORE `wrangler dev` starts. Two processes
 * writing one SQLite file is a race with no upside here: everything a spec
 * needs after boot it can create through the API, which is the path that
 * encrypts values properly and writes the audit rows.
 *
 * ---------------------------------------------------------------------------
 * WINDOWS
 * ---------------------------------------------------------------------------
 * Every child is `node <path-to-bin.js>` rather than the `.cmd` shim, because
 * `child_process.spawn` refuses `.cmd` without `shell: true` since the fix for
 * CVE-2024-24576 -- and `shell: true` on a path containing a space is its own
 * problem. Termination goes through `taskkill /T` because `wrangler dev` is a
 * Node process that spawns `workerd`, and killing only the parent leaves the
 * port held and the next run failing to bind.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";

import { APP_ROOT, PATHS, WORK_ROOT } from "./paths";

/** `node <script> <args…>`, inheriting a filtered environment. */
function runNode(
  script: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): ChildProcess {
  return spawn(process.execPath, [script, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function runToCompletion(
  label: string,
  script: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<string> {
  const child = runNode(script, args, options);

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const [code] = (await once(child, "close")) as [number | null];

  if (code !== 0) {
    throw new Error(`${label} exited with code ${String(code)}.\n\n${output.trim()}`);
  }

  return output;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * `vite build` in `packages/app`, producing `.svelte-kit/cloudflare`.
 *
 * Invoked directly rather than through `pnpm --filter`, so the suite does not
 * depend on a package manager being resolvable from wherever it was started.
 * The SvelteKit plugin runs `svelte-kit sync` itself during config resolution,
 * so there is no separate step.
 */
export async function buildWorker(): Promise<void> {
  try {
    await runToCompletion("vite build", PATHS.viteBin, ["build"], { cwd: APP_ROOT });
  } catch (error) {
    throw new Error(diagnoseBuildFailure(error), { cause: error });
  }
}

/**
 * Turn one specific, likely, and thoroughly confusing build failure into a
 * sentence.
 *
 * `@sveltejs/adapter-cloudflare` clears `.svelte-kit/cloudflare` before writing
 * to it, and on Windows that fails with `EPERM` while ANY process holds the
 * directory open. The process that holds it is almost always a `pnpm dev` or a
 * `wrangler dev` the developer left running in another terminal -- miniflare
 * opens the assets directory named in `wrangler.jsonc` and keeps it open.
 *
 * The raw failure is a rolldown stack trace with a `\\?\C:\…` path in it and no
 * indication that another process is involved at all, so it reads as a
 * corrupted checkout. This says what it is.
 */
function diagnoseBuildFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);

  if (!text.includes("EPERM") || !text.includes("cloudflare")) return text;

  return [
    "The build could not clear packages/app/.svelte-kit/cloudflare: another process is",
    "holding it open. That is almost always a `pnpm dev` or a `wrangler dev` running in",
    "another terminal -- miniflare keeps the assets directory named in wrangler.jsonc open",
    "for as long as it is serving.",
    "",
    "Stop it and run the suite again. PRICK_E2E_SKIP_BUILD=1 will reuse whatever is already",
    "built, which is fine for an inner loop and is NOT a cold start.",
    "",
    text,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

const wranglerArgs = (extra: string[]): string[] => [
  ...extra,
  "--config",
  PATHS.workerConfig,
  "--persist-to",
  PATHS.persist,
];

export async function applyMigrations(): Promise<void> {
  await runToCompletion(
    "wrangler d1 migrations apply",
    PATHS.wranglerBin,
    wranglerArgs(["d1", "migrations", "apply", "prick", "--local"]),
    { cwd: WORK_ROOT, env: { CI: "1" } },
  );
}

export async function applySeed(): Promise<void> {
  await runToCompletion(
    "wrangler d1 execute (seed)",
    PATHS.wranglerBin,
    wranglerArgs(["d1", "execute", "prick", "--local", "--file", PATHS.seedSql]),
    { cwd: WORK_ROOT, env: { CI: "1" } },
  );
}

// ---------------------------------------------------------------------------
// The dev server
// ---------------------------------------------------------------------------

export interface DevServer {
  baseUrl: string;
  pid: number;
}

/** An unused TCP port. Bound, read and released -- brief, and good enough. */
export async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a port for wrangler dev.");
  }

  const { port } = address;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  return port;
}

/**
 * Start `wrangler dev` and wait for it to answer `/api/v1/health`.
 *
 * `SSL_CERT_FILE` is the entire reason the Access harness works. `workerd`
 * builds its outbound TLS trust from the platform store, and BoringSSL honours
 * `SSL_CERT_FILE` as an override -- so pointing it at the harness certificate
 * makes exactly one certificate trusted for the lifetime of this process, which
 * is what lets `jwks.ts` fetch the mock JWKS over real HTTPS without the
 * verifier being relaxed to accept plaintext.
 *
 * It is scoped to this child. Nothing outside the run's `wrangler dev` has its
 * trust store altered, and the certificate expires in two days regardless.
 */
export async function startDevServer(options: {
  port: number;
  certificatePath: string;
}): Promise<{ server: DevServer; child: ChildProcess }> {
  const log = createWriteStream(PATHS.devLog, { flags: "a" });

  const child = runNode(
    PATHS.wranglerBin,
    wranglerArgs([
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(options.port),
      "--log-level",
      "info",
    ]),
    {
      cwd: WORK_ROOT,
      env: {
        SSL_CERT_FILE: options.certificatePath,
        // Wrangler prints a survey prompt and checks for updates otherwise,
        // neither of which belongs in a test run's first ten seconds.
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
      },
    },
  );

  child.stdout?.pipe(log);
  child.stderr?.pipe(log);

  const baseUrl = `http://127.0.0.1:${String(options.port)}`;

  let exited: { code: number | null } | null = null;
  child.once("exit", (code) => {
    exited = { code };
  });

  const deadline = Date.now() + 120_000;

  for (;;) {
    if (exited !== null) {
      throw new Error(
        `wrangler dev exited with code ${String(exited.code)} before it was ready. See ${PATHS.devLog}.`,
      );
    }

    if (Date.now() > deadline) {
      throw new Error(`wrangler dev did not answer ${baseUrl}/api/v1/health. See ${PATHS.devLog}.`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) break;
    } catch {
      // Not up yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { server: { baseUrl, pid: child.pid ?? 0 }, child };
}

/**
 * Kill a process and everything it spawned.
 *
 * `wrangler dev` is a Node process that runs `workerd` as a child. Killing only
 * the parent leaves `workerd` holding the port, and the next run fails to bind
 * with an error that names neither process.
 */
export async function killTree(pid: number): Promise<void> {
  if (pid <= 0) return;

  if (process.platform === "win32") {
    const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "close");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

/**
 * Delete and recreate the working directory. Cold start, every run.
 *
 * Retried, because Windows releases file handles LAZILY: `killTree` returns as
 * soon as `taskkill` has signalled `workerd`, and the SQLite files miniflare had
 * open under `state/` can stay locked for a moment after the process is gone.
 * The result is an `EBUSY` on a directory nothing is using any more.
 *
 * The retry is bounded and the final failure is re-raised with the path in it,
 * because a directory that is STILL locked after three seconds means a server
 * from an earlier run survived its teardown -- and silently reusing that state
 * would quietly turn a cold start into a warm one, which is precisely the thing
 * this function exists to prevent.
 */
export async function resetWorkDirectory(): Promise<void> {
  const attempts = 6;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(WORK_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      break;
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(
          `Could not clear ${WORK_ROOT} after ${String(attempts)} attempts. A wrangler dev ` +
            "from an earlier run is probably still holding it; stop it and try again.",
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  await mkdir(PATHS.storage, { recursive: true });
  await appendFile(PATHS.devLog, `# wrangler dev — ${new Date().toISOString()}\n`);
}
