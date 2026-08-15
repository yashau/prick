/**
 * Every API path this server knows, in one file.
 *
 * ------------------------------------------------------------------------
 * ASSUMED SURFACE -- READ THIS BEFORE DEBUGGING A 404
 * ------------------------------------------------------------------------
 * At the time this package was written the Worker's Hono router mounted
 * `/api/v1` and served exactly one route on it: `GET /api/v1/health`. The route
 * set below is therefore built against the DOCUMENTED surface (projects,
 * environments, secrets with `:batch`, the slug aliases `/p/:slug/e/:slug/...`
 * for client ergonomics, exact match only) rather than against code that
 * exists.
 *
 * They are centralised here, as pure functions with no logic in them, so that
 * reconciling this package with the router that eventually lands is a diff to
 * ONE file with no behaviour in it -- not a search across five handlers.
 *
 * Percent-encoding is applied to every interpolated segment without exception.
 * A slug is constrained to `[a-z0-9-]` and a secret key to a POSIX name, so
 * neither can currently contain a character that needs escaping; encoding them
 * anyway means that stops being a thing this file depends on. (The upstream
 * project this one replaces interpolated path segments raw, and that is the
 * shape of bug that only shows up once a validator is relaxed.)
 */

const enc = encodeURIComponent;

export const API_PREFIX = "/api/v1";

export const routes = {
  /** `GET` -> the projects visible to the caller. */
  projects: (): string => `${API_PREFIX}/projects`,

  /** `GET` -> the environments of one project. */
  environments: (project: string): string => `${API_PREFIX}/projects/${enc(project)}/environments`,

  /** `GET` -> key names and metadata. Never values. */
  secrets: (project: string, environment: string): string =>
    `${API_PREFIX}/p/${enc(project)}/e/${enc(environment)}/secrets`,

  /**
   * `POST` -> one atomic mutation of an environment's secrets.
   *
   * The custom-method spelling (`:batch`) is the documented one. The whole body
   * is applied in a single D1 `batch()`, audit row included, so a partial write
   * is not a state this endpoint can produce.
   */
  secretsBatch: (project: string, environment: string): string =>
    `${API_PREFIX}/p/${enc(project)}/e/${enc(environment)}/secrets:batch`,

  /** `GET` -> ONE decrypted value. Audited server-side with the given reason. */
  secretReveal: (project: string, environment: string, key: string): string =>
    `${API_PREFIX}/p/${enc(project)}/e/${enc(environment)}/secrets/${enc(key)}`,
} as const;
